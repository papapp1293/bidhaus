import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../db", () => ({
  prisma: {
    item: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    participant: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    session: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    bid: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../rate-limiter", () => ({
  checkBidRateLimit: vi.fn(),
}));

vi.mock("../cache", () => ({
  cacheSet: vi.fn(),
  cacheInvalidate: vi.fn(),
  CacheKeys: {
    activeItem: (id: string) => `active-item:${id}`,
    session: (code: string) => `session:${code}`,
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { placeBid, awardItem, advanceToNextItem } from "../bid-service";
import { prisma } from "../db";
import { checkBidRateLimit } from "../rate-limiter";

const mockPrisma = vi.mocked(prisma);
const mockRateLimit = vi.mocked(checkBidRateLimit);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("placeBid", () => {
  const baseItem = {
    id: "item-1",
    sessionId: "session-1",
    name: "Player A",
    status: "ACTIVE",
    currentBid: 10,
    minBid: 1,
    version: 1,
    winnerId: null,
    session: { code: "ABCD1234" },
  };

  const baseParticipant = {
    id: "bidder-1",
    sessionId: "session-1",
    name: "Alice",
    role: "BIDDER",
    budget: 100,
    token: "tok-1",
    connected: true,
  };

  it("rejects when rate limited", async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 500 });

    const result = await placeBid("item-1", 15, "bidder-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain("slow down");
      expect(result.retryAfterMs).toBe(500);
    }
  });

  it("rejects when item not found", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue(null);
    mockPrisma.participant.findUnique.mockResolvedValue(baseParticipant as any);

    const result = await placeBid("missing", 15, "bidder-1");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("Item not found");
  });

  it("rejects when participant not found", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue(baseItem as any);
    mockPrisma.participant.findUnique.mockResolvedValue(null);

    const result = await placeBid("item-1", 15, "missing");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("Participant not found");
  });

  it("rejects spectators", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue(baseItem as any);
    mockPrisma.participant.findUnique.mockResolvedValue({
      ...baseParticipant,
      role: "SPECTATOR",
    } as any);

    const result = await placeBid("item-1", 15, "bidder-1");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("Only bidders can place bids");
  });

  it("rejects bid on inactive item", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue({
      ...baseItem,
      status: "SOLD",
    } as any);
    mockPrisma.participant.findUnique.mockResolvedValue(baseParticipant as any);

    const result = await placeBid("item-1", 15, "bidder-1");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("Item is not currently up for auction");
  });

  it("rejects bid below minimum", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue(baseItem as any);
    mockPrisma.participant.findUnique.mockResolvedValue(baseParticipant as any);

    const result = await placeBid("item-1", 10, "bidder-1"); // current is 10, need 11+

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toContain("at least $11");
  });

  it("rejects bid exceeding budget", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue(baseItem as any);
    mockPrisma.participant.findUnique.mockResolvedValue({
      ...baseParticipant,
      budget: 5,
    } as any);

    const result = await placeBid("item-1", 15, "bidder-1");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("Insufficient budget");
  });

  it("rejects when participant in different session", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue(baseItem as any);
    mockPrisma.participant.findUnique.mockResolvedValue({
      ...baseParticipant,
      sessionId: "other-session",
    } as any);

    const result = await placeBid("item-1", 15, "bidder-1");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("Participant not in this session");
  });

  it("succeeds with valid bid through transaction", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue(baseItem as any);
    mockPrisma.participant.findUnique.mockResolvedValue(baseParticipant as any);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        participant: {
          findUnique: vi.fn().mockResolvedValue({ budget: 100, name: "Alice" }),
        },
        item: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        bid: {
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return fn(tx);
    });

    const result = await placeBid("item-1", 15, "bidder-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.bid.amount).toBe(15);
      expect(result.bid.participantName).toBe("Alice");
    }
  });

  it("fails when optimistic lock detects conflict", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockPrisma.item.findUnique.mockResolvedValue(baseItem as any);
    mockPrisma.participant.findUnique.mockResolvedValue(baseParticipant as any);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        participant: {
          findUnique: vi.fn().mockResolvedValue({ budget: 100, name: "Alice" }),
        },
        item: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }), // conflict!
        },
        bid: { create: vi.fn() },
      };
      return fn(tx);
    });

    const result = await placeBid("item-1", 15, "bidder-1");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toContain("outbid");
  });
});

describe("awardItem", () => {
  it("marks item as sold and deducts budget", async () => {
    mockPrisma.item.findUnique.mockResolvedValue({
      id: "item-1",
      sessionId: "session-1",
      currentBid: 25,
      winnerId: "bidder-1",
      winner: { id: "bidder-1", name: "Alice" },
      session: { code: "ABCD1234" },
    } as any);
    mockPrisma.$transaction.mockResolvedValue([{}, {}]);

    const result = await awardItem("item-1");

    expect(result.sold).toBe(true);
    expect(result.winner).toBe("Alice");
    expect(result.amount).toBe(25);
  });

  it("marks item as unsold when no bids", async () => {
    mockPrisma.item.findUnique.mockResolvedValue({
      id: "item-1",
      sessionId: "session-1",
      currentBid: null,
      winnerId: null,
      winner: null,
      session: { code: "ABCD1234" },
    } as any);
    mockPrisma.item.update.mockResolvedValue({} as any);

    const result = await awardItem("item-1");

    expect(result.sold).toBe(false);
  });

  it("returns sold=false when item not found", async () => {
    mockPrisma.item.findUnique.mockResolvedValue(null);

    const result = await awardItem("missing");

    expect(result.sold).toBe(false);
  });
});

describe("advanceToNextItem", () => {
  it("activates the next pending item", async () => {
    mockPrisma.session.findUnique.mockResolvedValue({
      id: "session-1",
      code: "ABCD1234",
      currentItemIdx: 0,
      timePerItem: 30,
      items: [
        { id: "item-1", name: "A", status: "SOLD", order: 0 },
        { id: "item-2", name: "B", description: null, minBid: 1, order: 1, status: "PENDING" },
      ],
    } as any);
    mockPrisma.$transaction.mockResolvedValue([{}, {}]);

    const result = await advanceToNextItem("session-1");

    expect(result.completed).toBe(false);
    expect(result.item?.id).toBe("item-2");
    expect(result.item?.name).toBe("B");
  });

  it("marks session completed when no more items", async () => {
    mockPrisma.session.findUnique.mockResolvedValue({
      id: "session-1",
      code: "ABCD1234",
      currentItemIdx: 1,
      items: [
        { id: "item-1", status: "SOLD", order: 0 },
        { id: "item-2", status: "SOLD", order: 1 },
      ],
    } as any);
    mockPrisma.session.update.mockResolvedValue({} as any);

    const result = await advanceToNextItem("session-1");

    expect(result.completed).toBe(true);
    expect(result.item).toBeNull();
  });

  it("returns completed=true when session not found", async () => {
    mockPrisma.session.findUnique.mockResolvedValue(null);

    const result = await advanceToNextItem("missing");

    expect(result.completed).toBe(true);
  });
});
