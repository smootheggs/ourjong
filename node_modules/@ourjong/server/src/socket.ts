import type { Server, Socket } from "socket.io";
import { RoomError, TURN_TIME_OPTIONS_MS } from "./room.ts";
import type { Room, RoomManager } from "./room.ts";
import { sanitizeStateForPlayer } from "./sanitize.ts";
import type { SanitizedGameState } from "./sanitize.ts";

/* ---------- The wire protocol ---------- */

export interface RoomSummary {
  code: string;
  started: boolean;
  /** The table's clocks (ms, 0 = no clock). The host picks them while the table is filling. */
  settings: { turnTimeMs: number; claimTimeMs: number };
  /** Your own seat index; seat 0 is the host. Different for every recipient. */
  yourSeat: number;
  /** Public seating info only: no ids, no tokens. */
  seats: { seat: number; name: string; connected: boolean }[];
}

/** A player's view of the game plus the server's clock, so clients can show deadlines correctly. */
export type GameStateMessage = SanitizedGameState & { serverTime: number };

export interface ClientToServerEvents {
  /** `{ code: "ABCD", name?: string, token?: string }`. A token reclaims your seat. */
  join_room: (payload: unknown) => void;
  /** A game action (draw, discard, pass, claim, kong, win, or system round-advance). */
  player_action: (action: unknown) => void;
  /** Host only, before the game starts: `{ turnTimeMs: 10000 | 15000 | 30000 | 0 }`. */
  update_settings: (payload: unknown) => void;
  leave_room: () => void;
  /** Quick chat: `{ emoji: "👋" }`, one of QUICK_EMOJIS. Sent on to the other players in the room. */
  chat_emoji: (payload: unknown) => void;
}

/** The only emoji the server relays. Anything else is refused, so chat can never carry text. */
export const QUICK_EMOJIS: readonly string[] = ["👋", "😅", "🀄", "😤", "🙏", "👏", "😂", "🤔"];

/** One emoji per sender in this window; extra taps are ignored. */
export const EMOJI_COOLDOWN_MS = 800;

export interface ServerToClientEvents {
  /** Sent to the joining socket only. `token` is a secret: keep it, never show it. */
  room_joined: (info: { code: string; playerId: string; token: string; seat: number }) => void;
  /** Sent to everyone in the room whenever seating changes. */
  room_update: (summary: RoomSummary) => void;
  /** This player's private view of the game; sent after every change. */
  game_state: (state: GameStateMessage) => void;
  join_error: (error: { code: string; message: string }) => void;
  /** Sent to the player whose action was rejected; nobody else hears about it. */
  action_error: (error: { code: string; message: string }) => void;
  /** Another tab or device took over this seat. */
  replaced: () => void;
  /** Someone else's quick-chat emoji. `seat` and `playerId` come from the server, never the sender. */
  chat_emoji: (message: { seat: number; playerId: string; emoji: string }) => void;
}

export type OurjongServer = Server<ClientToServerEvents, ServerToClientEvents>;
type OurjongSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/* ---------- Limits ---------- */

/** Hard caps on what a client may send. Anything over is rejected, not trimmed. */
export const LIMITS = {
  /** A room code is 4 letters; the slack allows stray spaces that normalizing removes. */
  codeChars: 8,
  /** Longer than this is refused outright; the room manager then shortens to 20. */
  nameChars: 64,
  tokenChars: 128,
  /** Tile ids are small and unique per game. */
  maxTileId: 1000,
  /** No game gets anywhere near this many actions. */
  maxSeq: 100_000,
  /** Most tiles any action names: a kong uses four. */
  maxTilesPerAction: 4,
  /** Messages per second per socket, with a burst of the same size. */
  messagesPerSecond: 5,
  /** Dropped messages in `abuseWindowMs` that get a socket disconnected. */
  maxDropsBeforeKick: 40,
  abuseWindowMs: 10_000,
  /** A socket that has not joined a room in this long is cut off. */
  idleBeforeJoinMs: 30_000,
} as const;

/* ---------- Rate limiting ---------- */

export type RateVerdict = "ok" | "drop" | "kick";

/**
 * A token bucket per socket: `rate` messages per second, with a burst of `burst`. A message that
 * finds the bucket empty is dropped; a socket that keeps hammering gets kicked. Cheap enough to
 * run on every message, and it never allocates.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private drops = 0;
  private windowStart: number;

  constructor(
    private readonly rate: number = LIMITS.messagesPerSecond,
    private readonly burst: number = LIMITS.messagesPerSecond,
    private readonly kickAfter: number = LIMITS.maxDropsBeforeKick,
    private readonly windowMs: number = LIMITS.abuseWindowMs,
    now: number = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
    this.windowStart = now;
  }

  take(now: number = Date.now()): RateVerdict {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rate) / 1000);

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return "ok";
    }

    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.drops = 0;
    }
    this.drops += 1;
    return this.drops >= this.kickAfter ? "kick" : "drop";
  }
}

/* ---------- Payload validation ---------- */

const bad = (message: string): RoomError => new RoomError("bad_payload", message);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

const TOKEN = /^[A-Za-z0-9_-]+$/;
const CODE = /^[A-Za-z ]+$/;

export interface JoinPayload {
  code: string;
  name?: string;
  token?: string;
}

/** `join_room`: a code, and optionally a name and a reconnect token. Nothing else gets through. */
export function parseJoinPayload(payload: unknown): JoinPayload {
  if (!isPlainObject(payload)) throw bad("Malformed join request");
  for (const key of Object.keys(payload)) {
    if (key !== "code" && key !== "name" && key !== "token") throw bad("Malformed join request");
  }

  const { code, name, token } = payload;
  if (typeof code !== "string" || code.length > LIMITS.codeChars || !CODE.test(code)) {
    throw bad("A room code is four letters, like ABCD");
  }

  const out: JoinPayload = { code };

  if (name !== undefined) {
    if (typeof name !== "string" || name.length > LIMITS.nameChars) throw bad("That name is too long");
    // Drop control, zero-width and bidi-override characters: they can spoof other players' names.
    out.name = name.normalize("NFC").replace(/\p{C}/gu, "");
  }

  if (token !== undefined) {
    if (typeof token !== "string" || token.length > LIMITS.tokenChars || !TOKEN.test(token)) {
      throw bad("Malformed token");
    }
    out.token = token;
  }
  return out;
}

export interface SettingsPayload {
  turnTimeMs: number;
}

/**
 * `update_settings`: one number, and only one of the allowed turn times. The claim time is not
 * the client's to choose; the server derives it from the turn time.
 */
export function parseSettingsPayload(payload: unknown): SettingsPayload {
  if (!isPlainObject(payload)) throw bad("Malformed settings");
  for (const key of Object.keys(payload)) {
    if (key !== "turnTimeMs") throw bad("Malformed settings");
  }
  const { turnTimeMs } = payload;
  if (typeof turnTimeMs !== "number" || !TURN_TIME_OPTIONS_MS.includes(turnTimeMs)) {
    throw bad("That turn time is not one of the options");
  }
  return { turnTimeMs };
}

const tileRef = (value: unknown): { id: number } => {
  if (!isPlainObject(value) || !isInt(value.id, 0, LIMITS.maxTileId)) throw bad("Malformed tile");
  return { id: value.id };
};

const tileRefs = (value: unknown, min: number): { id: number }[] => {
  if (!Array.isArray(value) || value.length < min || value.length > LIMITS.maxTilesPerAction) {
    throw bad("Malformed tile list");
  }
  return value.map(tileRef);
};

const CLAIM_KINDS = ["chow", "pung", "kong", "win"] as const;

/**
 * `player_action`: checks every field a client may send and returns a brand-new object holding
 * only those fields (tiles reduced to their ids). Whatever else the client attached is gone
 * before the room manager ever sees it, and the room manager still checks the move against the
 * real game.
 */
export function parseActionPayload(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw) || typeof raw.type !== "string") throw bad("Malformed action");
  const { type } = raw;
  if (!isInt(raw.seq, 0, LIMITS.maxSeq)) throw bad("Malformed action");
  const seq = raw.seq;

  if (type === "system") {
    if (raw.event !== "round-advance") throw bad("That system event is not allowed");
    return { type, seq, event: "round-advance" };
  }

  if (!isInt(raw.seat, 0, 3)) throw bad("Malformed action");
  const base = { type, seq, seat: raw.seat };

  switch (type) {
    case "draw":
    case "pass":
      return base;

    case "discard":
      return { ...base, tile: tileRef(raw.tile) };

    case "claim": {
      const payload = raw.payload;
      if (!isPlainObject(payload)) throw bad("Malformed claim");
      const kind = CLAIM_KINDS.find((k) => k === payload.kind);
      if (kind === undefined) throw bad("Malformed claim");
      // A win claim names no tiles; the others name the ones from your hand.
      const usingTiles = payload.usingTiles === undefined ? [] : tileRefs(payload.usingTiles, 0);
      return { ...base, payload: { kind, usingTiles } };
    }

    case "kong": {
      if (raw.variant !== "concealed" && raw.variant !== "added") throw bad("Malformed kong");
      return { ...base, variant: raw.variant, tiles: tileRefs(raw.tiles, 1) };
    }

    case "win":
      if (raw.method !== "self-draw") throw bad("Malformed win");
      return { ...base, method: "self-draw" };

    default:
      throw bad("That action is not allowed");
  }
}

/* ---------- Plumbing ---------- */

const roomChannel = (code: string) => `room:${code}`;

const toError = (error: unknown): { code: string; message: string } =>
  error instanceof RoomError
    ? { code: error.code, message: error.message }
    : { code: "server_error", message: "Something went wrong" };

function summarize(room: Room, yourSeat: number): RoomSummary {
  return {
    code: room.code,
    started: room.state !== null,
    settings: { ...room.settings },
    yourSeat,
    seats: room.seats.map((seat, index) => ({
      seat: index,
      name: seat.name,
      connected: seat.socketId !== null,
    })),
  };
}

export interface SocketOptions {
  /** Most simultaneous connections from one address; 0 turns the cap off. */
  maxConnectionsPerIp?: number;
  /** Read the address from X-Forwarded-For. Only turn this on behind a proxy you control. */
  trustProxy?: boolean;
}

export interface SocketHandlers {
  /** Sends every connected player in the room their own, freshly sanitized copy of the state. */
  broadcastState: (room: Room) => void;
}

/** Wires the room manager to Socket.io: join, play, leave, disconnect. */
export function registerSocketHandlers(
  io: OurjongServer,
  rooms: RoomManager,
  options: SocketOptions = {},
): SocketHandlers {
  const maxPerIp = options.maxConnectionsPerIp ?? 20;

  const broadcastState = (room: Room): void => {
    const state = room.state;
    if (state === null) return;
    const serverTime = rooms.nowMs();
    for (const seat of room.seats) {
      if (seat.socketId === null) continue;
      io.to(seat.socketId).emit("game_state", {
        ...sanitizeStateForPlayer(state, seat.playerId),
        serverTime,
      });
    }
  };

  // Each player gets their own copy, because it says which seat is theirs (seat 0 is the host).
  const broadcastRoom = (room: Room): void => {
    room.seats.forEach((seat, index) => {
      if (seat.socketId !== null) io.to(seat.socketId).emit("room_update", summarize(room, index));
    });
  };

  /* Connection cap per address. */
  const perIp = new Map<string, number>();
  const addressOf = (socket: OurjongSocket): string => {
    if (options.trustProxy) {
      const forwarded = socket.handshake.headers["x-forwarded-for"];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
      if (first) return first.slice(0, 64);
    }
    return socket.handshake.address;
  };

  io.use((socket, next) => {
    if (maxPerIp <= 0) return next();
    const ip = addressOf(socket);
    const open = perIp.get(ip) ?? 0;
    if (open >= maxPerIp) return next(new Error("too_many_connections"));
    perIp.set(ip, open + 1);
    socket.once("disconnect", () => {
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
    return next();
  });

  io.on("connection", (socket) => {
    const limiter = new RateLimiter();
    let lastWarning = 0;

    // A socket that never joins a room is a socket held open for nothing.
    const idleTimer = setTimeout(() => {
      if (rooms.sessionOf(socket.id) === undefined) socket.disconnect(true);
    }, LIMITS.idleBeforeJoinMs);
    idleTimer.unref();

    const leave = () => {
      const result = rooms.detach(socket.id);
      if (result === undefined) return;
      void socket.leave(roomChannel(result.room.code));
      // An emptied lobby no longer exists; otherwise tell the others who is still here.
      if (rooms.getRoom(result.room.code) !== undefined) broadcastRoom(result.room);
    };

    /**
     * Every incoming message goes through here: rate limit first (before any parsing), then the
     * handler inside a try/catch so a bug or a hostile payload can never throw out of the event
     * loop. `onError` decides which event the sender hears about a failure on.
     */
    const guarded =
      (onError: (error: { code: string; message: string }) => void, handler: () => void) => () => {
        const verdict = limiter.take();
        if (verdict === "kick") {
          socket.disconnect(true);
          return;
        }
        if (verdict === "drop") {
          // Dropped silently, apart from one warning a second so a runaway client can tell.
          const now = Date.now();
          if (now - lastWarning > 1000) {
            lastWarning = now;
            socket.emit("action_error", { code: "rate_limited", message: "Slow down" });
          }
          return;
        }
        try {
          handler();
        } catch (error) {
          if (!(error instanceof RoomError)) console.error("[socket] unexpected error:", error);
          onError(toError(error));
        }
      };

    socket.on("join_room", (payload) =>
      guarded(
        (error) => socket.emit("join_error", error),
        () => {
          if (rooms.sessionOf(socket.id) !== undefined) {
            throw new RoomError("forbidden_action", "You are already in a room");
          }
          const body = parseJoinPayload(payload);
          const result = rooms.join(body.code, {
            socketId: socket.id,
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.token !== undefined ? { token: body.token } : {}),
          });
          const code = result.room.code;

          // A second tab reclaiming the seat pushes the first one out.
          if (result.replacedSocketId !== null) {
            const old = io.sockets.sockets.get(result.replacedSocketId);
            old?.emit("replaced");
            void old?.leave(roomChannel(code));
          }

          void socket.join(roomChannel(code));
          socket.emit("room_joined", {
            code,
            playerId: result.seat.playerId,
            token: result.seat.token,
            seat: result.seatIndex,
          });
          broadcastRoom(result.room);
          broadcastState(result.room);
        },
      )(),
    );

    socket.on("player_action", (action) =>
      guarded(
        // Only the sender hears about a rejected action; the state is unchanged.
        (error) => socket.emit("action_error", error),
        () => {
          const clean = parseActionPayload(action);
          const { room } = rooms.applyPlayerAction(socket.id, clean);
          broadcastState(room);
        },
      )(),
    );

    let lastEmojiAt = 0;
    socket.on("chat_emoji", (payload) =>
      guarded(
        (error) => socket.emit("action_error", error),
        () => {
          const session = rooms.sessionOf(socket.id);
          if (session === undefined) throw new RoomError("forbidden_action", "You are not in a room");
          const emoji =
            typeof payload === "object" && payload !== null
              ? (payload as Record<string, unknown>)["emoji"]
              : undefined;
          if (typeof emoji !== "string" || !QUICK_EMOJIS.includes(emoji)) {
            throw new RoomError("bad_payload", "Unknown emoji");
          }
          const now = Date.now();
          if (now - lastEmojiAt < EMOJI_COOLDOWN_MS) return; // too soon: dropped quietly
          lastEmojiAt = now;
          const room = rooms.getRoom(session.code);
          const seat = room?.seats.findIndex((s) => s.playerId === session.playerId) ?? -1;
          if (seat < 0) return;
          // Everyone but the sender, who already shows it locally.
          socket.to(roomChannel(session.code)).emit("chat_emoji", {
            seat,
            playerId: session.playerId,
            emoji,
          });
        },
      )(),
    );

    socket.on("update_settings", (payload) =>
      guarded(
        (error) => socket.emit("action_error", error),
        () => {
          const { turnTimeMs } = parseSettingsPayload(payload);
          broadcastRoom(rooms.updateSettings(socket.id, turnTimeMs));
        },
      )(),
    );

    socket.on("leave_room", () =>
      guarded(
        (error) => socket.emit("action_error", error),
        leave,
      )(),
    );

    // Cleanup is never rate limited or skipped.
    socket.on("disconnect", () => {
      clearTimeout(idleTimer);
      try {
        leave();
      } catch (error) {
        console.error("[socket] error while leaving:", error);
      }
    });
  });

  return { broadcastState };
}
