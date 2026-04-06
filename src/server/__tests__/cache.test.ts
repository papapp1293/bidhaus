import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
  },
}));

vi.mock("../redis", () => ({
  redis: mockRedis,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { cacheGet, cacheSet, cacheInvalidate, cacheInvalidatePattern, cacheFetch } from "../cache";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cacheGet", () => {
  it("returns parsed value on hit", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ name: "test" }));

    const result = await cacheGet<{ name: string }>("key");

    expect(result).toEqual({ name: "test" });
    expect(mockRedis.get).toHaveBeenCalledWith("cache:key");
  });

  it("returns null on miss", async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await cacheGet("key");

    expect(result).toBeNull();
  });

  it("returns null on Redis error (graceful degradation)", async () => {
    mockRedis.get.mockRejectedValue(new Error("Redis down"));

    const result = await cacheGet("key");

    expect(result).toBeNull();
  });
});

describe("cacheSet", () => {
  it("stores value with TTL", async () => {
    mockRedis.set.mockResolvedValue("OK");

    await cacheSet("key", { data: 42 }, 120);

    expect(mockRedis.set).toHaveBeenCalledWith(
      "cache:key",
      JSON.stringify({ data: 42 }),
      "EX",
      120
    );
  });

  it("does not throw on Redis error", async () => {
    mockRedis.set.mockRejectedValue(new Error("Redis down"));

    await expect(cacheSet("key", "val")).resolves.toBeUndefined();
  });
});

describe("cacheInvalidate", () => {
  it("deletes one key", async () => {
    mockRedis.del.mockResolvedValue(1);

    await cacheInvalidate("key1");

    expect(mockRedis.del).toHaveBeenCalledWith("cache:key1");
  });

  it("deletes multiple keys", async () => {
    mockRedis.del.mockResolvedValue(2);

    await cacheInvalidate("key1", "key2");

    expect(mockRedis.del).toHaveBeenCalledWith("cache:key1", "cache:key2");
  });

  it("does nothing with empty keys", async () => {
    await cacheInvalidate();

    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it("does not throw on Redis error", async () => {
    mockRedis.del.mockRejectedValue(new Error("Redis down"));

    await expect(cacheInvalidate("key")).resolves.toBeUndefined();
  });
});

describe("cacheInvalidatePattern", () => {
  it("scans and deletes matching keys", async () => {
    mockRedis.scan
      .mockResolvedValueOnce(["5", ["cache:session:abc1", "cache:session:abc2"]])
      .mockResolvedValueOnce(["0", ["cache:session:abc3"]]);
    mockRedis.del.mockResolvedValue(1);

    await cacheInvalidatePattern("session:abc*");

    expect(mockRedis.del).toHaveBeenCalledTimes(2);
  });

  it("does not throw on Redis error", async () => {
    mockRedis.scan.mockRejectedValue(new Error("Redis down"));

    await expect(cacheInvalidatePattern("key*")).resolves.toBeUndefined();
  });
});

describe("cacheFetch", () => {
  it("returns cached value on hit (skips fetcher)", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ cached: true }));
    const fetcher = vi.fn();

    const result = await cacheFetch("key", fetcher);

    expect(result).toEqual({ cached: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("calls fetcher on miss and caches result", async () => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue("OK");
    const fetcher = vi.fn().mockResolvedValue({ fresh: true });

    const result = await cacheFetch("key", fetcher, 60);

    expect(result).toEqual({ fresh: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mockRedis.set).toHaveBeenCalledWith(
      "cache:key",
      JSON.stringify({ fresh: true }),
      "EX",
      60
    );
  });

  it("calls fetcher when Redis fails (graceful degradation)", async () => {
    mockRedis.get.mockRejectedValue(new Error("Redis down"));
    mockRedis.set.mockRejectedValue(new Error("Redis down"));
    const fetcher = vi.fn().mockResolvedValue({ fallback: true });

    const result = await cacheFetch("key", fetcher);

    expect(result).toEqual({ fallback: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
