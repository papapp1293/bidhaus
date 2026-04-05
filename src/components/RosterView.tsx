"use client";

import { Badge } from "@/components/ui/badge";

type WonItem = {
  id: string;
  name: string;
  currentBid: number | null;
};

type BidderRoster = {
  name: string;
  budget: number | null;
  wonItems: WonItem[];
};

export function RosterView({ bidders }: { bidders: BidderRoster[] }) {
  return (
    <div className="flex flex-col gap-3">
      {bidders.map((bidder) => (
        <div key={bidder.name} className="rounded-md border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium">{bidder.name}</span>
            <Badge variant="secondary">${bidder.budget ?? 0} left</Badge>
          </div>
          {bidder.wonItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No items won yet</p>
          ) : (
            <ul className="flex flex-wrap gap-1">
              {bidder.wonItems.map((item) => (
                <li key={item.id}>
                  <Badge variant="outline">
                    {item.name} (${item.currentBid})
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
