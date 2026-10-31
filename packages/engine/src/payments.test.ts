import { describe, expect, it } from "vitest";
import { initializeHKOSGame } from "./game.ts";
import { matchStatus, processAction } from "./moves.ts";
import {
  PAYOUT_FAN_CAP,
  SELF_DRAW_BONUS,
  applyPayments,
  matchStandings,
  settleWin,
} from "./scoring.ts";
import type {
  ClaimAction,
  GameState,
  Scores,
  SeatIndex,
  SuitRank,
  SystemAction,
  Tile,
  TileFace,
  WinAction,
} from "./types.ts";

const IDS: [string, string, string, string] = ["p1", "p2", "p3", "p4"];
const T0 = 1_700_000_000_000;

/* ---------- Hand-built tiles ---------- */

let nextTileId = 5000;
const mk = (face: TileFace): Tile => ({ id: nextTileId++, face, copy: 0 });
const bam = (rank: SuitRank) => mk({ kind: "suit", suit: "bamboo", rank });
const chr = (rank: SuitRank) => mk({ kind: "suit", suit: "characters", rank });
const dts = (rank: SuitRank) => mk({ kind: "suit", suit: "dots", rank });
const dragon = (d: "red" | "green" | "white") => mk({ kind: "dragon", dragon: d });

/** 13 tiles that win on bamboo 5: three dragon pungs, a dots chow, a lone 5. Worth 3+ fan. */
const winningHand = (): Tile[] => [
  ...(["red", "green", "white"] as const).flatMap((d) => [dragon(d), dragon(d), dragon(d)]),
  dts(1),
  dts(2),
  dts(3),
  bam(5),
];

/** Tiles that cannot win or claim a bamboo 5. */
const filler = (): Tile[] => [
  chr(1), chr(3), chr(5), chr(7), chr(9),
  dts(1), dts(3), dts(5), dts(7), dts(9),
  mk({ kind: "wind", wind: "east" }),
  mk({ kind: "wind", wind: "south" }),
  mk({ kind: "wind", wind: "west" }),
];

const handStart: SystemAction = { type: "system", seq: 0, event: "hand-start", payload: { timestamp: T0 } };

const fresh = (): GameState => initializeHKOSGame("pay", IDS, "pay-seed");
const started = (): GameState => processAction(fresh(), handStart);

/** `seat` is on the move holding a completed hand with bamboo 5 just drawn. */
function selfDrawReady(seat: SeatIndex, patch: Partial<GameState> = {}): GameState {
  const base = started();
  return {
    ...base,
    ...patch,
    currentTurn: seat,
    phase: { type: "action", seat },
    players: base.players.map((p) =>
      p.seat === seat ? { ...p, hand: winningHand(), drawnTile: bam(5) } : { ...p, drawnTile: null },
    ),
  };
}

const selfDrawWin = (state: GameState, seat: SeatIndex): WinAction => ({
  type: "win",
  seq: state.history.length,
  seat,
  timestamp: T0 + 5000,
  method: "self-draw",
  winningTile: state.players[seat].drawnTile as Tile,
});

/** Seat 0 (the dealer) discards bamboo 5, and `winner` holds a hand that wins on it. */
function discardWindow(winner: SeatIndex): GameState {
  const base = started();
  const discard = bam(5);
  const rigged: GameState = {
    ...base,
    players: base.players.map((p) =>
      p.seat === 0
        ? { ...p, drawnTile: discard }
        : { ...p, hand: p.seat === winner ? winningHand().slice(0, 12).concat(bam(5)) : filler() },
    ),
  };
  return processAction(rigged, {
    type: "discard",
    seq: rigged.history.length,
    seat: 0,
    timestamp: T0 + 1000,
    tile: discard,
    fromDraw: true,
  });
}

const winClaim = (state: GameState, seat: SeatIndex): ClaimAction => ({
  type: "claim",
  seq: state.history.length,
  seat,
  timestamp: T0 + 4000,
  payload: { kind: "win", usingTiles: [] },
});

const nextHand = (state: GameState, seed = "next"): GameState =>
  processAction(state, {
    type: "system",
    seq: state.history.length,
    event: "round-advance",
    payload: { seed, timestamp: T0 },
  });

const total = (scores: Scores): number => scores.reduce((a, b) => a + b, 0);

/* ---------- The payment table ---------- */

describe("payment table", () => {
  it("has a self-draw bonus of one point on top of the fan payout", () => {
    expect(SELF_DRAW_BONUS).toBe(1);
    expect(PAYOUT_FAN_CAP).toBe(8);
  });

  it("self-draw: each of the three opponents pays the winner base + 1", () => {
    expect(settleWin(4, { winners: [2], selfDrawn: true })).toEqual([
      { from: 0, to: 2, amount: 2 },
      { from: 1, to: 2, amount: 2 },
      { from: 3, to: 2, amount: 2 },
    ]);
  });

  it("discard win: only the chucker pays, the base", () => {
    expect(settleWin(4, { winners: [1], selfDrawn: false, chucker: 3 })).toEqual([
      { from: 3, to: 1, amount: 1 },
    ]);
  });

  it("a discard win with no chucker, or a seat paying itself, moves nothing", () => {
    expect(settleWin(4, { winners: [1], selfDrawn: false })).toEqual([]);
    expect(settleWin(4, { winners: [1], selfDrawn: false, chucker: 1 })).toEqual([]);
  });

  it("applyPayments moves points without creating any, and leaves its input alone", () => {
    const before: Scores = [0, 0, 0, 0];
    const after = applyPayments(before, settleWin(4, { winners: [0], selfDrawn: true }));
    expect(after).toEqual([6, -2, -2, -2]);
    expect(before).toEqual([0, 0, 0, 0]);
    expect(total(after)).toBe(0);
  });
});

/* ---------- Paying out through the reducer ---------- */

describe("a self-drawn win (zimo)", () => {
  it("the dealer collects 9 (a 3 fan hand is 8, plus 1 for the self-draw) from each opponent", () => {
    const state = selfDrawReady(0);
    const next = processAction(state, selfDrawWin(state, 0));

    expect(next.round.scores).toEqual([27, -9, -9, -9]);
    expect(next.players.map((p) => p.score)).toEqual([27, -9, -9, -9]);
    expect(next.phase).toMatchObject({
      type: "hand-end",
      reason: "win-self-draw",
      winners: [0],
      totalFan: 3,
      payments: [
        { from: 1, to: 0, amount: 9 },
        { from: 2, to: 0, amount: 9 },
        { from: 3, to: 0, amount: 9 },
      ],
    });
  });

  it("a non-dealer collects the same from all three, the dealer included", () => {
    const state = selfDrawReady(2);
    const next = processAction(state, selfDrawWin(state, 2));
    expect(next.round.scores).toEqual([-9, -9, 27, -9]);
    expect(total(next.round.scores)).toBe(0);
  });

  it("does not touch the previous state", () => {
    const state = selfDrawReady(1);
    const snapshot = structuredClone(state);
    processAction(state, selfDrawWin(state, 1));
    expect(state).toEqual(snapshot);
  });
});

describe("a win on a discard (ron)", () => {
  it("only the chucker pays, and only the fan payout (3 fan is 8)", () => {
    const window = discardWindow(3);
    const next = processAction(window, winClaim(window, 3));

    expect(next.round.scores).toEqual([-8, 0, 0, 8]);
    expect(next.players.map((p) => p.score)).toEqual([-8, 0, 0, 8]);
    expect(next.phase).toMatchObject({
      type: "hand-end",
      reason: "win-discard",
      winners: [3],
      payments: [{ from: 0, to: 3, amount: 8 }],
    });
  });

  it("the other two players neither pay nor receive", () => {
    const window = discardWindow(2);
    const next = processAction(window, winClaim(window, 2));
    expect(next.round.scores[1]).toBe(0);
    expect(next.round.scores[3]).toBe(0);
  });
});

describe("a drawn hand", () => {
  it("moves no points and records no payments", () => {
    const state: GameState = {
      ...fresh(),
      round: { ...fresh().round, scores: [3, -1, -1, -1] },
      phase: { type: "hand-end", reason: "exhaustive-draw" },
    };
    const next = nextHand(state);
    expect(next.round.scores).toEqual([3, -1, -1, -1]);
    expect(next.players.map((p) => p.score)).toEqual([3, -1, -1, -1]);
  });
});

/* ---------- Scores over a whole match ---------- */

describe("running totals", () => {
  it("carry from hand to hand and add up", () => {
    // Hand 1: the dealer wins a self-draw, so they keep the deal.
    const first = selfDrawReady(0);
    const afterFirst = processAction(first, selfDrawWin(first, 0));
    expect(afterFirst.round.scores).toEqual([27, -9, -9, -9]);

    // Hand 2: same dealer, new deal. Seat 3 wins on seat 0's discard.
    const dealt = processAction(nextHand(afterFirst), handStart);
    expect(dealt.round.scores).toEqual([27, -9, -9, -9]);
    expect(dealt.players.map((p) => p.score)).toEqual([27, -9, -9, -9]);

    const rigged: GameState = {
      ...dealt,
      players: dealt.players.map((p) =>
        p.seat === 0
          ? { ...p, drawnTile: bam(5) }
          : { ...p, hand: p.seat === 3 ? winningHand().slice(0, 12).concat(bam(5)) : filler() },
      ),
    };
    const window = processAction(rigged, {
      type: "discard",
      seq: rigged.history.length,
      seat: 0,
      timestamp: T0 + 1000,
      tile: rigged.players[0].drawnTile as Tile,
      fromDraw: true,
    });
    const afterSecond = processAction(window, winClaim(window, 3));

    expect(afterSecond.round.scores).toEqual([19, -9, -9, -1]);
    expect(total(afterSecond.round.scores)).toBe(0);
  });
});

/* ---------- The end of the match ---------- */

describe("match completion", () => {
  /** The very last hand of the South round: seat 3 deals. `scores` are the totals going in. */
  const lastHand = (scores: Scores, dealer: SeatIndex = 3): GameState => ({
    ...selfDrawReady(1),
    round: { prevailingWind: "south", dealerSeat: dealer, handNumber: 5, dealerRepeats: 0, scores },
  });

  it("a non-dealer winning the last hand of the South round ends the match", () => {
    const state = lastHand([4, -1, -1, -2]);
    const won = processAction(state, selfDrawWin(state, 1));
    expect(won.round.scores).toEqual([-5, 26, -10, -11]);
    expect(matchStatus(won).matchEndsNext).toBe(true);

    const over = nextHand(won);
    expect(over.phase).toEqual({ type: "game-end" });
    // Nothing is paid or reset when the match ends: the totals are the result.
    expect(over.round.scores).toEqual([-5, 26, -10, -11]);
  });

  it("a dealer win on the last hand does not end it: the dealer repeats", () => {
    const state = lastHand([0, 0, 0, 0], 3);
    const dealerReady = selfDrawReady(3, { round: state.round });
    const won = processAction(dealerReady, selfDrawWin(dealerReady, 3));
    expect(matchStatus(won).matchEndsNext).toBe(false);
    const again = nextHand(won);
    expect(again.phase).toEqual({ type: "setup" });
    expect(again.round).toMatchObject({ prevailingWind: "south", dealerSeat: 3, dealerRepeats: 1 });
    expect(again.round.scores).toEqual([-9, -9, -9, 27]);
  });

  it("ranks the final standings from first to fourth, with names", () => {
    const state = lastHand([4, -1, -1, -2]);
    const named: GameState = {
      ...state,
      players: state.players.map((p) => ({ ...p, name: `P${p.seat}` })),
    };
    const won = processAction(named, selfDrawWin(named, 1));
    const over = nextHand(won);

    expect(matchStandings(over)).toEqual([
      { rank: 1, seat: 1, playerId: "p2", name: "P1", score: 26 },
      { rank: 2, seat: 0, playerId: "p1", name: "P0", score: -5 },
      { rank: 3, seat: 2, playerId: "p3", name: "P2", score: -10 },
      { rank: 4, seat: 3, playerId: "p4", name: "P3", score: -11 },
    ]);
  });

  it("gives tied players the same rank, in seat order", () => {
    const state: GameState = { ...fresh(), round: { ...fresh().round, scores: [3, 0, 0, -3] } };
    expect(matchStandings(state).map((s) => [s.rank, s.seat])).toEqual([
      [1, 0],
      [2, 1],
      [2, 2],
      [4, 3],
    ]);
  });

  it("starts the next match from zero, East round, seat 0 dealing", () => {
    const state = lastHand([4, -1, -1, -2]);
    const over = nextHand(processAction(state, selfDrawWin(state, 1)));
    const fresher = nextHand(over, "second-match");

    expect(fresher.round).toEqual({
      prevailingWind: "east",
      dealerSeat: 0,
      handNumber: 1,
      dealerRepeats: 0,
      scores: [0, 0, 0, 0],
    });
    expect(fresher.players.map((p) => p.score)).toEqual([0, 0, 0, 0]);
    expect(fresher.phase).toEqual({ type: "setup" });
  });
});

describe("a limit hand in play", () => {
  it("a self-drawn Thirteen Orphans is a legal win and pays the capped 256 (+1 for the self-draw)", () => {
    const orphans: Tile[] = [
      dts(1), dts(9), bam(1), bam(9), chr(1), chr(9),
      mk({ kind: "wind", wind: "east" }), mk({ kind: "wind", wind: "south" }),
      mk({ kind: "wind", wind: "west" }), mk({ kind: "wind", wind: "north" }),
      dragon("red"), dragon("green"), dragon("white"),
    ];
    const drawn = dts(1);
    const base = started();
    const state: GameState = {
      ...base,
      players: base.players.map((p) => (p.seat === 0 ? { ...p, hand: orphans, drawnTile: drawn } : p)),
    };
    const next = processAction(state, selfDrawWin(state, 0));

    expect(next.phase).toMatchObject({
      type: "hand-end",
      reason: "win-self-draw",
      totalFan: 13,
      patterns: ["Thirteen Orphans (13)"],
    });
    expect(next.round.scores).toEqual([771, -257, -257, -257]);
  });
});
