import { describe, expect, it } from "vitest";
import { CLAIM_TIME_MS, TURN_TIME_MS, initializeHKOSGame, processAction } from "@ourjong/engine";
import type { GameState } from "@ourjong/engine";
import { DRAW_GRACE_MS, RoomError, RoomManager, fallbackAction } from "./room.ts";
import type { Room } from "./room.ts";

const START = 1_000;

/** A manager with predictable ids, seeds and clock. */
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

function fullRoom() {
  const { rooms, tick } = manager();
  for (let i = 0; i < 4; i++) rooms.join("ABCD", { socketId: `s${i}`, name: `Player${i}` });
  return { rooms, tick, room: rooms.getRoom("ABCD") as Room };
}

const eastDiscard = (room: Room) => {
  const state = room.state!;
  return {
    type: "discard",
    seq: state.history.length,
    seat: 0,
    tile: { id: state.players[0]!.drawnTile!.id },
  };
};

describe("the clocks", () => {
  it("starts East's first turn with a deadline (this is what room.test.ts now expects)", () => {
    const { room } = fullRoom();
    expect(room.state!.phase).toEqual({ type: "action", seat: 0, deadline: START + TURN_TIME_MS });
  });

  it("puts the turn and claim clocks into the rules of every new hand", () => {
    const { room } = fullRoom();
    expect(room.state!.rules.turnTimeMs).toBe(TURN_TIME_MS);
    expect(room.state!.rules.claimTimeMs).toBe(CLAIM_TIME_MS);
  });

  it("can run without clocks", () => {
    const { rooms } = manager({ turnTimeMs: 0, claimTimeMs: 0 });
    for (let i = 0; i < 4; i++) rooms.join("ABCD", { socketId: `s${i}` });
    expect(rooms.getRoom("ABCD")!.state!.phase).toEqual({ type: "action", seat: 0 });
    expect(rooms.tick()).toEqual([]);
  });

  it("stamps actions with the server's time, whatever timestamp the client sends", () => {
    const { rooms, tick, room } = fullRoom();
    tick(500);
    const { state } = rooms.applyPlayerAction("s0", { ...eastDiscard(room), timestamp: 1 });
    expect(state.history[state.history.length - 1]).toMatchObject({ timestamp: START + 500 });
  });

  it("restarts the clock on the next hand", () => {
    const { rooms, tick, room } = fullRoom();
    tick(5_000);
    room.state = { ...room.state!, phase: { type: "hand-end", reason: "exhaustive-draw" } };
    const { state } = rooms.applyPlayerAction("s3", {
      type: "system",
      seq: room.state.history.length,
      event: "round-advance",
    });
    expect(state.phase).toEqual({ type: "action", seat: 0, deadline: START + 5_000 + TURN_TIME_MS });
  });
});

describe("tick", () => {
  it("does nothing while everyone is within their time", () => {
    const { rooms, tick, room } = fullRoom();
    const before = room.state;
    tick(TURN_TIME_MS - 1);
    expect(rooms.tick()).toEqual([]);
    expect(room.state).toBe(before);
  });

  it("discards the drawn tile when the turn runs out", () => {
    const { rooms, tick, room } = fullRoom();
    const drawn = room.state!.players[0]!.drawnTile!;
    tick(TURN_TIME_MS);
    expect(rooms.tick()).toEqual([room]);

    const state = room.state!;
    expect(state.players[0]!.drawnTile).toBeNull();
    expect(state.players[0]!.discards[0]!.tile).toEqual(drawn);
    expect(state.history[state.history.length - 1]).toMatchObject({
      type: "discard",
      seat: 0,
      fromDraw: true,
    });
  });

  it("keeps an absent table moving until the next player is on the clock", () => {
    const { rooms, tick, room } = fullRoom();
    tick(TURN_TIME_MS);
    rooms.tick(); // East's discard
    // Whatever followed (a claim window or a draw), a few more ticks bring South on the clock.
    for (let i = 0; i < 4 && room.state!.phase.type !== "action"; i++) {
      tick(Math.max(CLAIM_TIME_MS, DRAW_GRACE_MS));
      rooms.tick();
    }
    expect(room.state!.phase).toMatchObject({ type: "action", seat: 1 });
    expect((room.state!.phase as { deadline: number }).deadline).toBeGreaterThan(rooms.nowMs());
  });

  it("does not touch rooms that have not started", () => {
    const { rooms, tick } = manager();
    rooms.join("ABCD", { socketId: "s0" });
    tick(10 * TURN_TIME_MS);
    expect(rooms.tick()).toEqual([]);
  });

  it("survives a state the engine refuses", () => {
    const { rooms, tick, room } = fullRoom();
    // An expired turn for a seat with no tiles at all: nothing to discard.
    room.state = {
      ...room.state!,
      players: room.state!.players.map((p) => (p.seat === 0 ? { ...p, drawnTile: null, hand: [] } : p)),
    };
    tick(TURN_TIME_MS);
    expect(() => rooms.tick()).not.toThrow();
  });
});

describe("fallbackAction", () => {
  const started = (): GameState => {
    const base = initializeHKOSGame("g", ["a", "b", "c", "d"], "fb");
    return processAction(
      { ...base, rules: { ...base.rules, turnTimeMs: 1000, claimTimeMs: 1000 } },
      { type: "system", seq: 0, event: "hand-start", payload: { timestamp: 100 } },
    );
  };

  it("is null before the deadline", () => {
    expect(fallbackAction(started(), 1099)).toBeNull();
  });

  it("discards the drawn tile at the deadline", () => {
    const state = started();
    expect(fallbackAction(state, 1100)).toMatchObject({
      type: "discard",
      seat: 0,
      tile: state.players[0]!.drawnTile,
      fromDraw: true,
    });
  });

  it("discards from the hand when there is no drawn tile (after a claimed pung)", () => {
    const state = started();
    const noDraw: GameState = {
      ...state,
      players: state.players.map((p) =>
        p.seat === 0 ? { ...p, hand: [...p.hand, p.drawnTile!], drawnTile: null } : p,
      ),
    };
    const action = fallbackAction(noDraw, 2000);
    expect(action).toMatchObject({ type: "discard", seat: 0, fromDraw: false });
    const tile = (action as { tile: { id: number } }).tile;
    expect(noDraw.players[0]!.hand.some((t) => t.id === tile.id)).toBe(true);
  });

  it("passes for each seat that still owes an answer in an expired claim window", () => {
    const state = started();
    const tile = state.players[0]!.drawnTile!;
    const window = (passed: (0 | 1 | 2 | 3)[]): GameState => ({
      ...state,
      phase: {
        type: "claim-window",
        discardedBy: 0,
        tile,
        passed,
        deadline: 500,
        availableClaims: [
          { seat: 2, kind: "pung", usingTiles: [] },
          { seat: 3, kind: "pung", usingTiles: [] },
        ],
      },
    });
    expect(fallbackAction(window([]), 499)).toBeNull();
    expect(fallbackAction(window([]), 500)).toMatchObject({ type: "pass", seat: 2 });
    expect(fallbackAction(window([2]), 500)).toMatchObject({ type: "pass", seat: 3 });
    expect(fallbackAction(window([2, 3]), 500)).toBeNull();
  });

  it("draws for a seat that has been left waiting past the grace period", () => {
    const state = started();
    const waiting: GameState = {
      ...state,
      currentTurn: 1,
      phase: { type: "draw", seat: 1 },
      history: [...state.history, { type: "pass", seq: 1, seat: 2, timestamp: 10_000 }],
    };
    expect(fallbackAction(waiting, 10_000 + DRAW_GRACE_MS - 1)).toBeNull();
    expect(fallbackAction(waiting, 10_000 + DRAW_GRACE_MS)).toMatchObject({ type: "draw", seat: 1 });
  });

  it("does nothing once the hand is over", () => {
    const state = { ...started(), phase: { type: "hand-end", reason: "exhaustive-draw" } } as GameState;
    expect(fallbackAction(state, 10 ** 12)).toBeNull();
  });
});

describe("room cap", () => {
  it("refuses to open more rooms than allowed, but still seats people in existing ones", () => {
    const rooms = new RoomManager({ maxRooms: 2 });
    rooms.join("AAAA", { socketId: "a" });
    rooms.join("BBBB", { socketId: "b" });
    expect(codeOf(() => rooms.join("CCCC", { socketId: "c" }))).toBe("server_busy");
    expect(() => rooms.join("AAAA", { socketId: "d" })).not.toThrow();
  });
});
