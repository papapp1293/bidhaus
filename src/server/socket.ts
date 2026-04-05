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

        const result = await advanceToNextItem(session.id);
        const room = `session:${session.code}`;

        // Join host to the room
        socket.join(room);
        socket.data = { sessionCode: session.code, isHost: true };

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

          // Start timer sync and expiry
          scheduleTimerSync(io, session.code, session.id, endsAt);
          scheduleItemExpiry(
            io,
            session.code,
            session.id,
            result.item.id,
            session.timePerItem
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
      const { participantId, sessionCode } = socket.data ?? {};

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

      logger.info({ socketId: socket.id }, "Socket disconnected");
    });
  });

  return io;
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
const expiryTimeouts = new Map<string, NodeJS.Timeout>();

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

function scheduleItemExpiry(
  io: AppSocketServer,
  sessionCode: string,
  sessionId: string,
  itemId: string,
  durationSeconds: number
) {
  const existing = expiryTimeouts.get(sessionId);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(async () => {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
      });
      if (!session || session.status !== "LIVE") return;

      const award = await awardItem(itemId);
      const room = `session:${sessionCode}`;

      if (award.sold) {
        io.to(room).emit("item:sold", {
          itemId,
          winner: award.winner!,
          amount: award.amount!,
        });
      } else {
        io.to(room).emit("item:unsold", { itemId });
      }

      await broadcastPresence(io, sessionCode);
      await startNextItem(io, sessionCode, sessionId, durationSeconds);
    } catch (err) {
      logger.error({ err }, "Error in item expiry");
    }
  }, durationSeconds * 1000);

  expiryTimeouts.set(sessionId, timeout);
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

    // Cleanup timers
    const interval = timerIntervals.get(sessionId);
    if (interval) clearInterval(interval);
    timerIntervals.delete(sessionId);
    expiryTimeouts.delete(sessionId);
    return;
  }

  if (result.item) {
    const endsAt = await startItemTimer(sessionId, timePerItem);
    io.to(room).emit("item:start", {
      item: result.item,
      endsAt: new Date(endsAt).toISOString(),
    });
    scheduleTimerSync(io, sessionCode, sessionId, endsAt);
    scheduleItemExpiry(io, sessionCode, sessionId, result.item.id, timePerItem);
  }
}

export { broadcastPresence };
