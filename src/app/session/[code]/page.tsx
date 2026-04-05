"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type SessionInfo = {
  name: string;
  status: string;
  budgetPerBidder: number;
};

export default function JoinPage() {
  const router = useRouter();
  const params = useParams<{ code: string }>();
  const code = params.code;

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"BIDDER" | "SPECTATOR">("BIDDER");

  useEffect(() => {
    fetch(`/api/sessions/${code}`)
      .then((res) => {
        if (!res.ok) throw new Error("Session not found");
        return res.json();
      })
      .then((data) => setSession(data))
      .catch(() => setError("Session not found"))
      .finally(() => setFetching(false));
  }, [code]);

  async function handleJoin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const form = new FormData(e.currentTarget);
    const body = {
      name: form.get("name") as string,
      role,
    };

    try {
      const res = await fetch(`/api/sessions/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to join");
        return;
      }

      const data = await res.json();
      sessionStorage.setItem(`participant:${code}`, data.token);
      router.push(`/session/${code}/lobby`);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  if (fetching) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">Loading session...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-destructive">Session not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{session.name}</CardTitle>
          <CardDescription>
            Join as a bidder (${session.budgetPerBidder} budget) or spectator
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleJoin} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Your Name</Label>
              <Input
                id="name"
                name="name"
                placeholder="Enter your name"
                required
                maxLength={50}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Role</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={role === "BIDDER" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setRole("BIDDER")}
                >
                  Bidder
                </Button>
                <Button
                  type="button"
                  variant={role === "SPECTATOR" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setRole("SPECTATOR")}
                >
                  Spectator
                </Button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button type="submit" disabled={loading}>
              {loading ? "Joining..." : "Join Session"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
