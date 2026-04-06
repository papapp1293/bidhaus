import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "@/server/redis";
import { logger } from "@/lib/logger";
import { setupSessionCleanupSchedule } from "@/server/queue";
import { processItemExpiry } from "./jobs/item-expiry";
import { processSessionCleanup } from "./jobs/session-cleanup";
import { processResultsSummary } from "./jobs/results-summary";

const connection = redis;

// --- Workers ---

const itemExpiryWorker = new Worker("item-expiry", processItemExpiry, {
  connection,
  concurrency: 5,
  limiter: { max: 10, duration: 1000 },
});

const sessionCleanupWorker = new Worker("session-cleanup", processSessionCleanup, {
  connection,
  concurrency: 1,
});

const resultsSummaryWorker = new Worker("results-summary", processResultsSummary, {
  connection,
  concurrency: 3,
});

// --- Event logging ---

const workers = [
  { name: "item-expiry", worker: itemExpiryWorker },
  { name: "session-cleanup", worker: sessionCleanupWorker },
  { name: "results-summary", worker: resultsSummaryWorker },
];

for (const { name, worker } of workers) {
  worker.on("completed", (job) => {
    logger.info({ queue: name, jobId: job.id }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { queue: name, jobId: job?.id, err: err.message, attempts: job?.attemptsMade },
      "Job failed"
    );
  });

  worker.on("error", (err) => {
    logger.error({ queue: name, err: err.message }, "Worker error");
  });
}

// --- Startup ---

async function start() {
  logger.info("BidHaus worker starting...");

  // Ensure Redis is connected
  if (redis.status !== "ready") {
    await redis.connect();
  }

  // Register the repeatable session cleanup schedule
  await setupSessionCleanupSchedule();

  logger.info(
    { queues: workers.map((w) => w.name) },
    "BidHaus worker ready, processing jobs"
  );
}

start().catch((err) => {
  logger.error({ err }, "Worker failed to start");
  process.exit(1);
});

// --- Graceful shutdown ---

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down worker...");

  await Promise.all(workers.map(({ worker }) => worker.close()));

  logger.info("Worker shut down cleanly");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
