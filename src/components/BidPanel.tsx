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

      {/* Quick bid buttons — large touch targets on mobile */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {quickBids.map((amount) => (
          <Button
            key={amount}
            variant="outline"
            disabled={disabled || amount > budget}
            onClick={() => onBid(amount)}
            className="min-h-12 text-base sm:min-h-9 sm:text-sm"
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
          className="min-h-12 flex-1 text-base sm:min-h-9 sm:text-sm"
        />
        <Button
          disabled={disabled || customAmount < nextMin || customAmount > budget}
          onClick={() => onBid(customAmount)}
          className="min-h-12 text-base sm:min-h-9 sm:text-sm"
        >
          Bid ${customAmount}
        </Button>
      </div>
    </div>
  );
}
