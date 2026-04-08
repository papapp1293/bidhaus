import type { Job } from "bullmq";
import type { ItemExpiryJobData } from "@/server/queue";
import { prisma } from "@/server/db";
import { awardItem, advanceToNextItem } from "@/server/bid-service";
import { startItemTimer } from "@/server/timer-service";
import { scheduleItemExpiryJob, enqueueResultsSummary } from "@/server/queue";
import { logger } from "@/lib/logger";

/**
 * Processes item expiry: awards the item to the highest bidder (or marks unsold),
 * then advances to the next item or completes the session.
 *
 * Socket.io events are NOT emitted here — the worker doesn't hold socket
 * connections. Instead, it publishes to a Redis pub/sub channel that the
 * socket server subscribes to (see socket.ts worker-bridge).
 */
export const ITEM_EXPIRY_CHANNEL = "worker:item-expired";

export async function processItemExpiry(job: Job<ItemExpiryJobData>) {
  const { sessionId, sessionCode, itemId, timePerItem } = job.data;

  logger.info({ jobId: job.id, itemId, sessionId }, "Processing item expiry");

  // Verify session is still live
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });

  if (!session || session.status !== "LIVE") {
    logger.info({ sessionId }, "Session not live, skipping item expiry");
    return { skipped: true, reason: "session_not_live" };
  }

  // Award item
  const award = await awardItem(itemId);

  // Advance to next item
  const next = await advanceToNextItem(sessionId);

  let nextEndsAt: number | null = null;
  if (!next.completed && next.item) {
    nextEndsAt = await startItemTimer(sessionId, timePerItem);

    // Schedule expiry for the next item
    await scheduleItemExpiryJob(
      {
        sessionId,
        sessionCode,
        itemId: next.item.id,
        timePerItem,
      },
      timePerItem * 1000
    );
  }

  // Publish result to Redis so the socket server can broadcast.
  // This MUST happen before any other optional work (e.g. results summary
  // enqueue) so that a failure downstream can never prevent clients from
  // learning that the item closed / the session completed.
  const { redis } = await import("@/server/redis");
  await redis.publish(
    ITEM_EXPIRY_CHANNEL,
    JSON.stringify({
      sessionCode,
      sessionId,
      award: {
        itemId,
        sold: award.sold,
        winner: award.winner ?? null,
        amount: award.amount ?? null,
      },
      next: next.completed
        ? { completed: true, item: null, endsAt: null, roundRestarted: !!next.roundRestarted }
        : {
            completed: false,
            item: next.item,
            endsAt: nextEndsAt ? new Date(nextEndsAt).toISOString() : null,
            roundRestarted: !!next.roundRestarted,
          },
    })
  );

  if (next.completed) {
    try {
      await enqueueResultsSummary(sessionId);
    } catch (err) {
      // Non-fatal: results API falls back to on-the-fly generation.
      logger.error(
        { err, sessionId },
        "Failed to enqueue results summary (non-fatal)"
      );
    }
  }

  logger.info(
    { itemId, sold: award.sold, nextItem: next.item?.id ?? null },
    "Item expiry processed"
  );

  return { award, next: { completed: next.completed, itemId: next.item?.id } };
}
