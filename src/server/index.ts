import "dotenv/config";
import http from "http";
import { createSocketServer } from "./socket";
import { logger } from "../lib/logger";

const PORT = Number(process.env.SOCKET_PORT ?? 3001);

const httpServer = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("BidHaus Socket.io server");
});

createSocketServer(httpServer);

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, "Socket.io server listening");
});
