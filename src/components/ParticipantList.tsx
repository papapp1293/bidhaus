"use client";

import { Badge } from "@/components/ui/badge";

type Participant = {
  id: string;
  name: string;
  role: "BIDDER" | "SPECTATOR";
  budget: number | null;
  connected: boolean;
};

export function ParticipantList({
  participants,
}: {
  participants: Participant[];
}) {
  const bidders = participants.filter((p) => p.role === "BIDDER");
  const spectators = participants.filter((p) => p.role === "SPECTATOR");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-2 text-sm font-medium">
          Bidders ({bidders.length})
        </h3>
        {bidders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No bidders yet
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {bidders.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span>{p.name}</span>
                <Badge variant="secondary">${p.budget}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {spectators.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">
            Spectators ({spectators.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {spectators.map((p) => (
              <li
                key={p.id}
                className="rounded-md border px-3 py-2 text-sm"
              >
                {p.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
