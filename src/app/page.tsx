"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <main className="flex max-w-xl flex-col items-center gap-8 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          BidHaus
        </h1>
        <p className="text-lg text-muted-foreground">
          Live draft auction rooms for team formation. Create a session, invite
          bidders, and auction items in real-time.
        </p>
        <Link
          href="/session/create"
          className={buttonVariants({ size: "lg" })}
        >
          Create Session
        </Link>
      </main>
    </div>
  );
}
