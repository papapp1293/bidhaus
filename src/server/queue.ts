import { Queue } from "bullmq";
import { redis } from "./redis";
import { logger } from "@/lib/logger";

const connection = redis;

// --- Queue definitions ---

/** Delayed job: fires when an item's auction timer expires */
export const itemExpiryQueue = new Queue("item-expiry", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

/** Repeatable job: cleans up stale sessions older than 24h */
export const sessionCleanupQueue = new Queue("session-cleanup", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

/** Triggered on session completion: generates results summary */
export const resultsSummaryQueue = new Queue("results-summary", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

// --- Job data types ---

export type ItemExpiryJobData = {
  sessionId: string;
  sessionCode: string;
  itemId: string;
  timePerItem: number;
};

export type SessionCleanupJobData = Record<string, never>;

export type ResultsSummaryJobData = {
  sessionId: string;
};

// --- Helpers ---

/**
 * Schedule an item expiry job with the given delay.
 *
 * We use a unique jobId per schedule (itemId + timestamp) because BullMQ
 * silently de-dups adds when the same jobId already exists in any state
 * (including "active" or "completed"). Re-using the itemId broke round
 * restarts: the worker, while processing the round-1 expiry, would try
 * to schedule the round-2 expiry with the same itemId — BullMQ saw the
 * still-active round-1 job and dropped the new one, so round 2 never
 * expired. A separate Redis key maps itemId → current jobId so cancels
 * and reset-time reschedules can still find the active job by itemId.
 */
const ITEM_EXPIRY_JOBID_KEY = (itemId: string) =>
  `itemExpiryJob:${itemId}`;

export async function scheduleItemExpiryJob(
  data: ItemExpiryJobData,
  delayMs: number
): Promise<void> {
  // Remove any existing expiry job for this item (e.g. timer reset or
  // round restart). The mapping lets us find the previous jobId even
  // when it differs from the itemId.
  const prev = await redis.get(ITEM_EXPIRY_JOBID_KEY(data.itemId));
  if (prev) {
    const existing = await itemExpiryQueue.getJob(prev);
    if (existing) {
      await existing.remove().catch(() => {});
    }
  }

  const jobId = `${data.itemId}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  await itemExpiryQueue.add("expire", data, {
    delay: delayMs,
    jobId,
  });

  // Track the active expiry jobId for this item so cancel/reschedule can
  // find it. TTL is generous — cleanup happens explicitly on removal.
  await redis.set(ITEM_EXPIRY_JOBID_KEY(data.itemId), jobId, "EX", 3600);

  logger.info(
    { itemId: data.itemId, jobId, delayMs },
    "Scheduled item expiry job"
  );
}

/**
 * Cancel a pending item expiry job (e.g. host closed item early).
 */
export async function cancelItemExpiryJob(itemId: string): Promise<void> {
  const current = await redis.get(ITEM_EXPIRY_JOBID_KEY(itemId));
  if (!current) return;
  const job = await itemExpiryQueue.getJob(current);
  if (job) {
    await job.remove().catch(() => {});
    logger.info({ itemId, jobId: current }, "Cancelled item expiry job");
  }
  await redis.del(ITEM_EXPIRY_JOBID_KEY(itemId));
}

/**
 * Enqueue a results summary generation job.
 */
export async function enqueueResultsSummary(
  sessionId: string
): Promise<void> {
  await resultsSummaryQueue.add("summarize", { sessionId }, {
    jobId: `summary-${sessionId}`,
  });
  logger.info({ sessionId }, "Enqueued results summary job");
}

/**
 * Set up the repeatable session cleanup job (runs every hour).
 */
export async function setupSessionCleanupSchedule(): Promise<void> {
  await sessionCleanupQueue.upsertJobScheduler(
    "cleanup-stale-sessions",
    { every: 60 * 60 * 1000 }, // every hour
    { name: "cleanup" },
  );
  logger.info("Session cleanup scheduler registered (every 1h)");
}
