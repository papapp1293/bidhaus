import type { Job } from "bullmq";
import type { SessionCleanupJobData } from "@/server/queue";
import { prisma } from "@/server/db";
import { SESSION_EXPIRY_HOURS } from "@/lib/constants";
import { logger } from "@/lib/logger";

/**
 * Cleans up stale sessions:
 * - Deletes COMPLETED sessions older than SESSION_EXPIRY_HOURS
 * - Marks LOBBY sessions with no activity older than SESSION_EXPIRY_HOURS as expired and deletes them
 * - Marks stuck LIVE/PAUSED sessions older than SESSION_EXPIRY_HOURS as COMPLETED
 *
 * Cascading deletes are handled by Prisma's onDelete: Cascade relations.
 */
export async function processSessionCleanup(job: Job<SessionCleanupJobData>) {
  const cutoff = new Date(Date.now() - SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

  logger.info(
    { cutoff: cutoff.toISOString(), jobId: job.id },
    "Running session cleanup"
  );

  // Delete completed sessions older than cutoff
  const deleted = await prisma.session.deleteMany({
    where: {
      status: "COMPLETED",
      createdAt: { lt: cutoff },
    },
  });

  // Delete abandoned lobby sessions
  const deletedLobby = await prisma.session.deleteMany({
    where: {
      status: "LOBBY",
      createdAt: { lt: cutoff },
    },
  });

  // Force-complete stuck live/paused sessions
  const forcedComplete = await prisma.session.updateMany({
    where: {
      status: { in: ["LIVE", "PAUSED"] },
      createdAt: { lt: cutoff },
    },
    data: { status: "COMPLETED" },
  });

  const result = {
    deletedCompleted: deleted.count,
    deletedLobby: deletedLobby.count,
    forcedCompleted: forcedComplete.count,
  };

  logger.info(result, "Session cleanup finished");
  return result;
}
