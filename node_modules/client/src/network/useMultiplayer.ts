import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import type {
  DrawAction,
  GameAction,
  GameState,
  KongAction,
  Meld,
  Player,
  SeatIndex,
  Tile,
  Wall,
} from "@ourjong/engine";

/**
 * Online play: one socket to the game server, the lobby it feeds, and the game it plays.
 *
 * The server never sends hidden information. Where a tile is secret (opponents' hands, the
 * wall, other players' concealed kongs) it sends the string "hidden". This hook turns the
 * server's view back into a normal engine `GameState`, filling each hidden slot with a
 * placeholder tile whose id is NEGATIVE. Real tiles always have ids >= 0, so the table can tell
 * them apart and draw a back. Everything else in the state is the real thing.
 *
 * Identity: after joining, the server gives this tab a secret token. It is kept in
 * sessionStorage (one per browser tab, so two tabs make two players) and replayed on every
 * reconnect, which hands the same seat back, even in the middle of a game.
 */

const SERVER_URL: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SERVER_URL ??
  "http://localhost:3001";

const SESSION_KEY = "ourjong.session";

/* ---------- What the server sends (mirrors apps/server/src/socket.ts) ---------- */

export interface RoomSummary {
  code: string;
  /** True once the fourth player has joined and the game is running. */
  started: boolean;
  /** Public seating only. */
  seats: { seat: number; name: string; connected: boolean }[];
  /** Clocks the host picked. 0 means no limit. The server derives the claim time. */
  settings: { turnTimeMs: number; claimTimeMs: number };
  /** The seat of the tab this was sent to. Seat 0 is the host. Null for a spectator. */
  yourSeat: number | null;
}

/** The turn times the host can choose from (0 = Infinite). Mirrors the server's menu. */
export const TURN_TIME_OPTIONS_MS = [10_000, 15_000, 30_000, 0] as const;

type WireTile = Tile | "hidden";
type WireMeld = Omit<Meld, "tiles"> & { tiles: WireTile[] };
type WirePlayer = Omit<Player, "hand" | "drawnTile" | "melds"> & {
  hand: WireTile[];
  drawnTile: WireTile | null;
  melds: WireMeld[];
};
type WireWall = Omit<Wall, "liveTiles" | "deadWall"> & {
  liveTiles: "hidden"[];
  deadWall: "hidden"[];
};
type WireAction =
  | GameAction
  | (Omit<DrawAction, "tile"> & { tile: WireTile })
  | (Omit<KongAction, "tiles"> & { tiles: WireTile[] });

export type WireGameState = Omit<GameState, "players" | "wall" | "history" | "random"> & {
  /** The server's clock (epoch ms) when it sent this; deadlines are on that clock. */
  serverTime?: number;
  viewer: { playerId: string; seat: SeatIndex | null };
  players: WirePlayer[];
  wall: WireWall;
  history: WireAction[];
};

interface ServerToClientEvents {
  room_joined: (info: { code: string; playerId: string; token: string; seat: number }) => void;
  room_update: (summary: RoomSummary) => void;
  game_state: (state: WireGameState) => void;
  join_error: (error: { code: string; message: string }) => void;
  action_error: (error: { code: string; message: string }) => void;
  replaced: () => void;
  chat_emoji: (message: { seat: number; playerId: string; emoji: string }) => void;
}

interface ClientToServerEvents {
  join_room: (payload: { code: string; name?: string; token?: string }) => void;
  player_action: (action: GameAction) => void;
  update_settings: (payload: { turnTimeMs: number }) => void;
  leave_room: () => void;
  chat_emoji: (payload: { emoji: string }) => void;
}

/* ---------- Hidden tiles -> placeholders ---------- */

const placeholder = (id: number): Tile => ({
  id,
  face: { kind: "wind", wind: "east" },
  copy: 0,
});

/** Stable negative ids, so React keys don't change from one update to the next. */
const handSlotId = (seat: number, index: number) => -(1 + seat * 1000 + index);
const drawnSlotId = (seat: number) => -(1 + seat * 1000 + 900);
const meldSlotId = (seat: number, meld: number, index: number) =>
  -(1 + seat * 1000 + 400 + meld * 10 + index);
const wallSlotId = (index: number) => -(10_000 + index);
const historySlotId = (action: number, index: number) => -(20_000 + action * 10 + index);

const unhide = (tile: WireTile, id: number): Tile => (tile === "hidden" ? placeholder(id) : tile);

function unwireAction(action: WireAction, index: number): GameAction {
  if (action.type === "draw") {
    return { ...action, tile: unhide(action.tile, historySlotId(index, 0)) } as GameAction;
  }
  if (action.type === "kong") {
    return {
      ...action,
      tiles: action.tiles.map((tile, i) => unhide(tile, historySlotId(index, i))),
    } as GameAction;
  }
  return action;
}

/** The server's view as an engine GameState the table can draw. */
export function unwireState(view: WireGameState): GameState {
  return {
    id: view.id,
    rules: view.rules,
    round: view.round,
    phase: view.phase,
    currentTurn: view.currentTurn,
    lastDiscard: view.lastDiscard,
    extensions: view.extensions,
    // The shuffle seed never leaves the server.
    random: { seed: "" },
    players: view.players.map(
      (p): Player => ({
        ...p,
        hand: p.hand.map((tile, i) => unhide(tile, handSlotId(p.seat, i))),
        drawnTile: p.drawnTile === null ? null : unhide(p.drawnTile, drawnSlotId(p.seat)),
        melds: p.melds.map((meld, mi) => ({
          ...meld,
          tiles: meld.tiles.map((tile, ti) => unhide(tile, meldSlotId(p.seat, mi, ti))),
        })),
      }),
    ),
    wall: {
      ...view.wall,
      liveTiles: view.wall.liveTiles.map((_, i) => placeholder(wallSlotId(i))),
      deadWall: view.wall.deadWall.map((_, i) => placeholder(wallSlotId(1000 + i))),
    },
    history: view.history.map(unwireAction),
  };
}

/* ---------- Saved seat (per tab) ---------- */

interface Session {
  code: string;
  name: string;
  /** Secret. Absent until the server has accepted the first join. */
  token?: string;
}

function loadSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { code, name, token } = parsed as Record<string, unknown>;
    if (typeof code !== "string" || typeof name !== "string") return null;
    return typeof token === "string" ? { code, name, token } : { code, name };
  } catch {
    return null;
  }
}

function saveSession(session: Session | null): void {
  try {
    if (session) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: online play still works, you just can't resume after a refresh.
  }
}

/* ---------- The hook ---------- */

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface Multiplayer {
  status: ConnectionStatus;
  /** A join has been sent and the server has not answered yet (also true while resuming). */
  joining: boolean;
  /** The room this tab sits in, once the server has seated it. */
  roomCode: string | null;
  /** Who is in the room (for the lobby). */
  room: RoomSummary | null;
  /** The game, as this player may see it. Null until the fourth player joins. */
  gameState: GameState | null;
  /** The seat this tab plays (0 = East). Null until the game starts. */
  mySeat: SeatIndex | null;
  /** Why joining or connecting failed. */
  error: string | null;
  /** Why the last move was rejected; cleared by the next update from the server. */
  actionError: string | null;
  /** Server time minus this device's time (ms), for counting down to the server's deadlines. */
  clockOffsetMs: number;
  join: (code: string, name: string) => void;
  leave: () => void;
  sendAction: (action: GameAction) => void;
  /** Host only, before the game starts: pick the turn time (the claim time follows). */
  updateSettings: (turnTimeMs: number) => void;
  /** Quick chat: tell the other players you sent this emoji. */
  sendEmoji: (emoji: string) => void;
}

/**
 * @param enabled  Connects only while true, so local play never opens a socket. Turning it off
 *                 disconnects; turning it back on resumes the same seat with the saved token.
 */
export function useMultiplayer(
  enabled = true,
  /** Called when another player's emoji arrives, with the seat that sent it. */
  onEmoji?: (seat: SeatIndex, emoji: string) => void,
): Multiplayer {
  // Kept in a ref so a new callback each render never reconnects the socket.
  const onEmojiRef = useRef(onEmoji);
  onEmojiRef.current = onEmoji;
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [joining, setJoining] = useState(false);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [mySeat, setMySeat] = useState<SeatIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  const resetTable = useCallback(() => {
    setJoining(false);
    setRoomCode(null);
    setRoom(null);
    setGameState(null);
    setMySeat(null);
    setActionError(null);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
      transports: ["websocket"],
    });
    socketRef.current = socket;
    setStatus("connecting");

    // Came back after a refresh or a mode switch: take the old seat back.
    sessionRef.current = loadSession();
    if (sessionRef.current) setJoining(true);

    // Runs on the first connect AND on every automatic reconnect. The server forgets which
    // socket was yours when it drops, so the token has to be shown again each time.
    const sendJoin = () => {
      const session = sessionRef.current;
      if (!session) return;
      socket.emit("join_room", {
        code: session.code,
        name: session.name,
        ...(session.token ? { token: session.token } : {}),
      });
    };

    socket.on("connect", () => {
      setStatus("connected");
      setError(null);
      sendJoin();
    });
    socket.on("disconnect", () => setStatus("disconnected"));
    socket.on("connect_error", () => {
      setStatus("disconnected");
      setError("Can't reach the game server. Retrying…");
    });

    socket.on("room_joined", (info) => {
      const session: Session = {
        code: info.code,
        name: sessionRef.current?.name ?? "",
        token: info.token,
      };
      sessionRef.current = session;
      saveSession(session);
      setRoomCode(info.code);
      setMySeat(info.seat as SeatIndex);
      setJoining(false);
      setError(null);
    });

    socket.on("room_update", (summary) => setRoom(summary));

    socket.on("game_state", (view) => {
      setGameState(unwireState(view));
      // Half the trip time is lost in transit, but that is far smaller than a skewed clock.
      if (typeof view.serverTime === "number") setClockOffsetMs(view.serverTime - Date.now());
      // The authoritative seat: it can differ from the join-time seat if someone left the lobby.
      if (view.viewer.seat !== null) setMySeat(view.viewer.seat);
      setActionError(null);
    });

    socket.on("join_error", (e) => {
      // A bad or stale seat should not be retried on every reconnect.
      sessionRef.current = null;
      saveSession(null);
      resetTable();
      setError(e.message);
    });

    socket.on("action_error", (e) => {
      // "stale_action" just means two clicks crossed with an update; nothing to tell the player.
      if (e.code !== "stale_action") setActionError(e.message);
    });

    socket.on("chat_emoji", (message) => {
      if (message.seat >= 0 && message.seat <= 3) {
        onEmojiRef.current?.(message.seat as SeatIndex, message.emoji);
      }
    });

    socket.on("replaced", () => {
      sessionRef.current = null;
      saveSession(null);
      resetTable();
      setError("Another tab or device took over this seat.");
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      resetTable();
    };
  }, [enabled, resetTable]);

  const join = useCallback((code: string, name: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    const session: Session = { code: code.trim().toUpperCase(), name: name.trim() };
    sessionRef.current = session;
    setError(null);
    setJoining(true);
    // Not connected yet? The "connect" handler sends the join as soon as it is.
    if (socket.connected) {
      socket.emit("join_room", { code: session.code, ...(session.name ? { name: session.name } : {}) });
    }
  }, []);

  const leave = useCallback(() => {
    socketRef.current?.emit("leave_room");
    sessionRef.current = null;
    saveSession(null);
    resetTable();
    setError(null);
  }, [resetTable]);

  const sendAction = useCallback((action: GameAction) => {
    socketRef.current?.emit("player_action", action);
  }, []);

  const sendEmoji = useCallback((emoji: string) => {
    socketRef.current?.emit("chat_emoji", { emoji });
  }, []);

  const updateSettings = useCallback((turnTimeMs: number) => {
    socketRef.current?.emit("update_settings", { turnTimeMs });
  }, []);

  return {
    status,
    joining,
    roomCode,
    room,
    gameState,
    mySeat,
    error,
    actionError,
    clockOffsetMs,
    join,
    leave,
    sendAction,
    updateSettings,
    sendEmoji,
  };
}
