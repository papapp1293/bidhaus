import { prisma } from "./db";
import { logger } from "@/lib/logger";
import { checkBidRateLimit } from "./rate-limiter";
import { cacheSet, cacheInvalidate, CacheKeys } from "./cache";
import { ensureMinRemaining } from "./timer-service";

/**
 * Compute the per-bidder roster cap for "enforce even teams" mode:
 * ⌈totalItems / bidderCount⌉. Returns null if there are no bidders.
 */
async function computeTeamCap(sessionId: string): Promise<number | null> {
  const [itemCount, bidderCount] = await Promise.all([
    prisma.item.count({ where: { sessionId } }),
    prisma.participant.count({ where: { sessionId, role: "BIDDER" } }),
  ]);
  if (bidderCount === 0) return null;
  return Math.ceil(itemCount / bidderCount);
}

type BidResult =
  | {
      success: true;
      bid: { id: string; amount: number; participantName: string };
      timerExtended?: { endsAt: number; remainingMs: number };
    }
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

  // Fetch item (with session for cache invalidation + config) and participant in parallel
  const [item, participant] = await Promise.all([
    prisma.item.findUnique({
      where: { id: itemId },
      include: {
        session: {
          select: { code: true, resetTime: true, enforceEvenTeams: true },
        },
      },
    }),
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

  // Even-teams cap: reject if this bidder is already at the maximum
  if (item.session.enforceEvenTeams) {
    const cap = await computeTeamCap(item.sessionId);
    if (cap !== null) {
      const wonCount = await prisma.item.count({
        where: { sessionId: item.sessionId, winnerId: participantId, status: "SOLD" },
      });
      if (wonCount >= cap) {
        return { success: false, reason: `Team is full (${cap} items)` };
      }
    }
  }

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

      // Track that a bid happened this round (used for round-end auto-distribute logic)
      await tx.session.update({
        where: { id: item.sessionId },
        data: { bidsThisRound: { increment: 1 } },
      });

      return {
        success: true as const,
        participantName: freshParticipant.name,
      };
    });

    if (!result.success) {
      return { success: false, reason: result.reason };
    }

    // Invalidate caches: active item state + session (budget changed)
    await cacheInvalidate(
      CacheKeys.activeItem(item.sessionId),
      CacheKeys.session(item.session.code)
    );

    // Reset-time-on-bid: if remaining time is below the configured threshold,
    // extend the timer so bidders have a chance to react.
    let timerExtended: { endsAt: number; remainingMs: number } | undefined;
    if (item.session.resetTime > 0) {
      const minMs = item.session.resetTime * 1000;
      const ext = await ensureMinRemaining(item.sessionId, minMs);
      if (ext && ext.extended) {
        timerExtended = { endsAt: ext.endsAt, remainingMs: minMs };
      }
    }

    logger.info(
      { itemId, participantId, amount, previousBid: item.currentBid ?? 0 },
      "Bid placed"
    );

    return {
      success: true,
      bid: { id: itemId, amount, participantName: result.participantName },
      timerExtended,
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
    include: { winner: true, session: { select: { code: true } } },
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

    // Invalidate caches after award
    await cacheInvalidate(
      CacheKeys.activeItem(item.sessionId),
      CacheKeys.session(item.session.code)
    );

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

  // Invalidate caches after unsold
  await cacheInvalidate(
    CacheKeys.activeItem(item.sessionId),
    CacheKeys.session(item.session.code)
  );

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
  autoDistributed?: boolean;
  /** True when this call (or a recursive child) restarted a new round on UNSOLD items. */
  roundRestarted?: boolean;
}> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });

  if (!session) return { item: null, completed: true };

  // Find next PENDING item (any round) by order
  const nextItem = await prisma.item.findFirst({
    where: { sessionId, status: "PENDING" },
    orderBy: { order: "asc" },
  });

  if (!nextItem) {
    // No pending items left in this round. Check unsold to decide what to do.
    const unsold = await prisma.item.findMany({
      where: { sessionId, status: "UNSOLD" },
      orderBy: { order: "asc" },
    });

    if (unsold.length === 0) {
      // Everything sold — session complete
      await prisma.session.update({
        where: { id: sessionId },
        data: { status: "COMPLETED" },
      });
      await cacheInvalidate(
        CacheKeys.activeItem(sessionId),
        CacheKeys.session(session.code)
      );
      return { item: null, completed: true };
    }

    // Re-read session to get current bidsThisRound
    const fresh = await prisma.session.findUnique({ where: { id: sessionId } });
    const bidsThisRound = fresh?.bidsThisRound ?? 0;

    if (bidsThisRound === 0) {
      // A whole round elapsed with zero bids — auto-distribute remaining items
      await autoDistributeUnsoldItems(sessionId);
      await prisma.session.update({
        where: { id: sessionId },
        data: { status: "COMPLETED" },
      });
      await cacheInvalidate(
        CacheKeys.activeItem(sessionId),
        CacheKeys.session(session.code)
      );
      logger.info(
        { sessionId, distributed: unsold.length },
        "Auto-distributed remaining items after silent round"
      );
      return { item: null, completed: true, autoDistributed: true };
    }

    // Start a new round: reset UNSOLD → PENDING, reset round bid counter
    await prisma.$transaction([
      prisma.item.updateMany({
        where: { sessionId, status: "UNSOLD" },
        data: { status: "PENDING" },
      }),
      prisma.session.update({
        where: { id: sessionId },
        data: { bidsThisRound: 0, currentItemIdx: null },
      }),
    ]);
    await cacheInvalidate(CacheKeys.session(session.code));

    logger.info(
      { sessionId, unsoldCount: unsold.length },
      "Starting new round with unsold items"
    );

    // Recurse — now there are PENDING items again. Tag the result so
    // callers (socket handlers) can emit a `round:restarted` event to
    // clients so they don't silently see the same item reappear.
    const recurseResult = await advanceToNextItem(sessionId);
    return { ...recurseResult, roundRestarted: true };
  }

  // Even-teams short-circuit: if only one bidder is still under cap, no
  // auction is necessary — auto-award to them and recurse.
  if (session.enforceEvenTeams) {
    const cap = await computeTeamCap(sessionId);
    if (cap !== null) {
      const bidders = await prisma.participant.findMany({
        where: { sessionId, role: "BIDDER" },
        include: { wonItems: { select: { id: true } } },
        orderBy: { joinedAt: "asc" },
      });
      const eligible = bidders.filter((b) => b.wonItems.length < cap);
      if (eligible.length === 1) {
        const winner = eligible[0];
        await prisma.item.update({
          where: { id: nextItem.id },
          data: { status: "SOLD", winnerId: winner.id, currentBid: 0 },
        });
        await cacheInvalidate(
          CacheKeys.activeItem(sessionId),
          CacheKeys.session(session.code)
        );
        logger.info(
          { sessionId, itemId: nextItem.id, winnerId: winner.id },
          "Auto-awarded item: only one eligible bidder remains"
        );
        return advanceToNextItem(sessionId);
      }
    }
  }

  // Activate next item
  await prisma.$transaction([
    prisma.session.update({
      where: { id: sessionId },
      data: { currentItemIdx: nextItem.order },
    }),
    prisma.item.update({
      where: { id: nextItem.id },
      data: { status: "ACTIVE" },
    }),
  ]);

  // Cache the new active item
  await cacheInvalidate(CacheKeys.activeItem(sessionId));
  await cacheSet(
    CacheKeys.activeItem(sessionId),
    {
      id: nextItem.id,
      name: nextItem.name,
      description: nextItem.description,
      minBid: nextItem.minBid,
      order: nextItem.order,
      currentBid: null,
      winnerId: null,
    },
    session.timePerItem + 10 // TTL slightly longer than item duration
  );

  // Invalidate session cache (currentItemIdx changed)
  await cacheInvalidate(CacheKeys.session(session.code));

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

/**
 * Distribute all currently-UNSOLD items round-robin to bidders, giving each
 * bidder as even a count as possible. Items are awarded for $0 (free) and
 * the winning bidder's budget is NOT decremented. Used when an entire round
 * elapses with zero bids and we need to forcibly resolve the session.
 */
async function autoDistributeUnsoldItems(sessionId: string) {
  const unsold = await prisma.item.findMany({
    where: { sessionId, status: "UNSOLD" },
    orderBy: { order: "asc" },
  });

  if (unsold.length === 0) return;

  const bidders = await prisma.participant.findMany({
    where: { sessionId, role: "BIDDER" },
    include: { wonItems: { select: { id: true } } },
    orderBy: { joinedAt: "asc" },
  });

  if (bidders.length === 0) {
    // No bidders to distribute to — leave as UNSOLD
    return;
  }

  // Track running count per bidder so we always assign to the one with fewest
  const counts = bidders.map((b) => ({
    id: b.id,
    count: b.wonItems.length,
  }));

  for (const item of unsold) {
    counts.sort((a, b) => a.count - b.count);
    const winner = counts[0];
    await prisma.item.update({
      where: { id: item.id },
      data: {
        status: "SOLD",
        winnerId: winner.id,
        currentBid: 0,
      },
    });
    winner.count++;
  }
}
