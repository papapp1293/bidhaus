import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { redis } from "@/server/redis";
import { itemExpiryQueue, sessionCleanupQueue, resultsSummaryQueue } from "@/server/queue";

export async function GET() {
  const now = Date.now();
  const oneMinuteAgo = new Date(now - 60_000);

  // Run independent queries in parallel
  const [
    activeSessions,
    connectedUsers,
    recentBidCount,
    totalSessions,
    expiryQueueCounts,
    cleanupQueueCounts,
    summaryQueueCounts,
    cacheKeyCount,
  ] = await Promise.all([
    // Active sessions (LIVE or PAUSED)
    prisma.session.count({
      where: { status: { in: ["LIVE", "PAUSED"] } },
    }),

    // Connected participants
    prisma.participant.count({
      where: { connected: true },
    }),

    // Bids in the last minute
    prisma.bid.count({
      where: { createdAt: { gte: oneMinuteAgo } },
    }),

    // Total sessions by status
    prisma.session.groupBy({
      by: ["status"],
      _count: true,
    }),

    // Queue depths
    itemExpiryQueue.getJobCounts("waiting", "active", "delayed", "failed"),
    sessionCleanupQueue.getJobCounts("waiting", "active", "delayed", "failed"),
    resultsSummaryQueue.getJobCounts("waiting", "active", "delayed", "failed"),

    // Approximate cache key count (non-blocking SCAN)
    countCacheKeys(),
  ]);

  const sessionsByStatus = Object.fromEntries(
    totalSessions.map((s) => [s.status, s._count])
  );

  return NextResponse.json({
    timestamp: new Date(now).toISOString(),
    sessions: {
      active: activeSessions,
      byStatus: sessionsByStatus,
    },
    users: {
      connected: connectedUsers,
    },
    bids: {
      lastMinute: recentBidCount,
    },
    queues: {
      "item-expiry": expiryQueueCounts,
      "session-cleanup": cleanupQueueCounts,
      "results-summary": summaryQueueCounts,
    },
    cache: {
      keys: cacheKeyCount,
    },
  });
}

async function countCacheKeys(): Promise<number> {
  try {
    let count = 0;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        "cache:*",
        "COUNT",
        100
      );
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== "0");
    return count;
  } catch {
    return -1;
  }
}
