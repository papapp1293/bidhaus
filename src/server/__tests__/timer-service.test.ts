import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("../redis", () => ({
  redis: mockRedis,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/constants", () => ({
  TIMER_SYNC_INTERVAL_MS: 5000,
}));

import { startItemTimer, getTimerEnd, clearTimer, getRemainingMs } from "../timer-service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startItemTimer", () => {
  it("stores timer end timestamp in Redis", async () => {
    mockRedis.set.mockResolvedValue("OK");

    const before = Date.now();
    const endsAt = await startItemTimer("session-1", 30);
    const after = Date.now();

    expect(endsAt).toBeGreaterThanOrEqual(before + 30000);
    expect(endsAt).toBeLessThanOrEqual(after + 30000);
    expect(mockRedis.set).toHaveBeenCalledWith(
      "timer:session:session-1",
      expect.any(String),
      "EX",
      35 // durationSeconds + 5
    );
  });

  it("still returns endsAt when Redis fails", async () => {
    mockRedis.set.mockRejectedValue(new Error("Redis down"));

    const endsAt = await startItemTimer("session-1", 30);

    expect(endsAt).toBeGreaterThan(Date.now() + 29000);
  });
});

describe("getTimerEnd", () => {
  it("returns stored timestamp", async () => {
    const expected = Date.now() + 15000;
    mockRedis.get.mockResolvedValue(String(expected));

    const result = await getTimerEnd("session-1");

    expect(result).toBe(expected);
  });

  it("returns null when no timer set", async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await getTimerEnd("session-1");

    expect(result).toBeNull();
  });

  it("returns null on Redis error", async () => {
    mockRedis.get.mockRejectedValue(new Error("Redis down"));

    const result = await getTimerEnd("session-1");

    expect(result).toBeNull();
  });
});

describe("clearTimer", () => {
  it("deletes timer key", async () => {
    mockRedis.del.mockResolvedValue(1);

    await clearTimer("session-1");

    expect(mockRedis.del).toHaveBeenCalledWith("timer:session:session-1");
  });

  it("does not throw on Redis error", async () => {
    mockRedis.del.mockRejectedValue(new Error("Redis down"));

    await expect(clearTimer("session-1")).resolves.toBeUndefined();
  });
});

describe("getRemainingMs", () => {
  it("returns positive ms when timer is in the future", () => {
    const endsAt = Date.now() + 5000;

    const result = getRemainingMs(endsAt);

    expect(result).toBeGreaterThan(4900);
    expect(result).toBeLessThanOrEqual(5000);
  });

  it("returns 0 when timer has expired", () => {
    const endsAt = Date.now() - 1000;

    const result = getRemainingMs(endsAt);

    expect(result).toBe(0);
  });

  it("returns 0 when timer is exactly now", () => {
    const result = getRemainingMs(Date.now());

    expect(result).toBe(0);
  });
});
