import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  CLAIM_TIME_MS,
  TURN_TIME_MS,
  getBestDiscard,
  initializeHKOSGame,
  processAction,
} from "@ourjong/engine";
import type { ClaimKind, GameAction, GameState, Player, SeatIndex, Tile } from "@ourjong/engine";

/**
 * Rooms: who is sitting where, and the one authoritative GameState per room.
 *
 * This module knows nothing about sockets, so it can be tested on its own. The socket layer
 * (socket.ts) calls into it and broadcasts the sanitized results.
 *
 * Identity: each seat has a public `playerId` (it appears in the game state that everyone
 * receives) and a secret `token` (only ever sent to its owner, used to reconnect). The token
 * must never be put in a game state or a room broadcast.
 */

export const SEATS_PER_ROOM = 4;
const ROOM_CODE = /^[A-Z]{4}$/;
// No I or O: they are too easy to mistake for 1 and 0 when read out loud.
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_NAME_LENGTH = 20;
const DEFAULT_ROOM_TTL_MS = 30 * 60 * 1000;
// Memory guard: a flood of joins with random codes can't open unlimited rooms.
const DEFAULT_MAX_ROOMS = 500;
// A player who is allowed to draw but hasn't (gone, or a client that doesn't auto-draw) is drawn
// for after this long. Normal clients draw within half a second.
export const DRAW_GRACE_MS = 2_000;
// One tick never plays more than this many fallback moves in a room (a safety net against loops).
const MAX_FALLBACKS_PER_TICK = 8;

export type RoomErrorCode =
  | "bad_code"
  | "room_full"
  | "not_in_room"
  | "game_not_started"
  | "stale_action"
  | "forbidden_action"
  | "illegal_action"
  | "server_busy"
  | "bad_payload"
  | "rate_limited";

/** A problem caused by the client; the message is safe to show to the player. */
export class RoomError extends Error {
  readonly code: RoomErrorCode;
  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export interface Seat {
  /** Public id (what the engine's Player.id is). */
  readonly playerId: string;
  /** Secret reconnect token. */
  readonly token: string;
  name: string;
  /** The socket currently bound to this seat, or null while disconnected. */
  socketId: string | null;
}

export interface Room {
  readonly code: string;
  /** Index = seat (0 East, 1 South, 2 West, 3 North), in join order. */
  seats: Seat[];
  /** Null until the fourth player joins. */
  state: GameState | null;
  updatedAt: number;
}

export interface JoinRequest {
  name?: string;
  /** A token from an earlier join: reclaims that seat after a disconnect. */
  token?: string;
  socketId: string;
}

export interface JoinResult {
  room: Room;
  seat: Seat;
  seatIndex: SeatIndex;
  reconnected: boolean;
  /** Set when an older socket was bound to the same seat and has been replaced. */
  replacedSocketId: string | null;
  /** True when this join filled the room and started the game. */
  started: boolean;
}

export interface RoomManagerOptions {
  now?: () => number;
  /** Seed for each new hand. Must be unguessable: the seed determines the whole shuffle. */
  makeSeed?: () => string;
  makeCode?: () => string;
  makePlayerId?: () => string;
  makeToken?: () => string;
  /** Most rooms open at once; further new codes get "server_busy". */
  maxRooms?: number;
  /** Turn clock in ms (default 15 s). 0 turns the clock off. */
  turnTimeMs?: number;
  /** Claim-window clock in ms (default 7 s). 0 turns the clock off. */
  claimTimeMs?: number;
}

export const normalizeRoomCode = (code: unknown): string => {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!ROOM_CODE.test(normalized)) {
    throw new RoomError("bad_code", "A room code is four letters, like ABCD");
  }
  return normalized;
};

const cleanName = (name: unknown, fallback: string): string => {
  if (typeof name !== "string") return fallback;
  const trimmed = name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return trimmed === "" ? fallback : trimmed;
};

/* ---------- Client actions: validate, then rebuild ---------- */

const CLAIM_KINDS: readonly ClaimKind[] = ["chow", "pung", "kong", "win"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Finds one of the player's OWN tiles by id; a client can only name tiles, never invent them. */
function ownTile(player: Player, ref: unknown): Tile {
  const id = isRecord(ref) ? ref.id : undefined;
  const tiles = player.drawnTile ? [...player.hand, player.drawnTile] : player.hand;
  const tile = typeof id === "number" ? tiles.find((t) => t.id === id) : undefined;
  if (tile === undefined) throw new RoomError("illegal_action", "That tile is not in your hand");
  return tile;
}

/**
 * Turns whatever the client sent into an action the engine may run. The server decides every
 * field that matters: the seat comes from the connection (never from the message), the
 * timestamp is the server's, tiles are looked up in that player's real hand, and a draw takes
 * the real top of the wall (clients only ever see hidden placeholders for it).
 */
export function buildPlayerAction(
  state: GameState,
  seat: SeatIndex,
  raw: unknown,
  now: number,
): GameAction {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    throw new RoomError("forbidden_action", "Malformed action");
  }
  if (raw.seq !== state.history.length) {
    throw new RoomError("stale_action", "The table has moved on; that action is out of date");
  }
  const seq = state.history.length;
  const player = state.players[seat];
  if (player === undefined) throw new RoomError("not_in_room", "You are not seated at this table");

  if (raw.type !== "system" && raw.seat !== seat) {
    throw new RoomError("forbidden_action", "You can only act for your own seat");
  }

  switch (raw.type) {
    case "draw": {
      const tile = state.wall.liveTiles[0];
      if (tile === undefined) throw new RoomError("illegal_action", "The wall is empty");
      return { type: "draw", seq, seat, timestamp: now, tile, fromDeadWall: false };
    }

    case "discard": {
      const tile = ownTile(player, raw.tile);
      return {
        type: "discard",
        seq,
        seat,
        timestamp: now,
        tile,
        fromDraw: player.drawnTile?.id === tile.id,
      };
    }

    case "pass":
      return { type: "pass", seq, seat, timestamp: now };

    case "claim": {
      const payload = raw.payload;
      if (!isRecord(payload) || !CLAIM_KINDS.includes(payload.kind as ClaimKind)) {
        throw new RoomError("forbidden_action", "Malformed claim");
      }
      const using = Array.isArray(payload.usingTiles) ? payload.usingTiles : [];
      return {
        type: "claim",
        seq,
        seat,
        timestamp: now,
        payload: {
          kind: payload.kind as ClaimKind,
          usingTiles: using.map((ref) => ownTile(player, ref)),
        },
      };
    }

    case "kong": {
      if (raw.variant !== "concealed" && raw.variant !== "added") {
        throw new RoomError("forbidden_action", "Exposed kongs are claimed with a claim action");
      }
      const refs = Array.isArray(raw.tiles) ? raw.tiles : [];
      return {
        type: "kong",
        seq,
        seat,
        timestamp: now,
        variant: raw.variant,
        tiles: refs.map((ref) => ownTile(player, ref)),
      };
    }

    case "win": {
      // Only a self-draw win is a win action; wins on a discard are claims.
      if (raw.method !== "self-draw" || player.drawnTile === null) {
        throw new RoomError("illegal_action", "You can only win by self-draw on a tile you just drew");
      }
      return {
        type: "win",
        seq,
        seat,
        timestamp: now,
        method: "self-draw",
        winningTile: player.drawnTile,
      };
    }

    case "system":
      // The server starts every hand itself, so "hand-start" is not a client action.
      if (raw.event === "round-advance") return { type: "system", seq, event: "round-advance" };
      throw new RoomError("forbidden_action", "That system event is not allowed");

    default:
      throw new RoomError("forbidden_action", `Actions of type "${raw.type}" are not allowed`);
  }
}

/* ---------- Fallback moves for absent players ---------- */

/**
 * The move to play for a seat that has run out of time, or null if nothing is overdue. Pure:
 * the same state and time always give the same answer.
 */
export function fallbackAction(state: GameState, now: number): GameAction | null {
  const seq = state.history.length;
  const phase = state.phase;

  switch (phase.type) {
    case "action": {
      if (phase.deadline === undefined || now < phase.deadline) return null;
      const player = state.players[phase.seat];
      if (player === undefined) return null;
      // Throw back what was just drawn. After a claimed pung/chow there is no drawn tile, so
      // fall back to the weakest tile in hand.
      const tile =
        player.drawnTile ??
        (player.hand.length > 0 ? getBestDiscard(player.hand, player.melds, "easy") : undefined);
      if (tile === undefined) return null;
      return {
        type: "discard",
        seq,
        seat: phase.seat,
        timestamp: now,
        tile,
        fromDraw: player.drawnTile?.id === tile.id,
      };
    }

    case "claim-window": {
      if (phase.deadline === undefined || now < phase.deadline) return null;
      // Every seat with a claim must answer; with no listed claims, any seat but the discarder.
      const eligible = [...new Set(phase.availableClaims.map((claim) => claim.seat))];
      const waiting =
        eligible.length > 0
          ? eligible.filter((seat) => !phase.passed.includes(seat))
          : state.players
              .map((p) => p.seat)
              .filter((seat) => seat !== phase.discardedBy && !phase.passed.includes(seat));
      const seat = waiting[0];
      return seat === undefined ? null : { type: "pass", seq, seat, timestamp: now };
    }

    case "draw": {
      const tile = state.wall.liveTiles[0];
      if (tile === undefined) return null;
      const last = state.history[state.history.length - 1];
      const lastAt = last !== undefined && "timestamp" in last ? last.timestamp : undefined;
      // No timestamp to measure from: leave it to the player.
      if (lastAt === undefined || now - lastAt < DRAW_GRACE_MS) return null;
      return { type: "draw", seq, seat: phase.seat, timestamp: now, tile, fromDeadWall: false };
    }

    default:
      return null;
  }
}

/* ---------- The manager ---------- */

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** socket id -> where it sits, so a socket can only ever act for its own seat. */
  private readonly sessions = new Map<string, { code: string; playerId: string }>();

  private readonly now: () => number;
  private readonly makeSeed: () => string;
  private readonly makeCode: () => string;
  private readonly makePlayerId: () => string;
  private readonly makeToken: () => string;
  private readonly maxRooms: number;
  private readonly turnTimeMs: number;
  private readonly claimTimeMs: number;

  constructor(options: RoomManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    // Cryptographic randomness: a guessable seed would let a client work out the wall.
    this.makeSeed = options.makeSeed ?? (() => randomBytes(16).toString("hex"));
    this.makeCode =
      options.makeCode ??
      (() => Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join(""));
    this.makePlayerId = options.makePlayerId ?? (() => randomUUID().slice(0, 8));
    this.makeToken = options.makeToken ?? (() => randomBytes(24).toString("hex"));
    this.maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
    this.turnTimeMs = options.turnTimeMs ?? TURN_TIME_MS;
    this.claimTimeMs = options.claimTimeMs ?? CLAIM_TIME_MS;
  }

  /** The manager's clock (ms), so everything the server stamps uses one time source. */
  nowMs(): number {
    return this.now();
  }

  /** A fresh, unused room code. */
  createRoom(): Room {
    let code = this.makeCode();
    while (this.rooms.has(code)) code = this.makeCode();
    return this.openRoom(code);
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /** Which room and player a socket belongs to, if any. */
  sessionOf(socketId: string): { code: string; playerId: string } | undefined {
    return this.sessions.get(socketId);
  }

  /**
   * Joins (creating the room if the code is new) or reconnects with a token. The fourth
   * player starts the game.
   */
  join(rawCode: unknown, request: JoinRequest): JoinResult {
    const code = normalizeRoomCode(rawCode);
    let room = this.rooms.get(code);
    if (room === undefined) {
      if (this.rooms.size >= this.maxRooms) {
        throw new RoomError("server_busy", "The server is full right now. Try again in a minute");
      }
      room = this.openRoom(code);
    }

    // Reconnect: a valid token takes its seat back, even mid-game.
    const existingIndex = request.token
      ? room.seats.findIndex((seat) => seat.token === request.token)
      : -1;
    if (existingIndex >= 0) {
      const seat = room.seats[existingIndex]!;
      const replacedSocketId = seat.socketId !== request.socketId ? seat.socketId : null;
      if (replacedSocketId !== null) this.sessions.delete(replacedSocketId);
      seat.socketId = request.socketId;
      if (request.name !== undefined) seat.name = cleanName(request.name, seat.name);
      this.sessions.set(request.socketId, { code, playerId: seat.playerId });
      room.updatedAt = this.now();
      return {
        room,
        seat,
        seatIndex: existingIndex as SeatIndex,
        reconnected: true,
        replacedSocketId,
        started: false,
      };
    }

    if (room.seats.length >= SEATS_PER_ROOM) {
      throw new RoomError("room_full", "That room is full");
    }

    const seatIndex = room.seats.length as SeatIndex;
    const seat: Seat = {
      playerId: this.makePlayerId(),
      token: this.makeToken(),
      name: cleanName(request.name, `Player ${seatIndex + 1}`),
      socketId: request.socketId,
    };
    room.seats.push(seat);
    this.sessions.set(request.socketId, { code, playerId: seat.playerId });
    room.updatedAt = this.now();

    const started = room.seats.length === SEATS_PER_ROOM;
    if (started) room.state = this.dealNewHand(room);

    return { room, seat, seatIndex, reconnected: false, replacedSocketId: null, started };
  }

  /**
   * A socket went away. Before the game starts its seat is freed (and an empty room removed);
   * once the game is running the seat is kept so the player can reconnect with their token.
   */
  detach(socketId: string): { room: Room; freedSeat: boolean } | undefined {
    const session = this.sessions.get(socketId);
    if (session === undefined) return undefined;
    this.sessions.delete(socketId);

    const room = this.rooms.get(session.code);
    if (room === undefined) return undefined;
    const index = room.seats.findIndex((seat) => seat.playerId === session.playerId);
    if (index < 0) return undefined;

    room.updatedAt = this.now();
    if (room.state === null) {
      room.seats.splice(index, 1);
      if (room.seats.length === 0) this.rooms.delete(room.code);
      return { room, freedSeat: true };
    }
    room.seats[index]!.socketId = null;
    return { room, freedSeat: false };
  }

  /**
   * Runs one client action through the engine's reducer and stores the new state. Throws a
   * RoomError (and changes nothing) if the action is not allowed or the engine rejects it.
   */
  applyPlayerAction(socketId: string, raw: unknown): { room: Room; state: GameState } {
    const session = this.sessions.get(socketId);
    const room = session ? this.rooms.get(session.code) : undefined;
    if (session === undefined || room === undefined) {
      throw new RoomError("not_in_room", "Join a room first");
    }
    const state = room.state;
    if (state === null) {
      throw new RoomError("game_not_started", "Waiting for four players");
    }

    const seat = state.players.findIndex((player) => player.id === session.playerId);
    if (seat < 0) throw new RoomError("not_in_room", "You are not seated at this table");

    const now = this.now();
    const action = buildPlayerAction(state, seat as SeatIndex, raw, now);

    let next: GameState;
    try {
      next =
        action.type === "system" && action.event === "round-advance"
          ? this.advanceRound(room, state)
          : processAction(state, action);
    } catch (error) {
      if (error instanceof RoomError) throw error;
      throw new RoomError("illegal_action", error instanceof Error ? error.message : "Illegal action");
    }

    room.state = next;
    room.updatedAt = now;
    return { room, state: next };
  }

  /**
   * The server-side clock. Call about once a second. For every running game it plays the move an
   * absent player would not: an expired turn discards the drawn tile, an expired claim window
   * passes for every seat that has not answered, and a draw nobody made is drawn. Returns the
   * rooms whose state changed so the caller can broadcast them.
   */
  tick(): Room[] {
    const now = this.now();
    const changed: Room[] = [];

    for (const room of this.rooms.values()) {
      let moved = false;
      for (let i = 0; i < MAX_FALLBACKS_PER_TICK; i++) {
        const state = room.state;
        if (state === null) break;
        const action = fallbackAction(state, now);
        if (action === null) break;
        try {
          room.state = processAction(state, action);
          room.updatedAt = now;
          moved = true;
        } catch (error) {
          // A move the engine refuses must not wedge the loop or the other rooms.
          console.warn(`[room ${room.code}] fallback ${action.type} failed:`, error);
          break;
        }
      }
      if (moved) changed.push(room);
    }
    return changed;
  }

  /** Removes rooms nobody is connected to that have been idle for `ttlMs`. */
  prune(ttlMs: number = DEFAULT_ROOM_TTL_MS): number {
    const cutoff = this.now() - ttlMs;
    let removed = 0;
    for (const room of [...this.rooms.values()]) {
      const anyoneHere = room.seats.some((seat) => seat.socketId !== null);
      if (!anyoneHere && room.updatedAt < cutoff) {
        this.rooms.delete(room.code);
        removed++;
      }
    }
    return removed;
  }

  /* ---------- internals ---------- */

  private openRoom(code: string): Room {
    const room: Room = { code, seats: [], state: null, updatedAt: this.now() };
    this.rooms.set(code, room);
    return room;
  }

  /** A fresh game for the room's four seats, with the hand already started (East has drawn). */
  private dealNewHand(room: Room): GameState {
    const ids = room.seats.map((seat) => seat.playerId) as [string, string, string, string];
    const dealt = initializeHKOSGame(room.code, ids, this.makeSeed());
    const named: GameState = {
      ...dealt,
      // The clocks live in the rules, so the engine stamps a deadline on every turn and claim window.
      rules: {
        ...dealt.rules,
        ...(this.turnTimeMs > 0 ? { turnTimeMs: this.turnTimeMs } : {}),
        ...(this.claimTimeMs > 0 ? { claimTimeMs: this.claimTimeMs } : {}),
      },
      players: dealt.players.map((player, index) => ({ ...player, name: room.seats[index]!.name })),
    };
    return processAction(named, {
      type: "system",
      seq: 0,
      event: "hand-start",
      payload: { timestamp: this.now() },
    });
  }

  /** "Next hand": only once the current one is over. Deals a new game to the same four seats. */
  private advanceRound(room: Room, state: GameState): GameState {
    if (state.phase.type !== "hand-end") {
      throw new RoomError("illegal_action", "The hand is not over yet");
    }
    return this.dealNewHand(room);
  }
}
