import { prisma } from "./db";
import { logger } from "@/lib/logger";
import { checkBidRateLimit } from "./rate-limiter";

type BidResult =
  | { success: true; bid: { id: string; amount: number; participantName: string } }
  | { success: false; reason: string; retryAfterMs?: number };

export async function placeBid(
  itemId: string,
  amount: number,
  participantId: string
): Promise<BidResult> {
  // Rate limit check first (cheapest check)
  const rateLimit = await checkBidRateLimit(participantId);
  if (!rateLimit.allowed) {
    return {
      success: false,
      reason: "Too many bids, slow down",
      retryAfterMs: rateLimit.retryAfterMs,
    };
  }

  // Fetch item and participant in parallel
  const [item, participant] = await Promise.all([
    prisma.item.findUnique({ where: { id: itemId } }),
    prisma.participant.findUnique({ where: { id: participantId } }),
  ]);

  if (!item) return { success: false, reason: "Item not found" };
  if (!participant) return { success: false, reason: "Participant not found" };
  if (participant.role !== "BIDDER")
    return { success: false, reason: "Only bidders can place bids" };
  if (item.status !== "ACTIVE")
    return { success: false, reason: "Item is not currently up for auction" };
  if (item.sessionId !== participant.sessionId)
    return { success: false, reason: "Participant not in this session" };

  // Validate amount
  const minRequired = item.currentBid ? item.currentBid + 1 : item.minBid;
  if (amount < minRequired)
    return { success: false, reason: `Bid must be at least $${minRequired}` };

  // Pre-check budget (non-atomic, but catches obvious cases early)
  if (participant.budget === null || amount > participant.budget)
    return { success: false, reason: "Insufficient budget" };

  // Atomic transaction: optimistic lock on item + budget guard on participant
  // This prevents both:
  // 1. Two different bidders racing on the same item (version check)
  // 2. Same bidder overspending via simultaneous bids (budget check)
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Re-read participant budget inside transaction for atomicity
      const freshParticipant = await tx.participant.findUnique({
        where: { id: participantId },
        select: { budget: true, name: true },
      });

      if (!freshParticipant || freshParticipant.budget === null || amount > freshParticipant.budget) {
        return { success: false as const, reason: "Insufficient budget" };
      }

      // Optimistic lock: only update if version matches and bid exceeds current
      const updated = await tx.item.updateMany({
        where: {
          id: itemId,
          version: item.version,
          status: "ACTIVE",
          OR: [
            { currentBid: null },
            { currentBid: { lt: amount } },
          ],
        },
        data: {
          currentBid: amount,
          version: { increment: 1 },
          winnerId: participantId,
        },
      });

      if (updated.count === 0) {
        return {
          success: false as const,
          reason: "Bid was outbid or item state changed",
        };
      }

      // Create bid record
      await tx.bid.create({
        data: { amount, itemId, participantId },
      });

      return {
        success: true as const,
        participantName: freshParticipant.name,
      };
    });

    if (!result.success) {
      return { success: false, reason: result.reason };
    }

    logger.info(
      { itemId, participantId, amount, previousBid: item.currentBid ?? 0 },
      "Bid placed"
    );

    return {
      success: true,
      bid: { id: itemId, amount, participantName: result.participantName },
    };
  } catch (err) {
    logger.error({ err, itemId, participantId }, "Bid failed");
    return { success: false, reason: "Failed to place bid" };
  }
}

export async function awardItem(itemId: string): Promise<{
  sold: boolean;
  winner?: string;
  amount?: number;
}> {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { winner: true },
  });

  if (!item) return { sold: false };

  if (item.winnerId && item.currentBid && item.winner) {
    // Atomic: mark item sold + deduct budget
    await prisma.$transaction([
      prisma.item.update({
        where: { id: itemId },
        data: { status: "SOLD" },
      }),
      prisma.participant.update({
        where: { id: item.winnerId },
        data: { budget: { decrement: item.currentBid } },
      }),
    ]);

    logger.info(
      { itemId, winner: item.winner.name, amount: item.currentBid },
      "Item sold"
    );

    return {
      sold: true,
      winner: item.winner.name,
      amount: item.currentBid,
    };
  }

  // No bids — mark unsold
  await prisma.item.update({
    where: { id: itemId },
    data: { status: "UNSOLD" },
  });

  logger.info({ itemId }, "Item unsold");
  return { sold: false };
}

export async function advanceToNextItem(sessionId: string): Promise<{
  item: {
    id: string;
    name: string;
    description: string | null;
    minBid: number;
    order: number;
  } | null;
  completed: boolean;
}> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { items: { orderBy: { order: "asc" } } },
  });

  if (!session) return { item: null, completed: true };

  const nextIdx = (session.currentItemIdx ?? -1) + 1;
  const nextItem = session.items[nextIdx];

  if (!nextItem) {
    // All items done
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: "COMPLETED", currentItemIdx: nextIdx },
    });
    return { item: null, completed: true };
  }

  // Activate next item
  await prisma.$transaction([
    prisma.session.update({
      where: { id: sessionId },
      data: { currentItemIdx: nextIdx },
    }),
    prisma.item.update({
      where: { id: nextItem.id },
      data: { status: "ACTIVE" },
    }),
  ]);

  return {
    item: {
      id: nextItem.id,
      name: nextItem.name,
      description: nextItem.description,
      minBid: nextItem.minBid,
      order: nextItem.order,
    },
    completed: false,
  };
}
