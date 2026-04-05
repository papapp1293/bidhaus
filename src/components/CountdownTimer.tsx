"use client";

import { useState, useEffect, useRef } from "react";

export function CountdownTimer({
  endsAt,
  serverRemainingMs,
}: {
  endsAt: string | null;
  serverRemainingMs?: number;
}) {
  const [remaining, setRemaining] = useState(0);
  const endTimeRef = useRef<number>(0);

  // Sync with server time
  useEffect(() => {
    if (serverRemainingMs !== undefined) {
      endTimeRef.current = Date.now() + serverRemainingMs;
    }
  }, [serverRemainingMs]);

  // Set end time from endsAt prop
  useEffect(() => {
    if (endsAt) {
      endTimeRef.current = new Date(endsAt).getTime();
    }
  }, [endsAt]);

  // Tick every 100ms
  useEffect(() => {
    const tick = () => {
      const r = Math.max(0, endTimeRef.current - Date.now());
      setRemaining(r);
    };

    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, []);

  const seconds = Math.ceil(remaining / 1000);
  const isUrgent = seconds <= 5 && seconds > 0;

  return (
    <div
      className={`text-center text-4xl font-bold tabular-nums ${
        isUrgent
          ? "text-destructive animate-pulse"
          : remaining === 0
            ? "text-muted-foreground"
            : "text-foreground"
      }`}
    >
      {remaining === 0 ? "TIME" : `${seconds}s`}
    </div>
  );
}
