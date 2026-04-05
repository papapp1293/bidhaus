"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InviteLinks } from "@/components/InviteLinks";
import { ParticipantList } from "@/components/ParticipantList";
import { ItemManager } from "@/components/ItemManager";
import { useSocket } from "@/hooks/useSocket";

type Participant = {
  id: string;
  name: string;
  role: "BIDDER" | "SPECTATOR";
  budget: number | null;
  connected: boolean;
};

type SessionData = {
  id: string;
  code: string;
  name: string;
  status: string;
  budgetPerBidder: number;
  timePerItem: number;
  hostName: string;
  participants: Participant[];
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
  const router = useRouter();
  const code = params.code;

  const [session, setSession] = useState<SessionData | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [hostToken, setHostToken] = useState<string | null>(null);

  // Get token for socket connection
  const [socketToken, setSocketToken] = useState<string | null>(null);
  const { connected, on } = useSocket(code, socketToken);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${code}`);
      if (!res.ok) {
        setError("Session not found");
        return;
      }
      const data = await res.json();
      setSession(data);
      setParticipants(data.participants);
    } catch {
      setError("Failed to load session");
    }
  }, [code]);

  useEffect(() => {
    fetchSession();

    const hToken = sessionStorage.getItem(`host:${code}`);
    if (hToken) {
      setIsHost(true);
      setHostToken(hToken);
    }

    // Use participant token for socket if available, otherwise fall back to polling
    const pToken = sessionStorage.getItem(`participant:${code}`);
    if (pToken) {
      setSocketToken(pToken);
    }
  }, [code, fetchSession]);

  // Listen for real-time presence updates
  useEffect(() => {
    if (!connected) return;

    const unsub = on("presence:update", (data) => {
      setParticipants(data.participants as Participant[]);
    });

    return unsub;
  }, [connected, on]);

  // Fall back to polling if not connected via WebSocket
  useEffect(() => {
    if (connected) return;

    const interval = setInterval(fetchSession, 3000);
    return () => clearInterval(interval);
  }, [connected, fetchSession]);

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
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{session.name}</CardTitle>
                <CardDescription>
                  Hosted by {session.hostName} &middot; $
                  {session.budgetPerBidder} budget &middot;{" "}
                  {session.timePerItem}s per item
                </CardDescription>
              </div>
              <Badge variant={connected ? "default" : "secondary"}>
                {connected ? "Live" : "Polling"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {isHost && <InviteLinks code={code} />}
            <ParticipantList participants={participants} />
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

        {isHost && hostToken && session.items.length > 0 && (
          <Button
            size="lg"
            className="w-full"
            onClick={async () => {
              const res = await fetch(`/api/sessions/${code}/control`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: hostToken, action: "start" }),
              });
              if (res.ok) {
                router.push(`/session/${code}/live`);
              }
            }}
          >
            Start Auction
          </Button>
        )}

        <p className="text-center text-sm text-muted-foreground">
          {session.items.length} item{session.items.length !== 1 && "s"} ready
          {isHost && session.items.length > 0
            ? ""
            : " \u00B7 Waiting for host to start auction"}
        </p>
      </div>
    </div>
  );
}
