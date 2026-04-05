"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { DEFAULT_BUDGET, DEFAULT_TIME_PER_ITEM } from "@/lib/constants";

export default function CreateSessionPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const form = new FormData(e.currentTarget);
    const body = {
      name: form.get("name") as string,
      hostName: form.get("hostName") as string,
      budgetPerBidder: Number(form.get("budgetPerBidder")),
      timePerItem: Number(form.get("timePerItem")),
    };

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to create session");
        return;
      }

      const data = await res.json();
      // Store host token in sessionStorage
      sessionStorage.setItem(`host:${data.code}`, data.hostToken);
      router.push(`/session/${data.code}/lobby`);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create Session</CardTitle>
          <CardDescription>
            Set up a new draft auction room
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Session Name</Label>
              <Input
                id="name"
                name="name"
                placeholder="Friday Night Draft"
                required
                maxLength={100}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="hostName">Your Name (Host)</Label>
              <Input
                id="hostName"
                name="hostName"
                placeholder="Alex"
                required
                maxLength={50}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="budgetPerBidder">Budget per Bidder</Label>
                <Input
                  id="budgetPerBidder"
                  name="budgetPerBidder"
                  type="number"
                  min={1}
                  max={10000}
                  defaultValue={DEFAULT_BUDGET}
                  required
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="timePerItem">Time per Item (s)</Label>
                <Input
                  id="timePerItem"
                  name="timePerItem"
                  type="number"
                  min={5}
                  max={300}
                  defaultValue={DEFAULT_TIME_PER_ITEM}
                  required
                />
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create Session"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
