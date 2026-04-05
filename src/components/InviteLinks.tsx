"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function InviteLinks({ code }: { code: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "";
  const link = `${baseUrl}/session/${code}`;

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="flex flex-col gap-3">
      <Label>Invite Link</Label>
      <div className="flex gap-2">
        <Input value={link} readOnly className="font-mono text-sm" />
        <Button
          variant="outline"
          onClick={() => copy(link, "link")}
        >
          {copied === "link" ? "Copied!" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Share this link with bidders and spectators. They&apos;ll choose their
        role when joining.
      </p>
    </div>
  );
}
