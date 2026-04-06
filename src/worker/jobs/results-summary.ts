import type { Job } from "bullmq";
import type { ResultsSummaryJobData } from "@/server/queue";
import { prisma } from "@/server/db";
import { redis } from "@/server/redis";
import { logger } from "@/lib/logger";

const SUMMARY_KEY_PREFIX = "summary:session:";
const SUMMARY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export type SessionSummary = {
  sessionId: string;
  sessionName: string;
  hostName: string;
  totalItems: number;
  soldItems: number;
  unsoldItems: number;
  totalRevenue: number;
  rosters: {
    participantId: string;
    name: string;
    budgetStart: number;
    budgetRemaining: number;
    spent: number;
    items: { name: string; price: number }[];
  }[];
  bidStats: {
    totalBids: number;
    avgBidsPerItem: number;
    highestBid: { itemName: string; amount: number; bidderName: string } | null;
    mostContestedItem: { itemName: string; bidCount: number } | null;
  };
  generatedAt: string;
};

/**
 * Generates a results summary for a completed session.
 * Stores the summary in Redis for fast retrieval on the results page.
 */
export async function processResultsSummary(job: Job<ResultsSummaryJobData>) {
  const { sessionId } = job.data;

  logger.info({ sessionId, jobId: job.id }, "Generating results summary");

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      items: {
        orderBy: { order: "asc" },
        include: {
          winner: true,
          bids: {
            include: { participant: true },
            orderBy: { amount: "desc" },
          },
        },
      },
      participants: {
        where: { role: "BIDDER" },
        orderBy: { joinedAt: "asc" },
        include: {
          wonItems: { orderBy: { order: "asc" } },
        },
      },
    },
  });

  if (!session) {
    logger.warn({ sessionId }, "Session not found for summary");
    return { skipped: true, reason: "session_not_found" };
  }

  const soldItems = session.items.filter((i) => i.status === "SOLD");
  const unsoldItems = session.items.filter((i) => i.status === "UNSOLD");
  const totalRevenue = soldItems.reduce((sum, i) => sum + (i.currentBid ?? 0), 0);

  // Build rosters
  const rosters = session.participants.map((p) => ({
    participantId: p.id,
    name: p.name,
    budgetStart: session.budgetPerBidder,
    budgetRemaining: p.budget ?? 0,
    spent: session.budgetPerBidder - (p.budget ?? 0),
    items: p.wonItems.map((item) => ({
      name: item.name,
      price: item.currentBid ?? 0,
    })),
  }));

  // Bid statistics
  const allBids = session.items.flatMap((i) => i.bids);
  const totalBids = allBids.length;

  let highestBid: SessionSummary["bidStats"]["highestBid"] = null;
  if (allBids.length > 0) {
    const top = allBids.reduce((max, b) => (b.amount > max.amount ? b : max));
    const topItem = session.items.find((i) => i.id === top.itemId);
    highestBid = {
      itemName: topItem?.name ?? "Unknown",
      amount: top.amount,
      bidderName: top.participant.name,
    };
  }

  let mostContestedItem: SessionSummary["bidStats"]["mostContestedItem"] = null;
  const bidCountsByItem = session.items.map((i) => ({
    name: i.name,
    count: i.bids.length,
  }));
  const mostContested = bidCountsByItem.reduce(
    (max, i) => (i.count > max.count ? i : max),
    { name: "", count: 0 }
  );
  if (mostContested.count > 0) {
    mostContestedItem = {
      itemName: mostContested.name,
      bidCount: mostContested.count,
    };
  }

  const summary: SessionSummary = {
    sessionId,
    sessionName: session.name,
    hostName: session.hostName,
    totalItems: session.items.length,
    soldItems: soldItems.length,
    unsoldItems: unsoldItems.length,
    totalRevenue,
    rosters,
    bidStats: {
      totalBids,
      avgBidsPerItem: session.items.length > 0 ? Math.round(totalBids / session.items.length) : 0,
      highestBid,
      mostContestedItem,
    },
    generatedAt: new Date().toISOString(),
  };

  // Store in Redis
  const key = `${SUMMARY_KEY_PREFIX}${sessionId}`;
  await redis.set(key, JSON.stringify(summary), "EX", SUMMARY_TTL_SECONDS);

  logger.info(
    { sessionId, totalItems: summary.totalItems, soldItems: summary.soldItems },
    "Results summary generated"
  );

  return summary;
}

/**
 * Retrieve a cached session summary from Redis.
 */
export async function getSessionSummary(
  sessionId: string
): Promise<SessionSummary | null> {
  const key = `${SUMMARY_KEY_PREFIX}${sessionId}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
}
