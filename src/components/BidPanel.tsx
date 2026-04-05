"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function BidPanel({
  currentBid,
  minBid,
  budget,
  onBid,
  disabled,
}: {
  currentBid: number | null;
  minBid: number;
  budget: number;
  onBid: (amount: number) => void;
  disabled: boolean;
}) {
  const nextMin = currentBid ? currentBid + 1 : minBid;
  const [customAmount, setCustomAmount] = useState(nextMin);

  // Quick-bid amounts
  const quickBids = [
    nextMin,
    nextMin + 5,
    nextMin + 10,
    nextMin + 25,
  ].filter((a) => a <= budget);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Current: <span className="font-bold text-foreground">${currentBid ?? "—"}</span>
        </span>
        <span className="text-muted-foreground">
          Budget: <span className="font-bold text-foreground">${budget}</span>
        </span>
      </div>

      {/* Quick bid buttons */}
      <div className="grid grid-cols-4 gap-2">
        {quickBids.map((amount) => (
          <Button
            key={amount}
            variant="outline"
            size="sm"
            disabled={disabled || amount > budget}
            onClick={() => onBid(amount)}
          >
            ${amount}
          </Button>
        ))}
      </div>

      {/* Custom bid */}
      <div className="flex gap-2">
        <Input
          type="number"
          min={nextMin}
          max={budget}
          value={customAmount}
          onChange={(e) => setCustomAmount(Number(e.target.value))}
          className="flex-1"
        />
        <Button
          disabled={disabled || customAmount < nextMin || customAmount > budget}
          onClick={() => onBid(customAmount)}
        >
          Bid ${customAmount}
        </Button>
      </div>
    </div>
  );
}
