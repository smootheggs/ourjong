import { describe, expect, it } from "vitest";
import { initializeHKOSGame } from "./game.ts";
import { matchStatus, nextRoundInfo, processAction } from "./moves.ts";
import type { GameState, HandEndReason, RoundInfo, SeatIndex, WindName } from "./types.ts";

const IDS: [string, string, string, string] = ["p1", "p2", "p3", "p4"];
const T0 = 1_700_000_000_000;

/** A hand that has just ended, with the dealership as given. */
function ended(
  round: Partial<RoundInfo>,
  outcome: { reason: HandEndReason; winners?: SeatIndex[] },
  rules: Partial<GameState["rules"]> = {},
): GameState {
  const base = initializeHKOSGame("match", IDS, "match-seed");
  return {
    ...base,
    rules: { ...base.rules, ...rules },
    round: { ...base.round, ...round },
    phase: { type: "hand-end", ...outcome },
  };
}

const advance = (state: GameState, seed?: string) =>
  processAction(state, {
    type: "system",
    seq: state.history.length,
    event: "round-advance",
    payload: { timestamp: T0, ...(seed !== undefined ? { seed } : {}) },
  });

const windsOf = (state: GameState): WindName[] => state.players.map((p) => p.seatWind);

describe("dealership", () => {
  it("is kept when the dealer wins", () => {
    const next = advance(ended({}, { reason: "win-discard", winners: [0] }));
    expect(next.round).toEqual({ prevailingWind: "east", dealerSeat: 0, handNumber: 2, dealerRepeats: 1, scores: [0, 0, 0, 0] });
    expect(windsOf(next)).toEqual(["east", "south", "west", "north"]);
    expect(next.players.map((p) => p.isDealer)).toEqual([true, false, false, false]);
  });

  it("is kept on a self-draw win by the dealer and when the dealer is among several winners", () => {
    expect(advance(ended({}, { reason: "win-self-draw", winners: [0] })).round.dealerSeat).toBe(0);
    expect(advance(ended({}, { reason: "win-discard", winners: [2, 0] })).round.dealerSeat).toBe(0);
  });

  it("is kept after an exhaustive draw", () => {
    const next = advance(ended({}, { reason: "exhaustive-draw" }));
    expect(next.round).toMatchObject({ dealerSeat: 0, handNumber: 2, dealerRepeats: 1 });
  });

  it("counts consecutive repeats", () => {
    let state = ended({}, { reason: "exhaustive-draw" });
    for (let i = 1; i <= 3; i++) {
      state = { ...advance(state), phase: { type: "hand-end", reason: "exhaustive-draw" } };
      expect(state.round).toMatchObject({ dealerSeat: 0, handNumber: 1 + i, dealerRepeats: i });
    }
  });

  it("passes to the next seat when someone else wins", () => {
    const next = advance(ended({}, { reason: "win-discard", winners: [2] }));
    expect(next.round).toEqual({
      prevailingWind: "east",
      dealerSeat: 1,
      handNumber: 2,
      dealerRepeats: 0,
      scores: [0, 0, 0, 0],
    });
    expect(next.currentTurn).toBe(1);
  });

  it("resets the repeat count when the dealership moves", () => {
    const next = advance(ended({ dealerRepeats: 3, handNumber: 5 }, { reason: "win-self-draw", winners: [3] }));
    expect(next.round).toMatchObject({ dealerSeat: 1, handNumber: 6, dealerRepeats: 0 });
  });

  it("re-cuts the seat winds around the new dealer", () => {
    const next = advance(ended({}, { reason: "win-discard", winners: [3] }));
    // Dealer is seat 1: South's seat is now East, then seat 2 South, seat 3 West, seat 0 North.
    expect(windsOf(next)).toEqual(["north", "east", "south", "west"]);
    expect(next.players.map((p) => p.isDealer)).toEqual([false, true, false, false]);
  });

  it("lets the new dealer start: they take the first draw", () => {
    const dealt = advance(ended({ dealerSeat: 1 }, { reason: "win-discard", winners: [0] }));
    expect(dealt.round.dealerSeat).toBe(2);
    expect(dealt.phase).toEqual({ type: "setup" });
    const started = processAction(dealt, { type: "system", seq: 0, event: "hand-start", payload: { timestamp: T0 } });
    expect(started.phase).toMatchObject({ type: "action", seat: 2 });
    expect(started.players[2].drawnTile).not.toBeNull();
    expect(started.players.filter((p) => p.drawnTile !== null)).toHaveLength(1);
  });
});

describe("rounds", () => {
  it("advances the round wind when the dealership passes seat 3", () => {
    const next = advance(ended({ dealerSeat: 3, handNumber: 7 }, { reason: "win-discard", winners: [1] }));
    expect(next.round).toEqual({
      prevailingWind: "south",
      dealerSeat: 0,
      handNumber: 1,
      dealerRepeats: 0,
      scores: [0, 0, 0, 0],
    });
    expect(next.players[0].isDealer).toBe(true);
    expect(windsOf(next)).toEqual(["east", "south", "west", "north"]);
  });

  it("does not advance the wind when the last dealer keeps the dealership", () => {
    const next = advance(ended({ dealerSeat: 3 }, { reason: "exhaustive-draw" }));
    expect(next.round).toMatchObject({ prevailingWind: "east", dealerSeat: 3 });
  });

  it("ends the match after the South round by default (East and South)", () => {
    const last = ended({ prevailingWind: "south", dealerSeat: 3 }, { reason: "win-discard", winners: [0] });
    expect(nextRoundInfo(last)).toBeNull();
    const done = advance(last);
    expect(done.phase).toEqual({ type: "game-end" });
    expect(done.history[done.history.length - 1]).toMatchObject({ type: "system", event: "round-advance" });
  });

  it("honours matchRounds", () => {
    const eastOnly = ended({ dealerSeat: 3 }, { reason: "win-discard", winners: [2] }, { matchRounds: 1 });
    expect(advance(eastOnly).phase).toEqual({ type: "game-end" });

    const four = ended(
      { prevailingWind: "south", dealerSeat: 3 },
      { reason: "win-discard", winners: [2] },
      { matchRounds: 4 },
    );
    expect(advance(four).round).toMatchObject({ prevailingWind: "west", dealerSeat: 0 });
  });

  it("starts a fresh match from game-end: East round, seat 0 dealing, scores reset", () => {
    const over: GameState = {
      ...ended({ prevailingWind: "south", dealerSeat: 2, handNumber: 9 }, { reason: "exhaustive-draw" }),
      phase: { type: "game-end" },
    };
    const scored: GameState = {
      ...over,
      round: { ...over.round, scores: [30, -10, -10, -10] },
      players: over.players.map((p) => ({ ...p, score: 50 })),
    };
    const next = advance(scored);
    expect(next.round).toEqual({
      prevailingWind: "east",
      dealerSeat: 0,
      handNumber: 1,
      dealerRepeats: 0,
      scores: [0, 0, 0, 0],
    });
    expect(next.phase).toEqual({ type: "setup" });
    expect(next.players.every((p) => p.score === 0)).toBe(true);
  });
});

describe("the next deal", () => {
  it("is a fresh, complete deal from the seed it is given", () => {
    const state = ended({}, { reason: "exhaustive-draw" });
    const a = advance(state, "seed-A");
    const b = advance(state, "seed-A");
    const c = advance(state, "seed-B");

    expect(a.random.seed).toBe("seed-A");
    expect(a.players.every((p) => p.hand.length === 13)).toBe(true);
    expect(a.wall.deadWall).toHaveLength(16);
    expect(a.history).toEqual([]);
    expect(a.lastDiscard).toBeNull();
    expect(a.players[0].hand.map((t) => t.id)).toEqual(b.players[0].hand.map((t) => t.id));
    expect(a.players[0].hand.map((t) => t.id)).not.toEqual(c.players[0].hand.map((t) => t.id));
  });

  it("derives a seed from the old one when none is given, so replays stay deterministic", () => {
    const state = ended({}, { reason: "exhaustive-draw" });
    expect(advance(state).random.seed).toBe(`${state.random.seed}-next`);
  });

  it("carries names, bot levels, scores and the rules (clocks included) over", () => {
    const base = ended({}, { reason: "win-discard", winners: [1] }, { turnTimeMs: 30_000, claimTimeMs: 12_000 });
    const state: GameState = {
      ...base,
      round: { ...base.round, scores: [0, 10, 20, -30] },
      players: base.players.map((p) => ({ ...p, name: `Name${p.seat}` })),
    };
    const next = advance(state);
    expect(next.rules).toBe(state.rules);
    expect(next.players.map((p) => p.name)).toEqual(["Name0", "Name1", "Name2", "Name3"]);
    expect(next.round.scores).toEqual([0, 10, 20, -30]);
    expect(next.players.map((p) => p.score)).toEqual([0, 10, 20, -30]);
    expect(next.players.map((p) => p.id)).toEqual(IDS);
    // Seat 0 was the human (no difficulty) and stays that way; bots stay bots.
    expect(next.players.map((p) => p.difficulty)).toEqual([undefined, "medium", "medium", "medium"]);
  });

  it("is refused while a hand is still being played, and never changes the old state", () => {
    const playing = initializeHKOSGame("match", IDS, "s");
    expect(() => advance(playing)).toThrow();
    const over = ended({}, { reason: "exhaustive-draw" });
    const snapshot = structuredClone(over);
    advance(over);
    expect(over).toEqual(snapshot);
  });
});

describe("matchStatus", () => {
  it("reports the round, hand and dealer", () => {
    const status = matchStatus(initializeHKOSGame("match", IDS, "s"));
    expect(status).toMatchObject({
      prevailingWind: "east",
      dealerSeat: 0,
      handNumber: 1,
      dealerRepeats: 0,
      totalRounds: 2,
      roundNumber: 1,
      matchEndsNext: false,
      next: null,
    });
  });

  it("says what Next Hand will do once the hand is over", () => {
    expect(matchStatus(ended({}, { reason: "exhaustive-draw" })).next).toEqual({
      prevailingWind: "east",
      dealerSeat: 0,
      dealerStays: true,
    });
    expect(matchStatus(ended({}, { reason: "win-discard", winners: [3] })).next).toEqual({
      prevailingWind: "east",
      dealerSeat: 1,
      dealerStays: false,
    });
    const last = ended({ prevailingWind: "south", dealerSeat: 3 }, { reason: "win-discard", winners: [1] });
    expect(matchStatus(last)).toMatchObject({ roundNumber: 2, matchEndsNext: true, next: null });
  });
});
