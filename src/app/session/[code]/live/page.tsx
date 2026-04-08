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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CountdownTimer } from "@/components/CountdownTimer";
import { BidPanel } from "@/components/BidPanel";
import { BidFeed } from "@/components/BidFeed";
import { RosterView } from "@/components/RosterView";
import { useSocket } from "@/hooks/useSocket";

type CurrentItem = {
  id: string;
  name: string;
  description?: string | null;
  minBid: number;
  order: number;
};

type BidEntry = {
  participantName: string;
  amount: number;
  itemId: string;
  timestamp: string;
};

type WonItem = {
  id: string;
  name: string;
  currentBid: number | null;
};

type Participant = {
  id: string;
  name: string;
  role: string;
  budget: number | null;
  connected: boolean;
  wonItems?: WonItem[];
};

export default function LivePage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = params.code;

  const [isHost, setIsHost] = useState(false);
  const [hostToken, setHostToken] = useState<string | null>(null);
  const [participantToken, setParticipantToken] = useState<string | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [myBudget, setMyBudget] = useState<number>(0);

  const [currentItem, setCurrentItem] = useState<CurrentItem | null>(null);
  const [currentBid, setCurrentBid] = useState<number | null>(null);
  const [endsAt, setEndsAt] = useState<string | null>(null);
  const [serverRemainingMs, setServerRemainingMs] = useState<number | undefined>();
  const [bids, setBids] = useState<BidEntry[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string>("LIVE");
  const [lastEvent, setLastEvent] = useState<string>("");
  const [round, setRound] = useState<number>(1);

  const socketToken = participantToken ?? hostToken;
  const { connected, emit, on } = useSocket(code, socketToken);

  // Initialize tokens
  useEffect(() => {
    const hToken = sessionStorage.getItem(`host:${code}`);
    const pToken = sessionStorage.getItem(`participant:${code}`);
    const pId = sessionStorage.getItem(`participantId:${code}`);

    if (hToken) {
      setIsHost(true);
      setHostToken(hToken);
    }
    if (pToken) {
      setParticipantToken(pToken);
    }
    if (pId) {
      setParticipantId(pId);
    }

    // Fetch initial session state
    fetch(`/api/sessions/${code}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "LOBBY") {
          router.push(`/session/${code}/lobby`);
          return;
        }
        if (data.status === "COMPLETED") {
          router.push(`/session/${code}/results`);
          return;
        }
        setSessionStatus(data.status);
        setParticipants(data.participants);

        // Find current active item by status (items can re-cycle across rounds)
        const activeItem = (data.items as Array<{ status: string; currentBid: number | null } & CurrentItem>).find(
          (i) => i.status === "ACTIVE"
        );
        if (activeItem) {
          setCurrentItem(activeItem);
          setCurrentBid(activeItem.currentBid);
        }

        // Find self by participantId
        if (pId) {
          const me = data.participants.find(
            (p: Participant) => p.id === pId
          );
          if (me) {
            setRole(me.role);
            setMyBudget(me.budget ?? 0);
          }
        }
      });
  }, [code, router]);

  // Socket event listeners
  useEffect(() => {
    if (!connected) return;

    const unsubs = [
      on("state:sync", (data) => {
        setSessionStatus(data.sessionStatus);
        setParticipants(data.participants as Participant[]);
        setLastEvent("");
        if (data.currentItem) {
          setCurrentItem(data.currentItem);
          setCurrentBid(data.currentItem.currentBid);
          setEndsAt(data.endsAt);
        }
        if (participantId) {
          const me = data.participants.find((p) => p.id === participantId);
          if (me) {
            setRole(me.role);
            if (me.budget !== null) setMyBudget(me.budget);
          }
        }
        if (data.sessionStatus === "COMPLETED") {
          router.push(`/session/${code}/results`);
        }
      }),
      on("item:start", (data) => {
        setCurrentItem(data.item);
        setEndsAt(data.endsAt);
        setCurrentBid(null);
        setBids([]);
        setLastEvent("");
      }),
      on("bid:new", (data) => {
        setBids((prev) => [...prev, data]);
        setCurrentBid(data.amount);
      }),
      on("bid:rejected", (data) => {
        setLastEvent(`Bid rejected: ${data.reason}`);
      }),
      on("timer:sync", (data) => {
        setServerRemainingMs(data.remainingMs);
        if (data.endsAt) setEndsAt(data.endsAt);
      }),
      on("item:sold", (data) => {
        setLastEvent(`Sold to ${data.winner} for $${data.amount}!`);
        setCurrentItem(null);
      }),
      on("item:unsold", () => {
        setLastEvent("Item went unsold");
        setCurrentItem(null);
      }),
      on("session:paused", (data) => {
        setSessionStatus("PAUSED");
        if (data?.remainingMs !== undefined) {
          setServerRemainingMs(data.remainingMs);
          // Freeze the displayed timer at the paused remaining
          setEndsAt(new Date(Date.now() + data.remainingMs).toISOString());
        }
      }),
      on("session:resumed", (data) => {
        setSessionStatus("LIVE");
        if (data?.endsAt) {
          setEndsAt(data.endsAt);
          setServerRemainingMs(data.remainingMs);
        }
      }),
      on("session:completed", () => {
        setSessionStatus("COMPLETED");
        router.push(`/session/${code}/results`);
      }),
      on("round:restarted", () => {
        setRound((r) => r + 1);
        setLastEvent("New round: unsold items are back on the block");
      }),
      on("presence:update", (data) => {
        setParticipants(data.participants as Participant[]);
        if (participantId) {
          const me = data.participants.find((p) => p.id === participantId);
          if (me && me.budget !== null) {
            setMyBudget(me.budget);
          }
        }
      }),
    ];

    return () => unsubs.forEach((u) => u());
  }, [connected, on, code, router, participantId]);

  const handleBid = useCallback(
    (amount: number) => {
      if (!currentItem || !participantToken) return;
      emit("bid:place", {
        itemId: currentItem.id,
        amount,
        token: participantToken,
      });
    },
    [currentItem, participantToken, emit]
  );

  const handleHostAction = useCallback(
    (action: "host:start" | "host:pause" | "host:resume" | "host:skip" | "host:close-item") => {
      if (!hostToken) return;
      emit(action, { token: hostToken });
    },
    [hostToken, emit]
  );

  const bidders = participants.filter((p) => p.role === "BIDDER");
  const isBidder = role === "BIDDER";

  return (
    <div className="flex flex-1 justify-center px-3 py-4 sm:px-4 sm:py-6">
      <div className="flex w-full max-w-4xl flex-col gap-4 lg:flex-row">
        {/* Main auction area */}
        <div className="flex flex-1 flex-col gap-4">
          {/* Status bar */}
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold">Live Auction</h1>
            <div className="flex items-center gap-2">
              {round > 1 && (
                <Badge variant="outline">Round {round}</Badge>
              )}
              <Badge variant={connected ? "default" : "secondary"}>
                {connected ? "Online" : "Reconnecting..."}
              </Badge>
              <Badge
                variant={
                  sessionStatus === "PAUSED" ? "destructive" : "secondary"
                }
              >
                {sessionStatus}
              </Badge>
            </div>
          </div>

          {/* Current item */}
          <Card>
            <CardHeader>
              <CardTitle>
                {currentItem
                  ? `#${currentItem.order + 1}: ${currentItem.name}`
                  : "Waiting for next item..."}
              </CardTitle>
              {currentItem?.description && (
                <CardDescription>{currentItem.description}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {currentItem && (
                <>
                  <CountdownTimer
                    endsAt={endsAt}
                    serverRemainingMs={serverRemainingMs}
                    paused={sessionStatus === "PAUSED"}
                  />

                  {isBidder && sessionStatus === "LIVE" && (
                    <BidPanel
                      currentBid={currentBid}
                      minBid={currentItem.minBid}
                      budget={myBudget}
                      onBid={handleBid}
                      disabled={sessionStatus !== "LIVE"}
                    />
                  )}
                </>
              )}

              {lastEvent && (
                <p className="text-center text-sm font-medium">{lastEvent}</p>
              )}

              {/* Host controls */}
              {isHost && (
                <div className="flex flex-wrap gap-2 border-t pt-4">
                  {sessionStatus === "LIVE" && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => handleHostAction("host:pause")}
                        className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                      >
                        Pause
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => handleHostAction("host:close-item")}
                        className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                      >
                        Close Item
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => handleHostAction("host:skip")}
                        className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                      >
                        Skip
                      </Button>
                    </>
                  )}
                  {sessionStatus === "PAUSED" && (
                    <Button
                      variant="outline"
                      onClick={() => handleHostAction("host:resume")}
                      className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                    >
                      Resume
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Bid feed */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bid History</CardTitle>
            </CardHeader>
            <CardContent>
              <BidFeed bids={bids} />
            </CardContent>
          </Card>
        </div>

        {/* Sidebar — rosters */}
        <div className="w-full lg:w-72">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Rosters</CardTitle>
            </CardHeader>
            <CardContent>
              <RosterView
                bidders={bidders.map((b) => ({
                  name: b.name,
                  budget: b.budget,
                  wonItems: b.wonItems ?? [],
                }))}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
