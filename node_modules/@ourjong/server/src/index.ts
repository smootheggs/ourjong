import { createServer } from "node:http";
import express from "express";
import { Server } from "socket.io";
import { RoomManager } from "./room.ts";
import { registerSocketHandlers } from "./socket.ts";
import type { ClientToServerEvents, ServerToClientEvents } from "./socket.ts";

const PORT = Number(process.env.PORT ?? 3001);
// Comma-separated list of browser origins allowed to connect (the Vite dev server by default).
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
// Only behind a reverse proxy you control: reads the client address from X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const MAX_CONNECTIONS_PER_IP = Number(process.env.MAX_CONNECTIONS_PER_IP ?? 20);
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 500);
// Set either to 0 to play without that clock.
const TURN_TIME_MS = process.env.TURN_TIME_MS === undefined ? undefined : Number(process.env.TURN_TIME_MS);
const CLAIM_TIME_MS =
  process.env.CLAIM_TIME_MS === undefined ? undefined : Number(process.env.CLAIM_TIME_MS);

const TICK_MS = 1000;
const PRUNE_MS = 60_000;

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  next();
});
if (TRUST_PROXY) app.set("trust proxy", 1);

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: "*" },
    // Actions are tiny; refuse anything big instead of buffering it.
    maxHttpBufferSize: 8 * 1024,
    // Dead connections (a lag switch, a closed laptop) are noticed within about 20 s. The seat is
    // kept, and the turn clock plays for the absent player in the meantime.
    pingInterval: 10_000,
    pingTimeout: 10_000,
    connectTimeout: 10_000,
    // Bypassed for local Wi-Fi testing. 
    // (In production, revert this to origin === undefined || CLIENT_ORIGINS.includes(origin))
    allowRequest: (req, callback) => {
      callback(null, true);
    },
  });

const rooms = new RoomManager({
  maxRooms: MAX_ROOMS,
  ...(TURN_TIME_MS !== undefined ? { turnTimeMs: TURN_TIME_MS } : {}),
  ...(CLAIM_TIME_MS !== undefined ? { claimTimeMs: CLAIM_TIME_MS } : {}),
});
const handlers = registerSocketHandlers(io, rooms, {
  maxConnectionsPerIp: MAX_CONNECTIONS_PER_IP,
  trustProxy: TRUST_PROXY,
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.roomCount });
});

// The server-authoritative clock: once a second, play the fallback move for anyone who has run
// out of time (discard for an idle turn, pass for an idle claim window) and tell the table.
const tickTimer = setInterval(() => {
  try {
    for (const room of rooms.tick()) handlers.broadcastState(room);
  } catch (error) {
    // One bad tick must never take the clock down.
    console.error("[tick] failed:", error);
  }
}, TICK_MS);
tickTimer.unref();

// Drop rooms that everyone left a while ago.
const pruneTimer = setInterval(() => rooms.prune(), PRUNE_MS);
pruneTimer.unref();

httpServer.listen(PORT, () => {
  console.log(`Ourjong server listening on http://localhost:${PORT}`);
});

// Log instead of dying: one bad message must not end every table's game.
process.on("uncaughtException", (error) => console.error("[uncaughtException]", error));
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));

const shutdown = () => {
  clearInterval(tickTimer);
  clearInterval(pruneTimer);
  void io.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
