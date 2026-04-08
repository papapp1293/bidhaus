"use client";

import { useState, useEffect, useRef } from "react";

export function CountdownTimer({
  endsAt,
  serverRemainingMs,
  paused = false,
}: {
  endsAt: string | null;
  serverRemainingMs?: number;
  paused?: boolean;
}) {
  const [remaining, setRemaining] = useState(0);
  const endTimeRef = useRef<number>(0);

  // Sync with server time
  useEffect(() => {
    if (serverRemainingMs !== undefined) {
      endTimeRef.current = Date.now() + serverRemainingMs;
      if (paused) setRemaining(serverRemainingMs);
    }
  }, [serverRemainingMs, paused]);

  // Set end time from endsAt prop
  useEffect(() => {
    if (endsAt) {
      endTimeRef.current = new Date(endsAt).getTime();
      if (paused) {
        setRemaining(Math.max(0, endTimeRef.current - Date.now()));
      }
    }
  }, [endsAt, paused]);

  // Tick every 100ms (skipped while paused)
  useEffect(() => {
    if (paused) return;
    const tick = () => {
      const r = Math.max(0, endTimeRef.current - Date.now());
      setRemaining(r);
    };

    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [paused]);

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
