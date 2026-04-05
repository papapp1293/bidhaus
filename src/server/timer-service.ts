import { redis } from "./redis";
import { logger } from "@/lib/logger";
import { TIMER_SYNC_INTERVAL_MS } from "@/lib/constants";

const TIMER_KEY_PREFIX = "timer:session:";

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
    await redis.del(`${TIMER_KEY_PREFIX}${sessionId}`);
  } catch {
    // ignore
  }
}

export function getRemainingMs(endsAt: number): number {
  return Math.max(0, endsAt - Date.now());
}

export { TIMER_SYNC_INTERVAL_MS };
