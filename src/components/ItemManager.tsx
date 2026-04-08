"use client";

import { useState, useCallback } from "react";
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

type Item = {
  id: string;
  name: string;
  description?: string | null;
  minBid: number;
  order: number;
};

export function ItemManager({
  sessionCode,
  hostToken,
  items: initialItems,
  onItemsChange,
}: {
  sessionCode: string;
  hostToken: string;
  items: Item[];
  onItemsChange: () => void;
}) {
  const [items, setItems] = useState<Item[]>(initialItems);
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [itemName, setItemName] = useState("");
  const [minBid, setMinBid] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers = {
    "Content-Type": "application/json",
    "x-host-token": hostToken,
  };

  // Sync items from parent when they change
  const syncItems = useCallback(
    (newItems: Item[]) => {
      setItems(newItems);
      onItemsChange();
    },
    [onItemsChange]
  );

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!itemName.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/sessions/${sessionCode}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: itemName.trim(), minBid }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error);
        return;
      }

      const item = await res.json();
      syncItems([...items, item]);
      setItemName("");
      setMinBid(1);
    } catch {
      setError("Failed to add item");
    } finally {
      setLoading(false);
    }
  }

  async function bulkAdd() {
    const names = bulkText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/sessions/${sessionCode}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          items: names.map((name) => ({ name, minBid: 1 })),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error);
        return;
      }

      const newItems = await res.json();
      syncItems([...items, ...newItems]);
      setBulkText("");
      setShowBulk(false);
    } catch {
      setError("Failed to add items");
    } finally {
      setLoading(false);
    }
  }

  async function removeItem(itemId: string) {
    try {
      const res = await fetch(
        `/api/sessions/${sessionCode}/items?itemId=${itemId}`,
        { method: "DELETE", headers }
      );

      if (!res.ok) return;

      const updated = items
        .filter((i) => i.id !== itemId)
        .map((i, idx) => ({ ...i, order: idx }));
      syncItems(updated);
    } catch {
      // ignore
    }
  }

  async function shuffleItems() {
    // Fisher-Yates shuffle (Math.random()-0.5 is biased and often produces no visible change)
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const orderedIds = shuffled.map((i) => i.id);

    try {
      const res = await fetch(`/api/sessions/${sessionCode}/items`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ orderedIds }),
      });

      if (!res.ok) return;

      syncItems(shuffled.map((i, idx) => ({ ...i, order: idx })));
    } catch {
      // ignore
    }
  }

  async function moveItem(index: number, direction: "up" | "down") {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= items.length) return;

    const reordered = [...items];
    [reordered[index], reordered[newIndex]] = [
      reordered[newIndex],
      reordered[index],
    ];
    const orderedIds = reordered.map((i) => i.id);

    try {
      const res = await fetch(`/api/sessions/${sessionCode}/items`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ orderedIds }),
      });

      if (!res.ok) return;

      syncItems(reordered.map((i, idx) => ({ ...i, order: idx })));
    } catch {
      // ignore
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Items ({items.length})</CardTitle>
        <CardDescription>
          Add items to auction. Reorder or shuffle before starting.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Add single item */}
        {!showBulk && (
          <form onSubmit={addItem} className="flex gap-2">
            <Input
              placeholder="Item name"
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              className="flex-1"
            />
            <Input
              type="number"
              min={1}
              value={minBid}
              onChange={(e) => setMinBid(Number(e.target.value))}
              className="w-20"
              title="Min bid"
            />
            <Button type="submit" disabled={loading || !itemName.trim()}>
              Add
            </Button>
          </form>
        )}

        {/* Bulk add */}
        {showBulk && (
          <div className="flex flex-col gap-2">
            <Label>Paste items (one per line)</Label>
            <textarea
              className="min-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={"Player 1\nPlayer 2\nPlayer 3"}
            />
            <div className="flex gap-2">
              <Button onClick={bulkAdd} disabled={loading || !bulkText.trim()}>
                {loading ? "Adding..." : "Add All"}
              </Button>
              <Button variant="outline" onClick={() => setShowBulk(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {!showBulk && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowBulk(true)}
            >
              Bulk Add
            </Button>
          )}
          {items.length > 1 && (
            <Button variant="outline" size="sm" onClick={shuffleItems}>
              Shuffle
            </Button>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Item list */}
        {items.length > 0 && (
          <ul className="flex flex-col gap-1">
            {items.map((item, idx) => (
              <li
                key={item.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground w-6 text-right">
                    {idx + 1}.
                  </span>
                  <span>{item.name}</span>
                  {item.minBid > 1 && (
                    <span className="text-muted-foreground">
                      (min ${item.minBid})
                    </span>
                  )}
                </span>
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => moveItem(idx, "up")}
                    disabled={idx === 0}
                  >
                    &uarr;
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => moveItem(idx, "down")}
                    disabled={idx === items.length - 1}
                  >
                    &darr;
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => removeItem(item.id)}
                  >
                    &times;
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
