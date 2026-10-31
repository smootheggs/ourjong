import { describe, expect, it } from "vitest";
import type { GameState, HandEndReason, SeatIndex } from "@ourjong/engine";
import { RoomError, RoomManager, TURN_TIME_OPTIONS_MS, claimTimeFor } from "./room.ts";
import type { Room } from "./room.ts";
import { parseSettingsPayload } from "./socket.ts";

const START = 1_000;

function manager(options: ConstructorParameters<typeof RoomManager>[0] = {}) {
  let n = 0;
  let clock = START;
  const rooms = new RoomManager({
    now: () => clock,
    makeSeed: () => `seed-${++n}`,
    makePlayerId: () => `p${++n}`,
    makeToken: () => `token-${++n}`,
    ...options,
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

/** Three players have joined; the fourth (s3) starts the game. */
function fill(rooms: RoomManager, upTo = 4) {
  for (let i = 0; i < upTo; i++) rooms.join("ABCD", { socketId: `s${i}`, name: `Player${i}` });
  return rooms.getRoom("ABCD") as Room;
}

/** Puts the room's hand into `hand-end` and lets `socketId` press Next Hand. */
function nextHand(
  rooms: RoomManager,
  room: Room,
  outcome: { reason: HandEndReason; winners?: SeatIndex[] },
  socketId = "s3",
): GameState {
  room.state = { ...room.state!, phase: { type: "hand-end", ...outcome } };
  return rooms.applyPlayerAction(socketId, {
    type: "system",
    seq: room.state.history.length,
    event: "round-advance",
  }).state;
}

describe("host settings", () => {
  it("starts from the defaults: 15 s turns, 7 s claims", () => {
    const { rooms } = manager();
    const room = fill(rooms, 1);
    expect(room.settings).toEqual({ turnTimeMs: 15_000, claimTimeMs: 7_000 });
  });

  it("lets the host (first seat) pick a turn time, and derives the claim time", () => {
    const { rooms } = manager();
    const room = fill(rooms, 2);
    for (const turn of TURN_TIME_OPTIONS_MS) {
      rooms.updateSettings("s0", turn);
      expect(room.settings).toEqual({ turnTimeMs: turn, claimTimeMs: claimTimeFor(turn) });
    }
    expect(claimTimeFor(10_000)).toBe(5_000);
    expect(claimTimeFor(15_000)).toBe(7_000);
    expect(claimTimeFor(30_000)).toBe(12_000);
    expect(claimTimeFor(0)).toBe(0);
  });

  it("refuses everyone but the host", () => {
    const { rooms } = manager();
    const room = fill(rooms, 3);
    expect(codeOf(() => rooms.updateSettings("s1", 30_000))).toBe("forbidden_action");
    expect(codeOf(() => rooms.updateSettings("s2", 30_000))).toBe("forbidden_action");
    expect(room.settings.turnTimeMs).toBe(15_000);
  });

  it("refuses values that are not on the menu", () => {
    const { rooms } = manager();
    fill(rooms, 2);
    for (const bad of [1, 12_345, -1, 1e9, NaN, "15000", null, undefined]) {
      expect(codeOf(() => rooms.updateSettings("s0", bad))).toBe("bad_payload");
    }
  });

  it("needs a seat, and is locked once the game starts", () => {
    const { rooms } = manager();
    expect(codeOf(() => rooms.updateSettings("ghost", 10_000))).toBe("not_in_room");
    const room = fill(rooms);
    expect(codeOf(() => rooms.updateSettings("s0", 10_000))).toBe("forbidden_action");
    expect(room.settings.turnTimeMs).toBe(15_000);
  });

  it("passes to the next player when the host leaves before the game starts", () => {
    const { rooms } = manager();
    const room = fill(rooms, 3);
    rooms.detach("s0");
    expect(codeOf(() => rooms.updateSettings("s0", 10_000))).toBe("not_in_room");
    expect(() => rooms.updateSettings("s1", 10_000)).not.toThrow();
    expect(room.settings.turnTimeMs).toBe(10_000);
  });
});

describe("the chosen clocks", () => {
  const start = (turn: number) => {
    const { rooms, tick } = manager();
    rooms.join("ABCD", { socketId: "s0", name: "Host" });
    rooms.updateSettings("s0", turn);
    for (let i = 1; i < 4; i++) rooms.join("ABCD", { socketId: `s${i}` });
    return { rooms, tick, room: rooms.getRoom("ABCD") as Room };
  };

  it("30 s turns", () => {
    const { room } = start(30_000);
    expect(room.state!.rules).toMatchObject({ turnTimeMs: 30_000, claimTimeMs: 12_000 });
    expect(room.state!.phase).toEqual({ type: "action", seat: 0, deadline: START + 30_000 });
  });

  it("10 s turns", () => {
    const { room } = start(10_000);
    expect(room.state!.rules).toMatchObject({ turnTimeMs: 10_000, claimTimeMs: 5_000 });
    expect(room.state!.phase).toEqual({ type: "action", seat: 0, deadline: START + 10_000 });
  });

  it("infinite means no clock at all, and the tick leaves the table alone", () => {
    const { rooms, tick, room } = start(0);
    expect(room.state!.rules.turnTimeMs).toBeUndefined();
    expect(room.state!.rules.claimTimeMs).toBeUndefined();
    expect(room.state!.phase).toEqual({ type: "action", seat: 0 });
    tick(24 * 60 * 60 * 1000);
    expect(rooms.tick()).toEqual([]);
  });

  it("carry into every later hand", () => {
    const { rooms, tick, room } = start(30_000);
    tick(1_000);
    const next = nextHand(rooms, room, { reason: "exhaustive-draw" });
    expect(next.rules.turnTimeMs).toBe(30_000);
    expect(next.phase).toEqual({ type: "action", seat: 0, deadline: START + 1_000 + 30_000 });
  });
});

describe("the match", () => {
  it("opens as East round, hand 1, seat 0 dealing", () => {
    const { rooms } = manager();
    const room = fill(rooms);
    expect(room.state!.round).toEqual({ prevailingWind: "east", dealerSeat: 0, handNumber: 1, dealerRepeats: 0, scores: [0, 0, 0, 0] });
  });

  it("keeps the dealer after a draw: same seat, next hand number, new deal", () => {
    const { rooms } = manager();
    const room = fill(rooms);
    const oldSeed = room.state!.random.seed;
    const next = nextHand(rooms, room, { reason: "exhaustive-draw" });
    expect(next.round).toEqual({ prevailingWind: "east", dealerSeat: 0, handNumber: 2, dealerRepeats: 1, scores: [0, 0, 0, 0] });
    expect(next.phase).toMatchObject({ type: "action", seat: 0 });
    expect(next.random.seed).not.toBe(oldSeed);
    expect(next.history).toHaveLength(1);
  });

  it("keeps the dealer after the dealer wins", () => {
    const { rooms } = manager();
    const room = fill(rooms);
    const next = nextHand(rooms, room, { reason: "win-self-draw", winners: [0] });
    expect(next.round).toMatchObject({ dealerSeat: 0, handNumber: 2, dealerRepeats: 1, scores: [0, 0, 0, 0] });
  });

  it("passes the dealership when someone else wins, and the new dealer plays first", () => {
    const { rooms } = manager();
    const room = fill(rooms);
    const next = nextHand(rooms, room, { reason: "win-discard", winners: [2] });
    expect(next.round).toEqual({ prevailingWind: "east", dealerSeat: 1, handNumber: 2, dealerRepeats: 0, scores: [0, 0, 0, 0] });
    expect(next.phase).toMatchObject({ type: "action", seat: 1 });
    expect(next.players[1]!.drawnTile).not.toBeNull();
    expect(next.players[0]!.drawnTile).toBeNull();
    expect(next.players.map((p) => p.seatWind)).toEqual(["north", "east", "south", "west"]);
    // Names and seats survive the new deal.
    expect(next.players.map((p) => p.name)).toEqual(["Player0", "Player1", "Player2", "Player3"]);
    expect(next.players.map((p) => p.id)).toEqual(room.seats.map((s) => s.playerId));
  });

  it("moves to the South round when the dealership comes back to seat 0", () => {
    const { rooms } = manager();
    const room = fill(rooms);
    let state: GameState = room.state!;
    for (let hand = 0; hand < 4; hand++) {
      const winner = ((state.round.dealerSeat + 1) % 4) as SeatIndex;
      state = nextHand(rooms, room, { reason: "win-discard", winners: [winner] });
    }
    expect(state.round).toEqual({ prevailingWind: "south", dealerSeat: 0, handNumber: 1, dealerRepeats: 0, scores: [0, 0, 0, 0] });
  });

  it("ends the match after the South round, and Next Hand then starts a new match", () => {
    const { rooms } = manager();
    const room = fill(rooms);
    room.state = {
      ...room.state!,
      round: { prevailingWind: "south", dealerSeat: 3, handNumber: 6, dealerRepeats: 0, scores: [0, 0, 0, 0] },
    };

    const over = nextHand(rooms, room, { reason: "win-discard", winners: [1] });
    expect(over.phase).toEqual({ type: "game-end" });

    // Anyone can start the next match.
    const fresh = rooms.applyPlayerAction("s2", {
      type: "system",
      seq: over.history.length,
      event: "round-advance",
    }).state;
    expect(fresh.round).toEqual({ prevailingWind: "east", dealerSeat: 0, handNumber: 1, dealerRepeats: 0, scores: [0, 0, 0, 0] });
    expect(fresh.phase).toMatchObject({ type: "action", seat: 0 });
  });

  it("will not deal the next hand while a hand is still being played", () => {
    const { rooms } = manager();
    const room = fill(rooms);
    expect(
      codeOf(() =>
        rooms.applyPlayerAction("s0", { type: "system", seq: room.state!.history.length, event: "round-advance" }),
      ),
    ).toBe("illegal_action");
  });

  it("deals every new hand from a seed the clients never see", () => {
    const { rooms } = manager();
    const room = fill(rooms);
    const seeds = new Set<string>([room.state!.random.seed]);
    for (let i = 0; i < 3; i++) seeds.add(nextHand(rooms, room, { reason: "exhaustive-draw" }).random.seed);
    expect(seeds.size).toBe(4);
  });
});

describe("parseSettingsPayload", () => {
  it("accepts each menu option", () => {
    for (const turnTimeMs of TURN_TIME_OPTIONS_MS) {
      expect(parseSettingsPayload({ turnTimeMs })).toEqual({ turnTimeMs });
    }
  });

  it("rejects everything else", () => {
    for (const bad of [null, undefined, 15_000, "15000", [], {}, { turnTimeMs: 7 }, { turnTimeMs: "10000" }]) {
      expect(codeOf(() => parseSettingsPayload(bad))).toBe("bad_payload");
    }
    // A client cannot choose the claim time, or smuggle in anything else.
    expect(codeOf(() => parseSettingsPayload({ turnTimeMs: 10_000, claimTimeMs: 1 }))).toBe("bad_payload");
    expect(codeOf(() => parseSettingsPayload({ turnTimeMs: 10_000, admin: true }))).toBe("bad_payload");
  });
});
