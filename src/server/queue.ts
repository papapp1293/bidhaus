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
 * Uses itemId as the job ID so we can easily remove it if the item
 * is closed early (host:close-item, host:skip).
 */
export async function scheduleItemExpiryJob(
  data: ItemExpiryJobData,
  delayMs: number
): Promise<void> {
  // Remove any existing expiry job for this item (e.g. if timer was reset)
  const existing = await itemExpiryQueue.getJob(data.itemId);
  if (existing) {
    await existing.remove().catch(() => {});
  }

  await itemExpiryQueue.add("expire", data, {
    delay: delayMs,
    jobId: data.itemId,
  });

  logger.info(
    { itemId: data.itemId, delayMs },
    "Scheduled item expiry job"
  );
}

/**
 * Cancel a pending item expiry job (e.g. host closed item early).
 */
export async function cancelItemExpiryJob(itemId: string): Promise<void> {
  const job = await itemExpiryQueue.getJob(itemId);
  if (job) {
    await job.remove().catch(() => {});
    logger.info({ itemId }, "Cancelled item expiry job");
  }
}

/**
 * Enqueue a results summary generation job.
 */
export async function enqueueResultsSummary(
  sessionId: string
): Promise<void> {
  await resultsSummaryQueue.add("summarize", { sessionId }, {
    jobId: `summary:${sessionId}`,
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
