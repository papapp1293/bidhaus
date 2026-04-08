import { redis } from "./redis";
import { logger } from "@/lib/logger";
import { TIMER_SYNC_INTERVAL_MS } from "@/lib/constants";

const TIMER_KEY_PREFIX = "timer:session:";
const PAUSE_KEY_PREFIX = "timer:paused:session:";

export async function startItemTimer(
  sessionId: string,
  durationSeconds: number
): Promise<number> {
  const endsAt = Date.now() + durationSeconds * 1000;
  const key = `${TIMER_KEY_PREFIX}${sessionId}`;

  try {
    await redis.set(key, endsAt.toString(), "EX", durationSeconds + 5);
  } catch {
    logger.warn({ sessionId }, "Redis unavailable for timer, using memory");
  }

  return endsAt;
}

export async function getTimerEnd(sessionId: string): Promise<number | null> {
  try {
    const key = `${TIMER_KEY_PREFIX}${sessionId}`;
    const val = await redis.get(key);
    return val ? Number(val) : null;
  } catch {
    return null;
  }
}

export async function clearTimer(sessionId: string): Promise<void> {
  try {
    await redis.del(
      `${TIMER_KEY_PREFIX}${sessionId}`,
      `${PAUSE_KEY_PREFIX}${sessionId}`
    );
  } catch {
    // ignore
  }
}

export function getRemainingMs(endsAt: number): number {
  return Math.max(0, endsAt - Date.now());
}

/**
 * Pause the timer: capture current remaining ms in Redis and clear endsAt.
 * Returns the captured remaining ms (or null if no timer was running).
 */
export async function pauseItemTimer(
  sessionId: string
): Promise<number | null> {
  const endsAt = await getTimerEnd(sessionId);
  if (endsAt === null) return null;

  const remainingMs = getRemainingMs(endsAt);
  try {
    await redis.set(
      `${PAUSE_KEY_PREFIX}${sessionId}`,
      remainingMs.toString(),
      "EX",
      24 * 60 * 60 // 24h safety TTL
    );
    await redis.del(`${TIMER_KEY_PREFIX}${sessionId}`);
  } catch {
    // ignore
  }
  return remainingMs;
}

/**
 * Resume from a paused state: read the captured remaining ms, write a fresh
 * endsAt = now + remaining, and return the new endsAt. Returns null if there
 * is no paused state to resume.
 */
export async function resumeItemTimer(
  sessionId: string
): Promise<{ endsAt: number; remainingMs: number } | null> {
  try {
    const val = await redis.get(`${PAUSE_KEY_PREFIX}${sessionId}`);
    if (!val) return null;
    const remainingMs = Number(val);
    const endsAt = Date.now() + remainingMs;
    await redis.set(
      `${TIMER_KEY_PREFIX}${sessionId}`,
      endsAt.toString(),
      "PX",
      remainingMs + 5000
    );
    await redis.del(`${PAUSE_KEY_PREFIX}${sessionId}`);
    return { endsAt, remainingMs };
  } catch {
    return null;
  }
}

/**
 * Extend the timer so at least `minRemainingMs` remain. No-op if more time
 * already remains. Returns the (possibly new) endsAt.
 */
export async function ensureMinRemaining(
  sessionId: string,
  minRemainingMs: number
): Promise<{ endsAt: number; extended: boolean } | null> {
  const endsAt = await getTimerEnd(sessionId);
  if (endsAt === null) return null;

  const remaining = getRemainingMs(endsAt);
  if (remaining >= minRemainingMs) {
    return { endsAt, extended: false };
  }

  const newEndsAt = Date.now() + minRemainingMs;
  try {
    await redis.set(
      `${TIMER_KEY_PREFIX}${sessionId}`,
      newEndsAt.toString(),
      "PX",
      minRemainingMs + 5000
    );
  } catch {
    // ignore
  }
  return { endsAt: newEndsAt, extended: true };
}

export { TIMER_SYNC_INTERVAL_MS };
