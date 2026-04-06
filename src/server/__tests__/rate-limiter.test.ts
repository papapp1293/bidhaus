import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPipeline, mockRedis } = vi.hoisted(() => {
  const mockPipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    pttl: vi.fn().mockReturnThis(),
    exec: vi.fn(),
  };
  return {
    mockPipeline,
    mockRedis: {
      pipeline: vi.fn(() => mockPipeline),
      zrange: vi.fn(),
      pexpire: vi.fn(),
    },
  };
});

vi.mock("../redis", () => ({
  redis: mockRedis,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/constants", () => ({
  RATE_LIMIT_BIDS_PER_SECOND: 3,
}));

import { checkBidRateLimit, checkGlobalRateLimit } from "../rate-limiter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkBidRateLimit", () => {
  it("allows request when under limit", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 0],  // zremrangebyscore
      [null, 2],  // zcard: 2 requests in window (under 3)
      [null, 1],  // zadd
      [null, 1],  // pexpire
    ]);

    const result = await checkBidRateLimit("bidder-1");

    expect(result.allowed).toBe(true);
  });

  it("blocks request when at limit", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 3],  // zcard: 3 requests (at limit)
      [null, 1],
      [null, 1],
    ]);
    mockRedis.zrange.mockResolvedValue([
      "123456",
      String(Date.now() - 500), // oldest entry 500ms ago
    ]);

    const result = await checkBidRateLimit("bidder-1");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("allows request when Redis pipeline returns null (graceful degradation)", async () => {
    mockPipeline.exec.mockResolvedValue(null);

    const result = await checkBidRateLimit("bidder-1");

    expect(result.allowed).toBe(true);
  });

  it("allows request on Redis error", async () => {
    mockPipeline.exec.mockRejectedValue(new Error("Redis down"));

    const result = await checkBidRateLimit("bidder-1");

    expect(result.allowed).toBe(true);
  });
});

describe("checkGlobalRateLimit", () => {
  it("allows request under limit", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 5],   // incr: 5th request
      [null, 50000], // pttl: 50s remaining
    ]);

    const result = await checkGlobalRateLimit("127.0.0.1");

    expect(result.allowed).toBe(true);
  });

  it("blocks request over limit", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 61],    // incr: 61st request (over 60 default)
      [null, 30000], // pttl: 30s remaining
    ]);

    const result = await checkGlobalRateLimit("127.0.0.1");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBe(30000);
    }
  });

  it("sets expiry on first request (ttl < 0)", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 1],  // incr: first request
      [null, -1], // pttl: no expiry set
    ]);
    mockRedis.pexpire.mockResolvedValue(1);

    const result = await checkGlobalRateLimit("127.0.0.1");

    expect(result.allowed).toBe(true);
    expect(mockRedis.pexpire).toHaveBeenCalled();
  });

  it("allows on Redis error", async () => {
    mockPipeline.exec.mockRejectedValue(new Error("Redis down"));

    const result = await checkGlobalRateLimit("127.0.0.1");

    expect(result.allowed).toBe(true);
  });
});
