import { Server as SocketServer } from "socket.io";
import type { Server as HttpServer } from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { prisma } from "./db";
import { logger } from "@/lib/logger";

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

    // Also allow host to join the room
    socket.on("host:start", async ({ token }) => {
      // Will be implemented in Step 5
      const room = findRoomForSocket(socket);
      if (room) {
        io.to(room).emit("session:started");
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

export { broadcastPresence };
