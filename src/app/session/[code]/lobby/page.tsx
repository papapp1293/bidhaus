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
import { InviteLinks } from "@/components/InviteLinks";
import { ParticipantList } from "@/components/ParticipantList";

type SessionData = {
  id: string;
  code: string;
  name: string;
  status: string;
  budgetPerBidder: number;
  timePerItem: number;
  hostName: string;
  participants: {
    id: string;
    name: string;
    role: "BIDDER" | "SPECTATOR";
    budget: number | null;
    connected: boolean;
    joinedAt: string;
  }[];
  items: { id: string; name: string; order: number }[];
};

export default function LobbyPage() {
  const params = useParams<{ code: string }>();
  const code = params.code;

  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${code}`);
      if (!res.ok) {
        setError("Session not found");
        return;
      }
      const data = await res.json();
      setSession(data);
    } catch {
      setError("Failed to load session");
    }
  }, [code]);

  useEffect(() => {
    fetchSession();
    // Poll for updates until we have WebSocket (Step 4)
    const interval = setInterval(fetchSession, 3000);

    // Check if current user is the host
    const hostToken = sessionStorage.getItem(`host:${code}`);
    if (hostToken) setIsHost(true);

    return () => clearInterval(interval);
  }, [code, fetchSession]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">Loading lobby...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 justify-center px-4 py-12">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{session.name}</CardTitle>
            <CardDescription>
              Hosted by {session.hostName} &middot; ${session.budgetPerBidder}{" "}
              budget &middot; {session.timePerItem}s per item
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {isHost && <InviteLinks code={code} />}

            <ParticipantList participants={session.participants} />

            <div className="text-sm text-muted-foreground">
              {session.items.length} item{session.items.length !== 1 && "s"}{" "}
              ready &middot; Waiting for host to start auction
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
