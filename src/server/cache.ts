import { redis } from "./redis";
import { logger } from "@/lib/logger";

const KEY_PREFIX = "cache:";
const DEFAULT_TTL_SECONDS = 60; // 1 minute for active auction data

// --- Core cache-aside helpers ---

/**
 * Get a value from cache. Returns null on miss or Redis error (graceful degradation).
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(`${KEY_PREFIX}${key}`);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Set a value in cache with TTL.
 */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<void> {
  try {
    await redis.set(
      `${KEY_PREFIX}${key}`,
      JSON.stringify(value),
      "EX",
      ttlSeconds
    );
  } catch {
    // Cache write failure is non-fatal
  }
}

/**
 * Delete one or more cache keys.
 */
export async function cacheInvalidate(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys.map((k) => `${KEY_PREFIX}${k}`));
  } catch {
    // Invalidation failure is non-fatal
  }
}

/**
 * Delete all cache keys matching a pattern (e.g. "session:abc*").
 * Uses SCAN to avoid blocking Redis.
 */
export async function cacheInvalidatePattern(pattern: string): Promise<void> {
  try {
    const fullPattern = `${KEY_PREFIX}${pattern}`;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        fullPattern,
        "COUNT",
        100
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } catch {
    // Pattern invalidation failure is non-fatal
  }
}

// --- Domain-specific cache keys ---

export const CacheKeys = {
  session: (code: string) => `session:${code}`,
  activeItem: (sessionId: string) => `active-item:${sessionId}`,
  participants: (sessionId: string) => `participants:${sessionId}`,

  /** All keys related to a session (for bulk invalidation) */
  sessionPattern: (code: string) => `session:${code}*`,
  sessionByIdPattern: (sessionId: string) => `*:${sessionId}`,
} as const;

// --- Cache-aside fetch pattern ---

/**
 * Cache-aside: try cache first, fall back to fetcher, populate cache on miss.
 */
export async function cacheFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    logger.debug({ key }, "Cache hit");
    return cached;
  }

  logger.debug({ key }, "Cache miss");
  const value = await fetcher();
  await cacheSet(key, value, ttlSeconds);
  return value;
}
