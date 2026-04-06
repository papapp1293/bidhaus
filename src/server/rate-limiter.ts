import { redis } from "./redis";
import { logger } from "@/lib/logger";
import { RATE_LIMIT_BIDS_PER_SECOND } from "@/lib/constants";

type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

const WINDOW_MS = 1000; // 1 second sliding window

/**
 * Redis sliding window rate limiter.
 * Uses sorted sets with timestamps as scores.
 * Key: `ratelimit:bid:{participantId}`
 */
export async function checkBidRateLimit(
  participantId: string
): Promise<RateLimitResult> {
  const key = `ratelimit:bid:${participantId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  try {
    const pipeline = redis.pipeline();

    // Remove entries outside the window
    pipeline.zremrangebyscore(key, 0, windowStart);

    // Count entries in current window
    pipeline.zcard(key);

    // Add current request
    pipeline.zadd(key, now, `${now}:${Math.random()}`);

    // Set expiry on the key
    pipeline.pexpire(key, WINDOW_MS * 2);

    const results = await pipeline.exec();

    if (!results) {
      // Redis unavailable — allow the request
      return { allowed: true };
    }

    // zcard result is at index 1
    const count = results[1]?.[1] as number;

    if (count >= RATE_LIMIT_BIDS_PER_SECOND) {
      // Find the oldest entry to calculate retry-after
      const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
      const oldestTime = oldest.length >= 2 ? Number(oldest[1]) : now;
      const retryAfterMs = Math.max(0, oldestTime + WINDOW_MS - now);

      logger.warn(
        { participantId, count, retryAfterMs },
        "Bid rate limited"
      );

      return { allowed: false, retryAfterMs };
    }

    return { allowed: true };
  } catch (err) {
    // If Redis is down, allow the request (graceful degradation)
    logger.warn({ err, participantId }, "Rate limiter Redis error, allowing");
    return { allowed: true };
  }
}

/**
 * Global API rate limiter per IP.
 * Uses a simpler fixed-window counter.
 */
export async function checkGlobalRateLimit(
  ip: string,
  maxRequests: number = 60,
  windowSeconds: number = 60
): Promise<RateLimitResult> {
  const key = `ratelimit:global:${ip}`;

  try {
    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.pttl(key);

    const results = await pipeline.exec();

    if (!results) return { allowed: true };

    const count = results[0]?.[1] as number;
    const ttl = results[1]?.[1] as number;

    // Set expiry on first request
    if (ttl < 0) {
      await redis.pexpire(key, windowSeconds * 1000);
    }

    if (count > maxRequests) {
      const retryAfterMs = ttl > 0 ? ttl : windowSeconds * 1000;
      return { allowed: false, retryAfterMs };
    }

    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}
