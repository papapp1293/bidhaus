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
import { ItemManager } from "@/components/ItemManager";

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
  items: {
    id: string;
    name: string;
    description?: string | null;
    minBid: number;
    order: number;
  }[];
};

export default function LobbyPage() {
  const params = useParams<{ code: string }>();
  const code = params.code;

  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [hostToken, setHostToken] = useState<string | null>(null);

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

    const token = sessionStorage.getItem(`host:${code}`);
    if (token) {
      setIsHost(true);
      setHostToken(token);
    }

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
          </CardContent>
        </Card>

        {isHost && hostToken && (
          <ItemManager
            sessionCode={code}
            hostToken={hostToken}
            items={session.items}
            onItemsChange={fetchSession}
          />
        )}

        {!isHost && session.items.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Items ({session.items.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-1">
                {session.items.map((item, idx) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <span className="text-muted-foreground w-6 text-right">
                      {idx + 1}.
                    </span>
                    <span>{item.name}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <p className="text-center text-sm text-muted-foreground">
          {session.items.length} item{session.items.length !== 1 && "s"} ready
          &middot; Waiting for host to start auction
        </p>
      </div>
    </div>
  );
}
