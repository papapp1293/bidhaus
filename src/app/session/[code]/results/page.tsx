"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type RosterItem = { name: string; price: number };

type Roster = {
  participantId: string;
  name: string;
  budgetStart: number;
  budgetRemaining: number;
  spent: number;
  items: RosterItem[];
};

type BidStats = {
  totalBids: number;
  avgBidsPerItem: number;
  highestBid: { itemName: string; amount: number; bidderName: string } | null;
  mostContestedItem: { itemName: string; bidCount: number } | null;
};

type Summary = {
  sessionName: string;
  hostName: string;
  totalItems: number;
  soldItems: number;
  unsoldItems: number;
  totalRevenue: number;
  rosters: Roster[];
  bidStats: BidStats;
  generatedAt: string;
};

function formatResultsAsText(summary: Summary): string {
  const lines: string[] = [];
  lines.push(`=== ${summary.sessionName} — Final Results ===`);
  lines.push(`Host: ${summary.hostName}`);
  lines.push(
    `Items: ${summary.soldItems} sold, ${summary.unsoldItems} unsold (${summary.totalItems} total)`
  );
  lines.push(`Total Revenue: $${summary.totalRevenue}`);
  lines.push(`Total Bids: ${summary.bidStats.totalBids}`);
  lines.push("");

  if (summary.bidStats.highestBid) {
    const hb = summary.bidStats.highestBid;
    lines.push(
      `Highest Bid: $${hb.amount} by ${hb.bidderName} on ${hb.itemName}`
    );
  }
  if (summary.bidStats.mostContestedItem) {
    const mc = summary.bidStats.mostContestedItem;
    lines.push(
      `Most Contested: ${mc.itemName} (${mc.bidCount} bids)`
    );
  }
  lines.push("");

  lines.push("--- Rosters ---");
  for (const roster of summary.rosters) {
    lines.push("");
    lines.push(
      `${roster.name} — Spent: $${roster.spent} / $${roster.budgetStart} (Remaining: $${roster.budgetRemaining})`
    );
    if (roster.items.length === 0) {
      lines.push("  (no items won)");
    } else {
      for (const item of roster.items) {
        lines.push(`  - ${item.name} ($${item.price})`);
      }
    }
  }

  return lines.join("\n");
}

export default function ResultsPage() {
  const params = useParams<{ code: string }>();
  const code = params.code;

  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/sessions/${code}/results`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load results");
        return res.json();
      })
      .then(setSummary)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [code]);

  const handleCopy = useCallback(() => {
    if (!summary) return;
    navigator.clipboard.writeText(formatResultsAsText(summary)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [summary]);

  const handleShare = useCallback(() => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">Loading results...</p>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-destructive">{error ?? "No results available"}</p>
      </div>
    );
  }

  const mvpSpender = [...summary.rosters].sort(
    (a, b) => b.spent - a.spent
  )[0];
  const mvpCollector = [...summary.rosters].sort(
    (a, b) => b.items.length - a.items.length
  )[0];
  const mvpSaver = [...summary.rosters].sort(
    (a, b) => b.budgetRemaining - a.budgetRemaining
  )[0];

  return (
    <div className="flex flex-1 justify-center px-4 py-6">
      <div className="flex w-full max-w-4xl flex-col gap-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{summary.sessionName}</h1>
            <p className="text-sm text-muted-foreground">
              Hosted by {summary.hostName}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleShare}>
              {copied ? "Copied!" : "Share Link"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy as Text"}
            </Button>
          </div>
        </div>

        {/* Overview stats */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-2xl font-bold">${summary.totalRevenue}</p>
              <p className="text-xs text-muted-foreground">Total Revenue</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-2xl font-bold">{summary.soldItems}</p>
              <p className="text-xs text-muted-foreground">
                Items Sold ({summary.unsoldItems} unsold)
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-2xl font-bold">{summary.bidStats.totalBids}</p>
              <p className="text-xs text-muted-foreground">Total Bids</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-2xl font-bold">
                {summary.bidStats.avgBidsPerItem}
              </p>
              <p className="text-xs text-muted-foreground">Avg Bids / Item</p>
            </CardContent>
          </Card>
        </div>

        {/* MVP Stats */}
        {(summary.bidStats.highestBid || summary.bidStats.mostContestedItem) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Highlights</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2">
                {summary.bidStats.highestBid && (
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">Highest Bid</p>
                    <p className="font-medium">
                      ${summary.bidStats.highestBid.amount} by{" "}
                      {summary.bidStats.highestBid.bidderName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      on {summary.bidStats.highestBid.itemName}
                    </p>
                  </div>
                )}
                {summary.bidStats.mostContestedItem && (
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">
                      Most Contested
                    </p>
                    <p className="font-medium">
                      {summary.bidStats.mostContestedItem.itemName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {summary.bidStats.mostContestedItem.bidCount} bids
                    </p>
                  </div>
                )}
                {mvpSpender && (
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">
                      Biggest Spender
                    </p>
                    <p className="font-medium">{mvpSpender.name}</p>
                    <p className="text-xs text-muted-foreground">
                      ${mvpSpender.spent} spent
                    </p>
                  </div>
                )}
                {mvpCollector && mvpCollector.items.length > 0 && (
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">
                      Most Items Won
                    </p>
                    <p className="font-medium">{mvpCollector.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {mvpCollector.items.length} items
                    </p>
                  </div>
                )}
                {mvpSaver && (
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">
                      Budget Saver
                    </p>
                    <p className="font-medium">{mvpSaver.name}</p>
                    <p className="text-xs text-muted-foreground">
                      ${mvpSaver.budgetRemaining} remaining
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Rosters */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Final Rosters</CardTitle>
            <CardDescription>
              Spending breakdown and items won per bidder
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              {summary.rosters.map((roster) => (
                <div key={roster.participantId} className="rounded-md border p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="font-semibold">{roster.name}</span>
                    <Badge variant="secondary">
                      ${roster.budgetRemaining} left
                    </Badge>
                  </div>

                  {/* Spending bar */}
                  <div className="mb-3">
                    <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                      <span>${roster.spent} spent</span>
                      <span>${roster.budgetStart} budget</span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted">
                      <div
                        className="h-2 rounded-full bg-primary"
                        style={{
                          width: `${Math.min(100, (roster.spent / roster.budgetStart) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Won items */}
                  {roster.items.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No items won
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {roster.items.map((item, i) => (
                        <li
                          key={i}
                          className="flex items-center justify-between text-sm"
                        >
                          <span>{item.name}</span>
                          <span className="text-muted-foreground">
                            ${item.price}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
