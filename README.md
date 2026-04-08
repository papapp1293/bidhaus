# BidHaus

Real-time draft auction rooms for team formation. A host creates a session, configures budgets and timing, adds items, and shares an invite link. Bidders compete live in a single shared room while spectators watch. The result is a set of balanced rosters drafted fairly.

Built to demonstrate distributed-systems patterns end-to-end: server-authoritative real-time state, optimistic concurrency, background job processing, cache-aside reads, and graceful degradation under failure.

![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=flat&logo=socket.io&logoColor=white)
![BullMQ](https://img.shields.io/badge/BullMQ-DC382D?style=flat&logo=redis&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat&logo=redis&logoColor=white)

---

## What it does

A tournament organizer needs four teams of five from twenty people. They create a BidHaus session, add sixteen players as auction items, invite four captains as bidders (each gets a $100 budget), and the rest join as spectators. Items appear one at a time on a server-authoritative timer, captains bid live, the highest bid wins. At the end, BidHaus produces final rosters and a shareable summary.

Same flow works for fantasy sports drafts, charity auctions, classroom team picks, club events — anywhere N items need to be distributed among M bidders in real time.

## Features

- **Live multi-user bidding** — Socket.io rooms with presence tracking, live bid feed, and timer sync across host, bidders, and spectators
- **Server-authoritative timer** — clients render a countdown, but item close is always decided by a delayed BullMQ job, so a stalled tab can't win the auction
- **Multi-round drafts** — items left UNSOLD at the end of round 1 are reset to PENDING and re-auctioned in round 2; a fully silent round triggers auto-distribution
- **True pause / resume** — `host:pause` cancels the expiry job, captures remaining ms in Redis, and freezes every client's countdown; resume reschedules with the captured remainder
- **Bid-driven timer reset** — a configurable floor (e.g. 5s) bumps the timer back up on every successful bid so a last-second bid can't end the auction before others react
- **Even-team enforcement** — optional cap of `⌈items / bidders⌉` per bidder; when only one bidder is still under cap, remaining items auto-award without an auction
- **Optimistic-locked bids** — atomic `WHERE version = X AND currentBid < amount` updates prevent two simultaneous bids from corrupting state
- **Sliding-window rate limiting** — Redis sorted-set rate limiter on bid submissions (per bidder + global IP), with 429 + `Retry-After`
- **Cache-aside reads** — session lookups and active-item state cached in Redis with explicit invalidation on every mutation; falls back to Postgres on Redis failure
- **Reconnection with state sync** — clients receive a `state:sync` snapshot on every reconnect; host disconnect has a 60-second grace period
- **Background job pipeline** — BullMQ queues for item expiry, repeating session cleanup, and post-auction summary generation, with retries and a worker→socket pub/sub bridge
- **Final results page** — rosters, spending breakdowns, highlights (top bid, biggest spender, most items), and a shareable summary
- **Mobile-responsive** — bid panel uses 2-col grid on small screens with min-h-12 touch targets
- **Observability** — pino structured logging with request-scoped correlation IDs and a `/api/metrics` endpoint exposing active sessions, queue depth, cache key count, and bids/min

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, RSC, Server Actions) |
| Language | TypeScript (strict mode) |
| Real-time | Socket.io 4 (with Redis adapter for horizontal scale) |
| Background jobs | BullMQ 5 (delayed + repeatable + pub/sub) |
| Database | PostgreSQL 16 |
| ORM | Prisma 7 (with `@prisma/adapter-pg`) |
| Cache + queues | Redis 7 (ioredis) |
| Validation | Zod 4 |
| Logging | pino + pino-pretty |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Testing | Vitest (unit) + Playwright (e2e) |
| Deployment | Vercel (web) + Railway/Render (Socket.io + worker) |

## Architecture Highlights

- **Three independent processes.** Next.js (HTTP + RSC), a standalone Socket.io server, and a BullMQ worker — each scales independently. Vercel can't host persistent WebSockets, so Socket.io and the worker run on Railway/Render and talk to the Next.js side via Postgres + Redis.
- **Worker → Socket.io pub/sub bridge.** The worker process can't push directly to clients, so when an item expires it publishes the result to a Redis channel that the Socket.io server subscribes to and rebroadcasts. This keeps the timer authoritative even if all clients disconnect.
- **Status-driven, not index-driven.** `advanceToNextItem` queries `WHERE status = 'ACTIVE'` rather than `session.items[currentItemIdx]`, because multi-round flow and even-team auto-skips break positional indexing.
- **Atomic budget + version check.** The bid transaction re-reads the bidder's budget inside the transaction and combines it with the item's version check, preventing both inter-bidder races and same-bidder overspend.
- **Cache invalidation contract.** Every mutation that changes session state explicitly invalidates `CacheKeys.session(code)` and `CacheKeys.activeItem(sessionId)`. Cache writes are best-effort and degrade gracefully if Redis is unreachable.
- **Idempotent BullMQ jobs.** Item-expiry jobs use a unique jobId per schedule (`itemId-timestamp-random`) with a Redis mapping for cancellation, so round-2 expiry can co-exist with a still-completing round-1 job.

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for local Postgres + Redis)

### Setup

```bash
# Install dependencies
npm install

# Start local Postgres + Redis
docker compose up -d

# Set up environment variables
cp .env.example .env
# (defaults in .env.example match docker-compose.yml)

# Apply database schema
npm run db:push

# Generate Prisma client
npm run db:generate
```

### Running the stack

BidHaus runs as **three separate processes**. Open three terminals:

```bash
# Terminal 1 — Next.js (port 3000)
npm run dev

# Terminal 2 — Socket.io server (port 3001)
npm run socket

# Terminal 3 — BullMQ worker
npm run worker
```

Then open [http://localhost:3000](http://localhost:3000).

> **Note:** `socket` and `worker` are `tsx` processes and do **not** hot-reload. Restart them after editing anything in `src/server/`, `src/worker/`, or `src/server/bid-service.ts`.

### Environment Variables

```
DATABASE_URL=postgresql://bidhaus:bidhaus@localhost:5433/bidhaus
REDIS_URL=redis://localhost:6379
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
```

### Commands

```bash
npm run dev          # Next.js dev server
npm run build        # Production build
npm run socket       # Socket.io server
npm run worker       # BullMQ worker
npm run test         # Vitest unit tests
npm run test:e2e     # Playwright e2e
npm run db:push      # Sync schema to DB
npm run db:migrate   # Create + apply migration
npm run db:studio    # Prisma Studio GUI
npm run lint         # ESLint
```

## Auction Flow

1. Host creates a session, configures budget per bidder, time per item, optional bid-reset-time floor, and even-team cap toggle
2. Host adds items (single, bulk paste, shuffle, reorder)
3. Host shares the invite link
4. Participants join the lobby and pick a role (bidder gets a budget, spectator just watches)
5. Host starts the auction → first item activates, BullMQ schedules its expiry, all clients see `item:start`
6. Bidders submit bids via socket → server validates atomically → broadcasts `bid:new` and updates rosters
7. Item timer expires (or host force-closes) → worker awards to highest bidder, deducts budget, schedules next item
8. End of round: if any items went UNSOLD with no bids in the round, auto-distribute and complete; if some items went UNSOLD but bids happened, restart with those items in round 2
9. Session completes → all clients auto-redirect to the results page with rosters, stats, and a shareable summary

The full set of authoritative behavioral rules is documented in [`CLAUDE.md`](./CLAUDE.md) under "Auction Flow Rules".

## Tests

```bash
npm run test        # 48 Vitest unit tests (bid-service, rate-limiter, cache, timer-service)
npm run test:e2e    # Playwright e2e smoke tests
```

Unit tests mock Redis and Prisma. E2e tests cover the landing page, session creation, results page, and metrics endpoint.

## Project Structure

```
src/
├── app/
│   ├── session/
│   │   ├── create/page.tsx          # Session setup form
│   │   └── [code]/
│   │       ├── page.tsx             # Join page
│   │       ├── lobby/page.tsx       # Pre-auction lobby with presence
│   │       ├── live/page.tsx        # Live auction view
│   │       └── results/page.tsx     # Final rosters + stats
│   └── api/
│       ├── sessions/                # Session + item + bid + control + results routes
│       └── metrics/route.ts         # Health + metrics endpoint
├── components/
│   ├── BidPanel.tsx                 # Quick-bid + custom bid input
│   ├── BidFeed.tsx                  # Scrolling live bid log
│   ├── CountdownTimer.tsx           # Server-synced countdown with pause support
│   ├── RosterView.tsx               # Bidder rosters with budgets
│   ├── ItemManager.tsx              # Host item CRUD
│   └── ui/                          # shadcn/ui primitives
├── server/
│   ├── bid-service.ts               # Bid validation, optimistic lock, award, advance
│   ├── timer-service.ts             # Server-authoritative timer w/ Redis pause/resume
│   ├── session-service.ts           # Session CRUD + join logic
│   ├── socket.ts                    # Socket.io server, rooms, events, worker bridge
│   ├── queue.ts                     # BullMQ queue definitions + helpers
│   ├── cache.ts                     # Redis cache-aside service
│   ├── rate-limiter.ts              # Sliding-window rate limiter
│   ├── db.ts                        # Prisma client singleton
│   └── redis.ts                     # ioredis client singleton
├── worker/
│   ├── index.ts                     # Worker entry point
│   └── jobs/
│       ├── item-expiry.ts           # Delayed item timer expiry
│       ├── session-cleanup.ts       # Repeatable stale session cleanup
│       └── results-summary.ts       # Post-auction summary generation
├── hooks/
│   └── useSocket.ts                 # Socket.io client lifecycle + auto-reconnect
└── lib/
    ├── constants.ts                 # Defaults (timer, budget, limits)
    ├── validators.ts                # Zod schemas
    ├── logger.ts                    # pino structured logger
    ├── tracing.ts                   # Correlation ID helpers
    └── invite-codes.ts              # Code + token generation
```

## Deployment

- **Web (Next.js):** Vercel. Set `DATABASE_URL`, `REDIS_URL`, and `NEXT_PUBLIC_SOCKET_URL` (pointing at the Socket.io host).
- **Socket.io server:** Railway, Render, or Fly. Same env vars; expose port 3001. Set `NEXT_PUBLIC_SOCKET_URL` on Vercel to this host.
- **BullMQ worker:** same platform as Socket.io. Same env vars. No exposed port.
- **Postgres:** Supabase, Neon, Railway, or any managed Postgres.
- **Redis:** Upstash, Railway, or any managed Redis (must support pub/sub for the worker bridge).

Vercel does not support persistent WebSocket connections, which is why Socket.io and the worker run separately.
