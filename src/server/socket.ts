import { Server as SocketServer } from "socket.io";
import type { Server as HttpServer } from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { prisma } from "./db";
import { logger } from "@/lib/logger";
import { placeBid, awardItem, advanceToNextItem } from "./bid-service";
import {
  startItemTimer,
  getTimerEnd,
  clearTimer,
  getRemainingMs,
  TIMER_SYNC_INTERVAL_MS,
} from "./timer-service";
import {
  scheduleItemExpiryJob,
  cancelItemExpiryJob,
  enqueueResultsSummary,
} from "./queue";
import { ITEM_EXPIRY_CHANNEL } from "@/worker/jobs/item-expiry";
import { cacheInvalidate, CacheKeys } from "./cache";
import { HOST_DISCONNECT_GRACE_MS } from "@/lib/constants";

export type ServerToClientEvents = {
  "bid:new": (data: {
    participantName: string;
    amount: number;
    itemId: string;
    timestamp: string;
  }) => void;
  "bid:rejected": (data: { reason: string }) => void;
  "item:start": (data: {
    item: { id: string; name: string; description?: string | null; minBid: number; order: number };
    endsAt: string;
  }) => void;
  "item:sold": (data: {
    itemId: string;
    winner: string;
    amount: number;
  }) => void;
  "item:unsold": (data: { itemId: string }) => void;
  "timer:sync": (data: { remainingMs: number }) => void;
  "session:started": () => void;
  "session:paused": () => void;
  "session:resumed": () => void;
  "session:completed": (data: { results: unknown }) => void;
  "state:sync": (data: {
    sessionStatus: string;
    currentItem: {
      id: string;
      name: string;
      description?: string | null;
      minBid: number;
      order: number;
      currentBid: number | null;
    } | null;
    endsAt: string | null;
    participants: {
      id: string;
      name: string;
      role: string;
      budget: number | null;
      connected: boolean;
    }[];
  }) => void;
  "participant:joined": (data: { name: string; role: string }) => void;
  "participant:left": (data: { name: string }) => void;
  "presence:update": (data: {
    participants: {
      id: string;
      name: string;
      role: string;
      budget: number | null;
      connected: boolean;
    }[];
  }) => void;
};

export type ClientToServerEvents = {
  "bid:place": (data: {
    itemId: string;
    amount: number;
    token: string;
  }) => void;
  "host:start": (data: { token: string }) => void;
  "host:pause": (data: { token: string }) => void;
  "host:resume": (data: { token: string }) => void;
  "host:skip": (data: { token: string }) => void;
  "host:close-item": (data: { token: string }) => void;
  "participant:join": (data: {
    sessionCode: string;
    token: string;
  }) => void;
  "participant:ping": (data: { token: string }) => void;
};

export type AppSocketServer = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents
>;

export function createSocketServer(httpServer: HttpServer): AppSocketServer {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    {
      cors: {
        origin: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
        methods: ["GET", "POST"],
      },
      pingInterval: 10000,
      pingTimeout: 5000,
    }
  );

  // Redis adapter for horizontal scaling
  const pubClient = new Redis(redisUrl, { lazyConnect: true });
  const subClient = pubClient.duplicate();

  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
      io.adapter(createAdapter(pubClient, subClient));
      logger.info("Socket.io Redis adapter connected");
    })
    .catch((err) => {
      logger.warn({ err }, "Redis adapter failed, running without adapter");
    });

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    socket.on("participant:join", async ({ sessionCode, token }) => {
      try {
        // Find participant by token
        const participant = await prisma.participant.findUnique({
          where: { token },
          include: { session: true },
        });

        if (!participant || participant.session.code !== sessionCode) {
          socket.emit("bid:rejected", { reason: "Invalid session or token" });
          return;
        }

        // Join the session room
        const room = `session:${sessionCode}`;
        socket.join(room);
        socket.data = { sessionCode, participantId: participant.id, token };

        // Mark as connected
        await prisma.participant.update({
          where: { id: participant.id },
          data: { connected: true },
        });

        // Broadcast join
        socket.to(room).emit("participant:joined", {
          name: participant.name,
          role: participant.role,
        });

        // Send presence update to all
        await broadcastPresence(io, sessionCode);

        // Send full state sync to the reconnecting client
        await sendStateSync(socket, participant.session);

        logger.info(
          { socketId: socket.id, participant: participant.name, room },
          "Participant joined room"
        );
      } catch (err) {
        logger.error({ err }, "Error handling participant:join");
      }
    });

    // Bid placement via WebSocket
    socket.on("bid:place", async ({ itemId, amount, token }) => {
      try {
        const participant = await prisma.participant.findUnique({
          where: { token },
        });
        if (!participant) {
          socket.emit("bid:rejected", { reason: "Invalid token" });
          return;
        }

        const result = await placeBid(itemId, amount, participant.id);

        if (!result.success) {
          socket.emit("bid:rejected", { reason: result.reason });
          return;
        }

        const room = findRoomForSocket(socket);
        if (room) {
          io.to(room).emit("bid:new", {
            participantName: result.bid.participantName,
            amount: result.bid.amount,
            itemId,
            timestamp: new Date().toISOString(),
          });
          // Broadcast updated budgets
          const sessionCode = socket.data?.sessionCode;
          if (sessionCode) await broadcastPresence(io, sessionCode);
        }
      } catch (err) {
        logger.error({ err }, "Error handling bid:place");
        socket.emit("bid:rejected", { reason: "Server error" });
      }
    });

    // Host controls
    socket.on("host:start", async ({ token }) => {
      try {
        const session = await prisma.session.findUnique({
          where: { hostToken: token },
          include: { items: { orderBy: { order: "asc" } } },
        });

        if (!session || session.items.length === 0) return;

        await prisma.session.update({
          where: { id: session.id },
          data: { status: "LIVE" },
        });
        await cacheInvalidate(CacheKeys.session(session.code));

        const result = await advanceToNextItem(session.id);
        const room = `session:${session.code}`;

        // Join host to the room
        socket.join(room);
        socket.data = { sessionCode: session.code, isHost: true };

        // Clear grace timer if host reconnected
        const graceTimer = hostGraceTimers.get(session.code);
        if (graceTimer) {
          clearTimeout(graceTimer);
          hostGraceTimers.delete(session.code);
          logger.info({ sessionCode: session.code }, "Host reconnected, grace period cancelled");
        }

        io.to(room).emit("session:started");

        if (result.item) {
          const endsAt = await startItemTimer(
            session.id,
            session.timePerItem
          );
          io.to(room).emit("item:start", {
            item: result.item,
            endsAt: new Date(endsAt).toISOString(),
          });

          // Start timer sync and BullMQ delayed expiry job
          scheduleTimerSync(io, session.code, session.id, endsAt);
          await scheduleItemExpiryJob(
            {
              sessionId: session.id,
              sessionCode: session.code,
              itemId: result.item.id,
              timePerItem: session.timePerItem,
            },
            session.timePerItem * 1000
          );
        }
      } catch (err) {
        logger.error({ err }, "Error handling host:start");
      }
    });

    socket.on("host:pause", async ({ token }) => {
      try {
        const session = await prisma.session.findUnique({
          where: { hostToken: token },
        });
        if (!session || session.status !== "LIVE") return;

        await prisma.session.update({
          where: { id: session.id },
          data: { status: "PAUSED" },
        });
        await cacheInvalidate(CacheKeys.session(session.code));

        io.to(`session:${session.code}`).emit("session:paused");
      } catch (err) {
        logger.error({ err }, "Error handling host:pause");
      }
    });

    socket.on("host:resume", async ({ token }) => {
      try {
        const session = await prisma.session.findUnique({
          where: { hostToken: token },
        });
        if (!session || session.status !== "PAUSED") return;

        await prisma.session.update({
          where: { id: session.id },
          data: { status: "LIVE" },
        });
        await cacheInvalidate(CacheKeys.session(session.code));

        io.to(`session:${session.code}`).emit("session:resumed");
      } catch (err) {
        logger.error({ err }, "Error handling host:resume");
      }
    });

    socket.on("host:skip", async ({ token }) => {
      try {
        const session = await prisma.session.findUnique({
          where: { hostToken: token },
          include: { items: { orderBy: { order: "asc" } } },
        });
        if (!session || session.status !== "LIVE") return;

        const currentItem = session.items[session.currentItemIdx ?? 0];
        if (currentItem) {
          await cancelItemExpiryJob(currentItem.id);
          await prisma.item.update({
            where: { id: currentItem.id },
            data: { status: "UNSOLD" },
          });
          io.to(`session:${session.code}`).emit("item:unsold", {
            itemId: currentItem.id,
          });
        }

        await clearTimer(session.id);
        await startNextItem(io, session.code, session.id, session.timePerItem);
      } catch (err) {
        logger.error({ err }, "Error handling host:skip");
      }
    });

    socket.on("host:close-item", async ({ token }) => {
      try {
        const session = await prisma.session.findUnique({
          where: { hostToken: token },
          include: { items: { orderBy: { order: "asc" } } },
        });
        if (!session || session.status !== "LIVE") return;

        const currentItem = session.items[session.currentItemIdx ?? 0];
        if (!currentItem) return;

        await cancelItemExpiryJob(currentItem.id);
        await clearTimer(session.id);
        const award = await awardItem(currentItem.id);
        const room = `session:${session.code}`;

        if (award.sold) {
          io.to(room).emit("item:sold", {
            itemId: currentItem.id,
            winner: award.winner!,
            amount: award.amount!,
          });
        } else {
          io.to(room).emit("item:unsold", { itemId: currentItem.id });
        }

        await broadcastPresence(io, session.code);
        await startNextItem(io, session.code, session.id, session.timePerItem);
      } catch (err) {
        logger.error({ err }, "Error handling host:close-item");
      }
    });

    socket.on("disconnect", async () => {
      const { participantId, sessionCode, isHost } = socket.data ?? {};

      if (participantId) {
        try {
          await prisma.participant.update({
            where: { id: participantId },
            data: { connected: false },
          });

          const room = `session:${sessionCode}`;
          const participant = await prisma.participant.findUnique({
            where: { id: participantId },
          });

          if (participant && sessionCode) {
            socket
              .to(room)
              .emit("participant:left", { name: participant.name });
            await broadcastPresence(io, sessionCode);
          }
        } catch (err) {
          logger.error({ err }, "Error handling disconnect");
        }
      }

      // Host disconnect grace period
      if (isHost && sessionCode) {
        logger.info(
          { sessionCode, graceMs: HOST_DISCONNECT_GRACE_MS },
          "Host disconnected, starting grace period"
        );

        hostGraceTimers.set(
          sessionCode,
          setTimeout(async () => {
            hostGraceTimers.delete(sessionCode);
            // Check if host reconnected
            const room = `session:${sessionCode}`;
            const sockets = await io.in(room).fetchSockets();
            const hostReconnected = sockets.some((s) => s.data?.isHost);

            if (!hostReconnected) {
              logger.warn({ sessionCode }, "Host did not reconnect within grace period");
              // Session continues — items still expire via BullMQ
              // Just log, don't kill the session
            }
          }, HOST_DISCONNECT_GRACE_MS)
        );
      }

      logger.info({ socketId: socket.id }, "Socket disconnected");
    });
  });

  // --- Stale connection cleanup (every 30s) ---
  const STALE_CLEANUP_INTERVAL_MS = 30_000;
  setInterval(async () => {
    try {
      // Find all participants marked as connected
      const connectedParticipants = await prisma.participant.findMany({
        where: { connected: true },
        include: { session: { select: { code: true } } },
      });

      for (const participant of connectedParticipants) {
        const room = `session:${participant.session.code}`;
        const sockets = await io.in(room).fetchSockets();
        const hasSocket = sockets.some(
          (s) => s.data?.participantId === participant.id
        );

        if (!hasSocket) {
          await prisma.participant.update({
            where: { id: participant.id },
            data: { connected: false },
          });
          logger.info(
            { participantId: participant.id, name: participant.name },
            "Cleaned up stale connection"
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "Error in stale connection cleanup");
    }
  }, STALE_CLEANUP_INTERVAL_MS);

  // --- Worker bridge: subscribe to item expiry events from BullMQ worker ---
  const workerSub = new Redis(redisUrl, { lazyConnect: true });
  workerSub
    .connect()
    .then(() => workerSub.subscribe(ITEM_EXPIRY_CHANNEL))
    .then(() => logger.info("Subscribed to worker item-expiry channel"))
    .catch((err) =>
      logger.warn({ err }, "Failed to subscribe to worker channel")
    );

  workerSub.on("message", async (_channel: string, message: string) => {
    try {
      const data = JSON.parse(message);
      const room = `session:${data.sessionCode}`;

      // Broadcast award result
      if (data.award.sold) {
        io.to(room).emit("item:sold", {
          itemId: data.award.itemId,
          winner: data.award.winner,
          amount: data.award.amount,
        });
      } else {
        io.to(room).emit("item:unsold", { itemId: data.award.itemId });
      }

      // Broadcast next item or session completion
      if (data.next.completed) {
        const session = await prisma.session.findUnique({
          where: { id: data.sessionId },
          include: {
            participants: {
              where: { role: "BIDDER" },
              include: { wonItems: true },
            },
          },
        });
        io.to(room).emit("session:completed", { results: session });

        const interval = timerIntervals.get(data.sessionId);
        if (interval) clearInterval(interval);
        timerIntervals.delete(data.sessionId);
      } else if (data.next.item) {
        io.to(room).emit("item:start", {
          item: data.next.item,
          endsAt: data.next.endsAt,
        });

        const endsAt = new Date(data.next.endsAt).getTime();
        scheduleTimerSync(io, data.sessionCode, data.sessionId, endsAt);
      }

      await broadcastPresence(io, data.sessionCode);
    } catch (err) {
      logger.error({ err }, "Error processing worker message");
    }
  });

  return io;
}

async function sendStateSync(
  socket: Parameters<Parameters<AppSocketServer["on"]>[1]>[0],
  session: { id: string; status: string; currentItemIdx: number | null; code: string }
) {
  try {
    // Get current active item
    let currentItem = null;
    if (session.currentItemIdx !== null) {
      const items = await prisma.item.findMany({
        where: { sessionId: session.id },
        orderBy: { order: "asc" },
      });
      const active = items[session.currentItemIdx];
      if (active && active.status === "ACTIVE") {
        currentItem = {
          id: active.id,
          name: active.name,
          description: active.description,
          minBid: active.minBid,
          order: active.order,
          currentBid: active.currentBid,
        };
      }
    }

    // Get timer state
    const timerEnd = await getTimerEnd(session.id);
    const endsAt = timerEnd ? new Date(timerEnd).toISOString() : null;

    // Get participants
    const participants = await prisma.participant.findMany({
      where: { sessionId: session.id },
      select: { id: true, name: true, role: true, budget: true, connected: true },
      orderBy: { joinedAt: "asc" },
    });

    socket.emit("state:sync", {
      sessionStatus: session.status,
      currentItem,
      endsAt,
      participants,
    });
  } catch (err) {
    logger.error({ err }, "Error sending state sync");
  }
}

async function broadcastPresence(io: AppSocketServer, sessionCode: string) {
  const participants = await prisma.participant.findMany({
    where: { session: { code: sessionCode } },
    select: {
      id: true,
      name: true,
      role: true,
      budget: true,
      connected: true,
    },
    orderBy: { joinedAt: "asc" },
  });

  io.to(`session:${sessionCode}`).emit("presence:update", { participants });
}

function findRoomForSocket(socket: { rooms: Set<string> }): string | null {
  for (const room of socket.rooms) {
    if (room.startsWith("session:")) return room;
  }
  return null;
}

// Timer management
const timerIntervals = new Map<string, NodeJS.Timeout>();
const hostGraceTimers = new Map<string, NodeJS.Timeout>();

function scheduleTimerSync(
  io: AppSocketServer,
  sessionCode: string,
  sessionId: string,
  endsAt: number
) {
  // Clear any existing interval
  const existing = timerIntervals.get(sessionId);
  if (existing) clearInterval(existing);

  const interval = setInterval(() => {
    const remaining = getRemainingMs(endsAt);
    io.to(`session:${sessionCode}`).emit("timer:sync", {
      remainingMs: remaining,
    });
    if (remaining <= 0) clearInterval(interval);
  }, TIMER_SYNC_INTERVAL_MS);

  timerIntervals.set(sessionId, interval);
}

async function startNextItem(
  io: AppSocketServer,
  sessionCode: string,
  sessionId: string,
  timePerItem: number
) {
  const result = await advanceToNextItem(sessionId);
  const room = `session:${sessionCode}`;

  if (result.completed) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        participants: {
          where: { role: "BIDDER" },
          include: { wonItems: true },
        },
      },
    });

    io.to(room).emit("session:completed", { results: session });

    // Cleanup timer sync interval
    const interval = timerIntervals.get(sessionId);
    if (interval) clearInterval(interval);
    timerIntervals.delete(sessionId);

    // Enqueue results summary generation
    await enqueueResultsSummary(sessionId);
    return;
  }

  if (result.item) {
    const endsAt = await startItemTimer(sessionId, timePerItem);
    io.to(room).emit("item:start", {
      item: result.item,
      endsAt: new Date(endsAt).toISOString(),
    });
    scheduleTimerSync(io, sessionCode, sessionId, endsAt);
    await scheduleItemExpiryJob(
      { sessionId, sessionCode, itemId: result.item.id, timePerItem },
      timePerItem * 1000
    );
  }
}

export { broadcastPresence };
