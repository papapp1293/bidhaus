"use client";

import { useRef, useEffect } from "react";

type BidEntry = {
  participantName: string;
  amount: number;
  itemId: string;
  timestamp: string;
};

export function BidFeed({ bids }: { bids: BidEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [bids]);

  return (
    <div
      ref={scrollRef}
      className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-3"
    >
      {bids.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bids yet</p>
      ) : (
        bids.map((bid, i) => (
          <div key={i} className="flex items-baseline justify-between text-sm">
            <span className="font-medium">{bid.participantName}</span>
            <span className="font-bold">${bid.amount}</span>
          </div>
        ))
      )}
    </div>
  );
}
