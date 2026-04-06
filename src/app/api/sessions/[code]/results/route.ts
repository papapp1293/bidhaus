import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { getSessionSummary } from "@/worker/jobs/results-summary";
import type { SessionSummary } from "@/worker/jobs/results-summary";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const session = await prisma.session.findUnique({
    where: { code },
    select: { id: true, status: true },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.status !== "COMPLETED") {
    return NextResponse.json(
      { error: "Session is not completed yet" },
      { status: 400 }
    );
  }

  // Try cached summary first
  const cached = await getSessionSummary(session.id);
  if (cached) {
    return NextResponse.json(cached);
  }

  // Fallback: generate summary on the fly from DB
  const fullSession = await prisma.session.findUnique({
    where: { id: session.id },
    include: {
      items: {
        orderBy: { order: "asc" },
        include: {
          winner: true,
          bids: {
            include: { participant: true },
            orderBy: { amount: "desc" },
          },
        },
      },
      participants: {
        where: { role: "BIDDER" },
        orderBy: { joinedAt: "asc" },
        include: {
          wonItems: { orderBy: { order: "asc" } },
        },
      },
    },
  });

  if (!fullSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const soldItems = fullSession.items.filter((i) => i.status === "SOLD");
  const totalRevenue = soldItems.reduce(
    (sum, i) => sum + (i.currentBid ?? 0),
    0
  );

  const rosters = fullSession.participants.map((p) => ({
    participantId: p.id,
    name: p.name,
    budgetStart: fullSession.budgetPerBidder,
    budgetRemaining: p.budget ?? 0,
    spent: fullSession.budgetPerBidder - (p.budget ?? 0),
    items: p.wonItems.map((item) => ({
      name: item.name,
      price: item.currentBid ?? 0,
    })),
  }));

  const allBids = fullSession.items.flatMap((i) => i.bids);
  const totalBids = allBids.length;

  let highestBid: SessionSummary["bidStats"]["highestBid"] = null;
  if (allBids.length > 0) {
    const top = allBids.reduce((max, b) => (b.amount > max.amount ? b : max));
    const topItem = fullSession.items.find((i) => i.id === top.itemId);
    highestBid = {
      itemName: topItem?.name ?? "Unknown",
      amount: top.amount,
      bidderName: top.participant.name,
    };
  }

  let mostContestedItem: SessionSummary["bidStats"]["mostContestedItem"] = null;
  const bidCountsByItem = fullSession.items.map((i) => ({
    name: i.name,
    count: i.bids.length,
  }));
  const mostContested = bidCountsByItem.reduce(
    (max, i) => (i.count > max.count ? i : max),
    { name: "", count: 0 }
  );
  if (mostContested.count > 0) {
    mostContestedItem = {
      itemName: mostContested.name,
      bidCount: mostContested.count,
    };
  }

  const summary: SessionSummary = {
    sessionId: session.id,
    sessionName: fullSession.name,
    hostName: fullSession.hostName,
    totalItems: fullSession.items.length,
    soldItems: soldItems.length,
    unsoldItems: fullSession.items.filter((i) => i.status === "UNSOLD").length,
    totalRevenue,
    rosters,
    bidStats: {
      totalBids,
      avgBidsPerItem:
        fullSession.items.length > 0
          ? Math.round(totalBids / fullSession.items.length)
          : 0,
      highestBid,
      mostContestedItem,
    },
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(summary);
}
