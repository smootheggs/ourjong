import { describe, expect, it } from "vitest";
import { initializeHKOSGame } from "./game.ts";
import { CLAIM_TIME_MS, TURN_TIME_MS, processAction } from "./moves.ts";
import type { GameState, SuitRank, SystemAction, Tile } from "./types.ts";

const IDS: [string, string, string, string] = ["p1", "p2", "p3", "p4"];
const T0 = 1_700_000_000_000;

const handStart = (at?: number): SystemAction => ({
  type: "system",
  seq: 0,
  event: "hand-start",
  ...(at !== undefined ? { payload: { timestamp: at } } : {}),
});

/** A game whose rules have the online clocks switched on. */
const withClocks = (seed = "timer-seed"): GameState => {
  const state = initializeHKOSGame("g", IDS, seed);
  return { ...state, rules: { ...state.rules, turnTimeMs: TURN_TIME_MS, claimTimeMs: CLAIM_TIME_MS } };
};

let nextId = 5000;
const bam = (rank: SuitRank): Tile => ({
  id: nextId++,
  face: { kind: "suit", suit: "bamboo", rank },
  copy: 0,
});
const filler = (n: number): Tile[] =>
  Array.from({ length: n }, (_, i) => ({
    id: nextId++,
    face: { kind: "suit" as const, suit: "characters" as const, rank: ((i * 2) % 9 + 1) as SuitRank },
    copy: 0,
  }));

describe("turn clock", () => {
  it("is off unless the rules ask for it, even when actions carry timestamps", () => {
    const started = processAction(initializeHKOSGame("g", IDS, "s"), handStart(T0));
    expect(started.phase).toEqual({ type: "action", seat: 0 });
  });

  it("stamps the dealer's first turn with timestamp + turnTimeMs", () => {
    const started = processAction(withClocks(), handStart(T0));
    expect(started.phase).toEqual({ type: "action", seat: 0, deadline: T0 + TURN_TIME_MS });
  });

  it("sets no deadline without a timestamp, so replays stay deterministic", () => {
    const started = processAction(withClocks(), handStart());
    expect(started.phase).toEqual({ type: "action", seat: 0 });
  });

  it("honours custom clocks from the rules", () => {
    const base = initializeHKOSGame("g", IDS, "s");
    const state = { ...base, rules: { ...base.rules, turnTimeMs: 3000 } };
    expect(processAction(state, handStart(T0)).phase).toMatchObject({ deadline: T0 + 3000 });
  });

  it("treats 0 as no clock", () => {
    const base = initializeHKOSGame("g", IDS, "s");
    const state = { ...base, rules: { ...base.rules, turnTimeMs: 0 } };
    expect(processAction(state, handStart(T0)).phase).toEqual({ type: "action", seat: 0 });
  });

  it("restarts the clock on every draw", () => {
    let state = processAction(withClocks(), handStart(T0));
    // A lone red dragon that nobody holds a pair of, so nobody can claim it.
    const drawn: Tile = { id: nextId++, face: { kind: "dragon", dragon: "red" }, copy: 0 };
    state = {
      ...state,
      players: state.players.map((p) =>
        p.seat === 0 ? { ...p, drawnTile: drawn } : { ...p, hand: filler(13) },
      ),
    };
    state = processAction(state, {
      type: "discard",
      seq: state.history.length,
      seat: 0,
      timestamp: T0 + 1000,
      tile: drawn,
      fromDraw: true,
    });
    expect(state.phase).toEqual({ type: "draw", seat: 1 });
    state = processAction(state, {
      type: "draw",
      seq: state.history.length,
      seat: 1,
      timestamp: T0 + 9000,
      tile: state.wall.liveTiles[0],
      fromDeadWall: false,
    });
    expect(state.phase).toEqual({ type: "action", seat: 1, deadline: T0 + 9000 + TURN_TIME_MS });
  });
});

describe("claim clock", () => {
  /** East discards a bamboo 5 that both South and West could pung. */
  const claimScenario = () => {
    let state = processAction(withClocks(), handStart(T0));
    const five = bam(5);
    state = {
      ...state,
      players: state.players.map((p) => {
        if (p.seat === 0) return { ...p, drawnTile: five };
        if (p.seat === 1 || p.seat === 2) return { ...p, hand: [bam(5), bam(5), ...filler(11)] };
        return { ...p, hand: filler(13) };
      }),
    };
    return processAction(state, {
      type: "discard",
      seq: state.history.length,
      seat: 0,
      timestamp: T0 + 1000,
      tile: five,
      fromDraw: true,
    });
  };

  it("opens a claim window with timestamp + claimTimeMs", () => {
    const state = claimScenario();
    expect(state.phase).toMatchObject({ type: "claim-window", deadline: T0 + 1000 + CLAIM_TIME_MS });
  });

  it("is not extended by a pass", () => {
    const state = claimScenario();
    const next = processAction(state, {
      type: "pass",
      seq: state.history.length,
      seat: 1,
      timestamp: T0 + 5000,
    });
    expect(next.phase).toMatchObject({
      type: "claim-window",
      passed: [1],
      deadline: T0 + 1000 + CLAIM_TIME_MS,
    });
  });

  it("starts a fresh turn clock for the seat that claims", () => {
    const state = claimScenario();
    const pung = (state.phase as Extract<typeof state.phase, { type: "claim-window" }>).availableClaims.find(
      (c) => c.seat === 1 && c.kind === "pung",
    )!;
    const next = processAction(state, {
      type: "claim",
      seq: state.history.length,
      seat: 1,
      timestamp: T0 + 4000,
      payload: { kind: "pung", usingTiles: pung.usingTiles },
    });
    expect(next.phase).toEqual({ type: "action", seat: 1, deadline: T0 + 4000 + TURN_TIME_MS });
  });
});
