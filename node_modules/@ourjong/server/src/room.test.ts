import { describe, expect, it } from "vitest";
import { RoomError, RoomManager, SEATS_PER_ROOM, normalizeRoomCode } from "./room.ts";
import type { Room } from "./room.ts";

/** A manager with predictable ids, seeds and clock. */
function manager() {
  let n = 0;
  let clock = 1_000;
  const rooms = new RoomManager({
    now: () => clock,
    makeSeed: () => `seed-${++n}`,
    makePlayerId: () => `p${++n}`,
    makeToken: () => `token-${++n}`,
    makeCode: () => "WXYZ",
  });
  return { rooms, tick: (ms: number) => (clock += ms) };
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof RoomError ? error.code : "other";
  }
  return "no error";
};

/** Four sockets s0..s3 join ABCD; the fourth starts the game. */
function fullRoom() {
  const { rooms, tick } = manager();
  const results = [0, 1, 2, 3].map((i) => rooms.join("ABCD", { socketId: `s${i}`, name: `Player${i}` }));
  const room = rooms.getRoom("ABCD") as Room;
  return { rooms, tick, results, room };
}

/** Seat 0 (East) holds 13 tiles + the drawn one after the automatic hand-start. */
const eastDiscard = (room: Room, seq?: number) => {
  const state = room.state!;
  const tile = state.players[0]!.drawnTile!;
  return { type: "discard", seq: seq ?? state.history.length, seat: 0, tile: { id: tile.id } };
};

describe("room codes", () => {
  it("accepts four letters in any case", () => {
    expect(normalizeRoomCode("abcd")).toBe("ABCD");
    expect(normalizeRoomCode(" ZXQW ")).toBe("ZXQW");
  });

  it("rejects anything else", () => {
    for (const bad of ["ABC", "ABCDE", "AB1D", "", "AB D", 42, null, undefined]) {
      expect(codeOf(() => normalizeRoomCode(bad))).toBe("bad_code");
    }
  });
});

describe("joining", () => {
  it("creates the room on first join and seats players in join order", () => {
    const { rooms } = manager();
    const first = rooms.join("abcd", { socketId: "s0", name: "Ann" });
    const second = rooms.join("ABCD", { socketId: "s1" });
    expect(first.seatIndex).toBe(0);
    expect(second.seatIndex).toBe(1);
    expect(second.seat.name).toBe("Player 2");
    expect(rooms.getRoom("ABCD")!.seats).toHaveLength(2);
    expect(first.started).toBe(false);
    expect(rooms.getRoom("ABCD")!.state).toBeNull();
  });

  it("starts the game with initializeHKOSGame when the fourth player joins", () => {
    const { results, room } = fullRoom();
    expect(results.map((r) => r.started)).toEqual([false, false, false, true]);
    const state = room.state!;
    expect(state.players).toHaveLength(SEATS_PER_ROOM);
    expect(state.players.map((p) => p.id)).toEqual(room.seats.map((s) => s.playerId));
    expect(state.players.map((p) => p.name)).toEqual(["Player0", "Player1", "Player2", "Player3"]);
    expect(state.players.map((p) => p.seatWind)).toEqual(["east", "south", "west", "north"]);
    expect(state.id).toBe("ABCD");
    // The hand has started: East holds a 14th tile and must act.
    expect(state.phase).toMatchObject({ type: "action", seat: 0 });
    expect(state.players[0]!.drawnTile).not.toBeNull();
    expect(state.players[1]!.hand).toHaveLength(13);
  });

  it("refuses a fifth player", () => {
    const { rooms } = fullRoom();
    expect(codeOf(() => rooms.join("ABCD", { socketId: "s9" }))).toBe("room_full");
  });

  it("lets a player reclaim their seat with the token, replacing the old socket", () => {
    const { rooms, results, room } = fullRoom();
    const mine = results[2]!;
    const back = rooms.join("ABCD", { socketId: "s7", token: mine.seat.token });
    expect(back.reconnected).toBe(true);
    expect(back.seatIndex).toBe(2);
    expect(back.replacedSocketId).toBe("s2");
    expect(room.seats[2]!.socketId).toBe("s7");
    expect(rooms.sessionOf("s2")).toBeUndefined();
    expect(rooms.sessionOf("s7")!.playerId).toBe(mine.seat.playerId);
  });

  it("does not seat a stranger with a wrong token in a full room", () => {
    const { rooms } = fullRoom();
    expect(codeOf(() => rooms.join("ABCD", { socketId: "s9", token: "nope" }))).toBe("room_full");
  });
});

describe("disconnecting", () => {
  it("frees the seat before the game starts and removes an empty room", () => {
    const { rooms } = manager();
    rooms.join("ABCD", { socketId: "s0" });
    rooms.join("ABCD", { socketId: "s1" });
    expect(rooms.detach("s0")!.freedSeat).toBe(true);
    expect(rooms.getRoom("ABCD")!.seats).toHaveLength(1);
    rooms.detach("s1");
    expect(rooms.getRoom("ABCD")).toBeUndefined();
  });

  it("keeps the seat once the game is running so the player can come back", () => {
    const { rooms, room } = fullRoom();
    expect(rooms.detach("s1")!.freedSeat).toBe(false);
    expect(room.seats).toHaveLength(4);
    expect(room.seats[1]!.socketId).toBeNull();
  });

  it("prunes rooms that nobody is connected to after the idle time", () => {
    const { rooms, tick } = fullRoom();
    for (const id of ["s0", "s1", "s2", "s3"]) rooms.detach(id);
    expect(rooms.prune(60_000)).toBe(0);
    tick(61_000);
    expect(rooms.prune(60_000)).toBe(1);
    expect(rooms.roomCount).toBe(0);
  });
});

describe("applyPlayerAction", () => {
  it("runs a valid action through the engine and stores the new state", () => {
    const { rooms, room } = fullRoom();
    const before = room.state!;
    const { state } = rooms.applyPlayerAction("s0", eastDiscard(room));
    expect(room.state).toBe(state);
    expect(state).not.toBe(before);
    expect(state.history.length).toBe(before.history.length + 1);
    expect(state.players[0]!.discards).toHaveLength(1);
    expect(before.players[0]!.discards).toHaveLength(0); // the old state is untouched
  });

  it("takes the real tile from the player's hand, whatever face the client claims", () => {
    const { rooms, room } = fullRoom();
    const real = room.state!.players[0]!.drawnTile!;
    const lie = { id: real.id, face: { kind: "dragon", dragon: "red" } };
    const { state } = rooms.applyPlayerAction("s0", { ...eastDiscard(room), tile: lie });
    expect(state.players[0]!.discards[0]!.tile).toEqual(real);
  });

  it("rejects an action for someone else's seat", () => {
    const { rooms, room } = fullRoom();
    const before = room.state;
    // Seat 1's socket pretends to be East.
    expect(codeOf(() => rooms.applyPlayerAction("s1", eastDiscard(room)))).toBe("forbidden_action");
    expect(room.state).toBe(before);
  });

  it("rejects tiles the player does not hold", () => {
    const { rooms, room } = fullRoom();
    const theirs = room.state!.players[1]!.hand[0]!;
    const bad = { ...eastDiscard(room), tile: { id: theirs.id } };
    expect(codeOf(() => rooms.applyPlayerAction("s0", bad))).toBe("illegal_action");
  });

  it("rejects stale actions (wrong sequence number)", () => {
    const { rooms, room } = fullRoom();
    expect(codeOf(() => rooms.applyPlayerAction("s0", eastDiscard(room, 99)))).toBe("stale_action");
  });

  it("rejects what the engine refuses and leaves the state alone", () => {
    const { rooms, room } = fullRoom();
    const before = room.state;
    // South tries to draw on East's turn.
    const draw = { type: "draw", seq: before!.history.length, seat: 1, tile: {} };
    expect(codeOf(() => rooms.applyPlayerAction("s1", draw))).toBe("illegal_action");
    expect(room.state).toBe(before);
  });

  it("rejects action types and system events clients may not send", () => {
    const { rooms, room } = fullRoom();
    const seq = room.state!.history.length;
    expect(codeOf(() => rooms.applyPlayerAction("s0", { type: "pung", seq, seat: 0 }))).toBe("forbidden_action");
    expect(codeOf(() => rooms.applyPlayerAction("s0", { type: "system", seq, event: "hand-start" }))).toBe("forbidden_action");
    expect(codeOf(() => rooms.applyPlayerAction("s0", "nonsense"))).toBe("forbidden_action");
    expect(codeOf(() => rooms.applyPlayerAction("s0", null))).toBe("forbidden_action");
  });

  it("rejects a client-claimed win that is not a self-draw", () => {
    const { rooms, room } = fullRoom();
    const seq = room.state!.history.length;
    expect(codeOf(() => rooms.applyPlayerAction("s0", { type: "win", seq, seat: 0, method: "discard" }))).toBe("illegal_action");
  });

  it("needs a seat and a started game", () => {
    const { rooms } = manager();
    expect(codeOf(() => rooms.applyPlayerAction("ghost", {}))).toBe("not_in_room");
    rooms.join("ABCD", { socketId: "s0" });
    expect(codeOf(() => rooms.applyPlayerAction("s0", {}))).toBe("game_not_started");
  });
});

describe("next hand", () => {
  it("is refused while the hand is still being played", () => {
    const { rooms, room } = fullRoom();
    const seq = room.state!.history.length;
    expect(codeOf(() => rooms.applyPlayerAction("s0", { type: "system", seq, event: "round-advance" }))).toBe("illegal_action");
  });

  it("deals a fresh game with a new seed once the hand has ended", () => {
    const { rooms, room } = fullRoom();
    const oldSeed = room.state!.random.seed;
    room.state = { ...room.state!, phase: { type: "hand-end", reason: "exhaustive-draw" } };
    const seq = room.state.history.length;
    const { state } = rooms.applyPlayerAction("s3", { type: "system", seq, event: "round-advance" });
    expect(state.phase).toMatchObject({ type: "action", seat: 0 });
    expect(state.random.seed).not.toBe(oldSeed);
    expect(state.history).toHaveLength(1); // just the new hand-start draw
    expect(state.players.map((p) => p.id)).toEqual(room.seats.map((s) => s.playerId));
  });
});