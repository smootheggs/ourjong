import { describe, expect, it } from "vitest";
import { initializeHKOSGame } from "./game.ts";
import { processAction } from "./moves.ts";
import type {
  ClaimAction,
  ClaimType,
  DiscardAction,
  DrawAction,
  GameState,
  KongAction,
  Meld,
  PassAction,
  SeatIndex,
  SuitRank,
  SystemAction,
  Tile,
  TileFace,
  WinAction,
} from "./types.ts";

const IDS: [string, string, string, string] = ["p1", "p2", "p3", "p4"];
const T0 = 1_700_000_000_000;

/* ---------- Action builders ---------- */

const handStart: SystemAction = {
  type: "system",
  seq: 0,
  event: "hand-start",
  payload: { timestamp: T0 },
};

const discardOf = (
  state: GameState,
  tile: Tile,
  fromDraw: boolean,
  seq = state.history.length,
): DiscardAction => ({
  type: "discard",
  seq,
  seat: state.currentTurn,
  timestamp: T0 + 1000,
  tile,
  fromDraw,
});

const passOf = (state: GameState, seat: SeatIndex): PassAction => ({
  type: "pass",
  seq: state.history.length,
  seat,
  timestamp: T0 + 2000,
});

const drawOf = (state: GameState, tile: Tile = state.wall.liveTiles[0]): DrawAction => ({
  type: "draw",
  seq: state.history.length,
  seat: state.currentTurn,
  timestamp: T0 + 3000,
  tile,
  fromDeadWall: false,
});

const claimOf = (
  state: GameState,
  seat: SeatIndex,
  kind: ClaimType,
  usingTiles: readonly Tile[] = [],
): ClaimAction => ({
  type: "claim",
  seq: state.history.length,
  seat,
  timestamp: T0 + 4000,
  payload: { kind, usingTiles },
});

const fresh = () => initializeHKOSGame("g1", IDS, "moves-seed");

/* ---------- Hand-built tiles and scenarios ---------- */

let nextTileId = 1000;
const mk = (face: TileFace): Tile => ({ id: nextTileId++, face, copy: 0 });
const bam = (rank: SuitRank) => mk({ kind: "suit", suit: "bamboo", rank });
const chr = (rank: SuitRank) => mk({ kind: "suit", suit: "characters", rank });
const dts = (rank: SuitRank) => mk({ kind: "suit", suit: "dots", rank });

/** Tiles that can never claim a bamboo-5 discard (no bamboo, no honors pairs, no wins). */
const filler = (n: number): Tile[] =>
  [
    chr(1), chr(3), chr(5), chr(7), chr(9),
    dts(1), dts(3), dts(5), dts(7), dts(9),
    mk({ kind: "wind", wind: "east" }),
    mk({ kind: "wind", wind: "south" }),
    mk({ kind: "wind", wind: "west" }),
  ].slice(0, n);

/** A 13-tile hand: the given tiles plus filler. */
const handOf = (...special: Tile[]): Tile[] => [...special, ...filler(13 - special.length)];

const rankOf = (tile: Tile) => (tile.face.kind === "suit" ? tile.face.rank : 0);
const rankText = (tiles: readonly Tile[]) =>
  tiles.map(rankOf).sort((a, b) => a - b).join("-");

const windowOf = (state: GameState) => {
  if (state.phase.type !== "claim-window") {
    throw new Error(`expected claim-window, got ${state.phase.type}`);
  }
  return state.phase;
};
const summary = (state: GameState) =>
  windowOf(state).availableClaims.map((c) => `${c.seat}:${c.kind}`);

const dragonTile = (dragon: "red" | "green" | "white") => mk({ kind: "dragon", dragon });

/**
 * A 13-tile hand that wins on `wait` (default bamboo 5) for at least 3 fan: three dragon
 * pungs, a dots chow and a single-tile wait. Hong Kong Old Style needs 3 fan to win.
 */
const winningHand = (wait: Tile = bam(5)) => [
  ...(["red", "green", "white"] as const).flatMap((d) => [dragonTile(d), dragonTile(d), dragonTile(d)]),
  ...[dts(1), dts(2), dts(3)],
  wait,
];

/** The same shape of hand, but all chows: complete on `wait`, yet worth under 3 fan. */
const cheapHand = (wait: Tile = bam(5)) => [
  ...[dts(1), dts(2), dts(3)],
  ...[dts(4), dts(5), dts(6)],
  ...[chr(7), chr(8), chr(9)],
  ...[chr(2), chr(3), chr(4)],
  wait,
];

/**
 * Starts a hand and has the dealer (seat 0) discard a bamboo 5.
 * Seats 1-3 get the supplied 13-tile hands, or non-claiming filler.
 */
function afterDealerDiscards(hands: Partial<Record<SeatIndex, Tile[]>> = {}) {
  const started = processAction(fresh(), handStart);
  const discard = bam(5);
  const rigged: GameState = {
    ...started,
    players: started.players.map((p) =>
      p.seat === 0 ? { ...p, drawnTile: discard } : { ...p, hand: hands[p.seat] ?? handOf() },
    ),
  };
  return { state: processAction(rigged, discardOf(rigged, discard, true)), discard };
}

/* ---------- Tests ---------- */

describe("processAction: hand-start", () => {
  const initial = fresh();
  const before = structuredClone(initial);
  const next = processAction(initial, handStart);
  const dealer = next.players[next.currentTurn];

  it("gives the dealer the top live tile as drawnTile", () => {
    expect(dealer.drawnTile).toEqual(initial.wall.liveTiles[0]);
  });

  it("shrinks the live wall by 1 and counts the draw", () => {
    expect(next.wall.liveTiles).toHaveLength(initial.wall.liveTiles.length - 1);
    expect(next.wall.liveTiles).toEqual(initial.wall.liveTiles.slice(1));
    expect(next.wall.drawCount).toBe(1);
    expect(next.wall.deadDrawCount).toBe(0);
  });

  it("moves to the action phase for the current turn", () => {
    expect(next.phase).toEqual({ type: "action", seat: next.currentTurn });
  });

  it("appends a fully populated DrawAction to history", () => {
    expect(next.history).toHaveLength(1);
    expect(next.history[0]).toEqual({
      type: "draw",
      seq: 0,
      seat: 0,
      timestamp: T0,
      tile: initial.wall.liveTiles[0],
      fromDeadWall: false,
    });
  });

  it("does not mutate the original state", () => {
    expect(initial).toEqual(before);
  });

  it("rejects hand-start outside the setup phase", () => {
    expect(() => processAction(next, handStart)).toThrow();
  });

  it("omits timestamp when none is supplied", () => {
    const result = processAction(fresh(), { type: "system", seq: 0, event: "hand-start" });
    expect(result.history[0]).not.toHaveProperty("timestamp");
  });
});

describe("processAction: discard", () => {
  const started = processAction(fresh(), handStart);
  const seat = started.currentTurn;
  const tile = started.players[seat].hand[0];
  const snapshot = structuredClone(started);
  const action = discardOf(started, tile, false);
  const next = processAction(started, action);
  const player = next.players[seat];

  it("puts the tile in the player's discards", () => {
    expect(player.discards).toEqual([{ tile, order: 0, fromDraw: false }]);
  });

  it("keeps 13 tiles in hand (drawn tile joins) and clears drawnTile", () => {
    expect(player.hand).toHaveLength(13);
    expect(player.hand.some((t) => t.id === tile.id)).toBe(false);
    expect(player.hand).toContainEqual(started.players[seat].drawnTile);
    expect(player.drawnTile).toBeNull();
  });

  it("populates lastDiscard", () => {
    expect(next.lastDiscard).toEqual({ tile, by: seat });
  });

  it("appends the DiscardAction to history", () => {
    expect(next.history).toHaveLength(2);
    expect(next.history[1]).toEqual(action);
  });

  it("does not mutate the previous state", () => {
    expect(started).toEqual(snapshot);
  });

  it("can discard the drawn tile directly", () => {
    const drawn = started.players[seat].drawnTile!;
    const result = processAction(started, discardOf(started, drawn, true));
    expect(result.players[seat].hand).toEqual(started.players[seat].hand);
    expect(result.players[seat].discards).toEqual([
      { tile: drawn, order: 0, fromDraw: true },
    ]);
    expect(result.players[seat].drawnTile).toBeNull();
  });

  it("rejects a tile the player does not hold", () => {
    const foreign = started.players[1].hand[0];
    expect(() => processAction(started, discardOf(started, foreign, false))).toThrow();
  });

  it("rejects a discard from the wrong seat", () => {
    const wrongSeat: DiscardAction = { ...discardOf(started, tile, false), seat: 1 };
    expect(() => processAction(started, wrongSeat)).toThrow();
  });

  it("rejects a discard before hand-start", () => {
    const initial = fresh();
    const t = initial.players[0].hand[0];
    expect(() => processAction(initial, discardOf(initial, t, false))).toThrow();
  });
});

describe("discard: claim evaluation", () => {
  it("skips the claim window when nobody can claim", () => {
    const { state, discard } = afterDealerDiscards();
    expect(state.phase).toEqual({ type: "draw", seat: 1 });
    expect(state.currentTurn).toBe(1);
    expect(state.lastDiscard).toEqual({ tile: discard, by: 0 });
    expect(state.history).toHaveLength(2); // hand-start draw + discard, no pass needed
  });

  it("opens a claim window with a pung option", () => {
    const { state, discard } = afterDealerDiscards({ 2: handOf(bam(5), bam(5)) });
    const window = windowOf(state);
    expect(window.discardedBy).toBe(0);
    expect(window.tile).toEqual(discard);
    expect(window.passed).toEqual([]);
    expect(summary(state)).toEqual(["2:pung"]);
    expect(window.availableClaims[0].usingTiles).toHaveLength(2);
  });

  it("offers every chow combination, but only to the seat after the discarder", () => {
    const { state } = afterDealerDiscards({
      1: handOf(bam(3), bam(4), bam(6), bam(7)),
      2: handOf(bam(4), bam(6)),
    });
    expect(summary(state)).toEqual(["1:chow", "1:chow", "1:chow"]);
    const combos = windowOf(state).availableClaims.map((c) => rankText(c.usingTiles));
    expect(combos).toEqual(["3-4", "4-6", "6-7"]);
  });

  it("offers a win with no tiles used", () => {
    const { state } = afterDealerDiscards({ 3: winningHand() });
    expect(summary(state)).toEqual(["3:win"]);
    expect(windowOf(state).availableClaims[0].usingTiles).toEqual([]);
  });

  it("offers no win when the hand is complete but under the 3 fan minimum", () => {
    // The all-chows hand is complete on bamboo 5, but scores under 3 fan: no claim at all,
    // so the window is skipped and play moves straight on to the next draw.
    const { state } = afterDealerDiscards({ 3: cheapHand() });
    expect(state.phase.type).toBe("draw");
  });

  it("still offers the other claims to a seat whose win is under the minimum", () => {
    const { state } = afterDealerDiscards({ 3: [...cheapHand().slice(0, 11), bam(5), bam(5)] });
    expect(summary(state)).toEqual(["3:pung"]);
  });

  it("lists claims across seats in turn order after the discarder", () => {
    const { state } = afterDealerDiscards({
      2: handOf(bam(5), bam(5)),
      3: winningHand(),
    });
    expect(summary(state)).toEqual(["2:pung", "3:win"]);
  });
});

describe("processAction: pass", () => {
  const { state: pungWindow } = afterDealerDiscards({ 2: handOf(bam(5), bam(5)) });
  const { state: raceWindow } = afterDealerDiscards({
    2: handOf(bam(5), bam(5)),
    3: winningHand(),
  });

  it("closes the window once the only claimant passes", () => {
    const snapshot = structuredClone(pungWindow);
    const action = passOf(pungWindow, 2);
    const next = processAction(pungWindow, action);

    expect(next.currentTurn).toBe(1);
    expect(next.phase).toEqual({ type: "draw", seat: 1 });
    expect(next.history[next.history.length - 1]).toEqual(action);
    expect(next.lastDiscard).toEqual(pungWindow.lastDiscard);
    expect(pungWindow).toEqual(snapshot);
  });

  it("waits for every seat with a claim", () => {
    const afterFirst = processAction(raceWindow, passOf(raceWindow, 3));
    expect(afterFirst.currentTurn).toBe(0);
    expect(windowOf(afterFirst).passed).toEqual([3]);

    expect(() => processAction(afterFirst, passOf(afterFirst, 3))).toThrow();

    const afterSecond = processAction(afterFirst, passOf(afterFirst, 2));
    expect(afterSecond.currentTurn).toBe(1);
    expect(afterSecond.phase).toEqual({ type: "draw", seat: 1 });
  });

  it("rejects a pass from the discarder or from a seat with no claim", () => {
    expect(() => processAction(pungWindow, passOf(pungWindow, 0))).toThrow();
    expect(() => processAction(pungWindow, passOf(pungWindow, 1))).toThrow();
  });

  it("rejects a pass outside a claim window", () => {
    const { state: drawPhase } = afterDealerDiscards();
    expect(() => processAction(drawPhase, passOf(drawPhase, 2))).toThrow();
    expect(() => processAction(fresh(), passOf(fresh(), 1))).toThrow();
  });
});

describe("processAction: claim", () => {
  it("pung: melds the tiles, removes the discard from the river, and gives the claimer the turn", () => {
    const { state: window, discard } = afterDealerDiscards({ 2: handOf(bam(5), bam(5)) });
    const snapshot = structuredClone(window);
    const using = windowOf(window).availableClaims[0].usingTiles;
    const action = claimOf(window, 2, "pung", using);
    const next = processAction(window, action);

    expect(next.currentTurn).toBe(2);
    expect(next.phase).toEqual({ type: "action", seat: 2 });
    expect(next.lastDiscard).toBeNull();

    const claimer = next.players[2];
    expect(claimer.hand).toHaveLength(11);
    expect(using.every((u) => !claimer.hand.some((h) => h.id === u.id))).toBe(true);
    expect(claimer.melds).toHaveLength(1);
    expect(claimer.melds[0]).toMatchObject({
      type: "pung",
      isOpen: true,
      claimedFrom: 0,
      claimedTile: discard,
      createdAtActionSeq: action.seq,
    });
    expect(claimer.melds[0].tiles).toHaveLength(3);

    expect(next.players[0].discards[0]).toMatchObject({ claimedBy: 2 });
    expect(next.history[next.history.length - 1]).toEqual(action);
    expect(window).toEqual(snapshot);
  });

  it("pung: the claimer must discard next, without drawing", () => {
    const { state: window } = afterDealerDiscards({ 2: handOf(bam(5), bam(5)) });
    const using = windowOf(window).availableClaims[0].usingTiles;
    const claimed = processAction(window, claimOf(window, 2, "pung", using));

    const toss = claimed.players[2].hand[0];
    const next = processAction(claimed, discardOf(claimed, toss, false));
    expect(next.players[2].hand).toHaveLength(10);
    expect(next.players[2].drawnTile).toBeNull();
    expect(next.players[2].discards).toHaveLength(1);
  });

  it("chow: sorts the meld by rank and uses the chosen tiles", () => {
    const { state: window } = afterDealerDiscards({ 1: handOf(bam(3), bam(4), bam(6), bam(7)) });
    const option = windowOf(window).availableClaims.find((c) => rankText(c.usingTiles) === "4-6")!;
    const next = processAction(window, claimOf(window, 1, "chow", option.usingTiles));

    const claimer = next.players[1];
    expect(claimer.melds[0].type).toBe("chow");
    expect(claimer.melds[0].tiles.map(rankOf)).toEqual([4, 5, 6]);
    expect(claimer.hand).toHaveLength(11);
    expect(claimer.hand.map(rankOf)).toContain(3);
    expect(claimer.hand.map(rankOf)).toContain(7);
    expect(next.phase).toEqual({ type: "action", seat: 1 });
  });

  it("win: ends the hand and adds the discard to the winner's hand", () => {
    const { state: window } = afterDealerDiscards({ 3: winningHand() });
    const next = processAction(window, claimOf(window, 3, "win"));

    expect(next.phase).toEqual({
      type: "hand-end",
      reason: "win-discard",
      winners: [3],
      result: { totalFan: 3, patterns: ["Red Dragon", "Green Dragon", "White Dragon"] },
      totalFan: 3,
      patterns: ["Red Dragon (1)", "Green Dragon (1)", "White Dragon (1)"],
      payments: [{ from: 0, to: 3, amount: 8 }], // 3 fan is worth 8
    });
    expect(next.players[3].hand).toHaveLength(14);
    expect(next.players[0].discards[0]).toMatchObject({ claimedBy: 3 });
  });

  it("rejects claims that are not available", () => {
    const { state: window } = afterDealerDiscards({ 2: handOf(bam(5), bam(5)) });
    const using = windowOf(window).availableClaims[0].usingTiles;

    // seat with no claim
    expect(() => processAction(window, claimOf(window, 1, "pung", using))).toThrow();
    // wrong kind for the seat
    expect(() => processAction(window, claimOf(window, 2, "chow", using))).toThrow();
    // right kind, wrong tiles
    expect(() => processAction(window, claimOf(window, 2, "pung", [bam(5), bam(5)]))).toThrow();
    expect(() => processAction(window, claimOf(window, 2, "win"))).toThrow();
  });

  it("rejects a claim outside a claim window", () => {
    const { state: drawPhase } = afterDealerDiscards();
    expect(() => processAction(drawPhase, claimOf(drawPhase, 2, "win"))).toThrow();
  });

  it("makes a lower-priority claim wait until the higher one has passed", () => {
    const { state: window } = afterDealerDiscards({
      2: handOf(bam(5), bam(5)),
      3: winningHand(),
    });
    const pungUsing = windowOf(window).availableClaims.find((c) => c.kind === "pung")!.usingTiles;

    // The win from seat 3 outranks seat 2's pung.
    expect(() => processAction(window, claimOf(window, 2, "pung", pungUsing))).toThrow();

    const afterPass = processAction(window, passOf(window, 3));
    const next = processAction(afterPass, claimOf(afterPass, 2, "pung", pungUsing));
    expect(next.phase).toEqual({ type: "action", seat: 2 });
  });

  it("rejects a claim from a seat that already passed", () => {
    const { state: window } = afterDealerDiscards({
      2: handOf(bam(5), bam(5)),
      3: winningHand(),
    });
    const pungUsing = windowOf(window).availableClaims.find((c) => c.kind === "pung")!.usingTiles;
    const afterPass = processAction(window, passOf(window, 2));
    expect(() => processAction(afterPass, claimOf(afterPass, 2, "pung", pungUsing))).toThrow();
  });
});

describe("processAction: draw", () => {
  const { state: ready } = afterDealerDiscards(); // seat 1 to draw
  const snapshot = structuredClone(ready);
  const top = ready.wall.liveTiles[0];
  const action = drawOf(ready);
  const next = processAction(ready, action);

  it("gives the current player the top live tile as drawnTile", () => {
    expect(ready.phase).toEqual({ type: "draw", seat: 1 });
    expect(next.players[1].drawnTile).toEqual(top);
  });

  it("shrinks the live wall by 1 and counts the draw", () => {
    expect(next.wall.liveTiles).toEqual(ready.wall.liveTiles.slice(1));
    expect(next.wall.drawCount).toBe(ready.wall.drawCount + 1);
  });

  it("moves to the action phase for that seat", () => {
    expect(next.phase).toEqual({ type: "action", seat: 1 });
    expect(next.currentTurn).toBe(1);
  });

  it("appends the DrawAction to history", () => {
    expect(next.history[next.history.length - 1]).toEqual(action);
  });

  it("records the real top tile even if the action carries a different one", () => {
    const wrongTile = ready.players[2].hand[0];
    const result = processAction(ready, drawOf(ready, wrongTile));
    expect(result.players[1].drawnTile).toEqual(top);
    expect(result.history[result.history.length - 1]).toMatchObject({ type: "draw", tile: top });
  });

  it("does not mutate the previous state", () => {
    expect(ready).toEqual(snapshot);
  });

  it("rejects a draw outside the draw phase", () => {
    const started = processAction(fresh(), handStart);
    expect(() => processAction(started, drawOf(started))).toThrow();
  });

  it("rejects a draw from the wrong seat", () => {
    expect(() => processAction(ready, { ...drawOf(ready), seat: 2 })).toThrow();
  });

  it("rejects a dead-wall draw", () => {
    expect(() => processAction(ready, { ...drawOf(ready), fromDeadWall: true })).toThrow();
  });

  it("rejects a draw when the player already holds a drawn tile", () => {
    const holding: GameState = {
      ...ready,
      players: ready.players.map((p) => (p.seat === 1 ? { ...p, drawnTile: p.hand[0] } : p)),
    };
    expect(() => processAction(holding, drawOf(holding))).toThrow();
  });

  it("rejects a draw from an empty live wall", () => {
    const empty: GameState = { ...ready, wall: { ...ready.wall, liveTiles: [] } };
    expect(() => processAction(empty, drawOf(empty, top))).toThrow();
  });
});

describe("full turn loop: draw -> discard -> (pass) -> next seat", () => {
  const TURNS = 8; // two full laps of the table

  let state = processAction(fresh(), handStart);
  for (let turn = 0; turn < TURNS; turn++) {
    const seat = state.currentTurn;
    if (turn > 0) state = processAction(state, drawOf(state));

    // Alternate between discarding the drawn tile and a tile from the hand.
    const player = state.players[seat];
    const useDrawn = turn % 2 === 0;
    const tile = useDrawn ? player.drawnTile! : player.hand[0];
    state = processAction(state, discardOf(state, tile, useDrawn));

    // The natural deal may produce claims; if so, everyone with a claim passes.
    while (state.phase.type === "claim-window") {
      const window = state.phase;
      const claimant = window.availableClaims
        .map((c) => c.seat)
        .find((s) => !window.passed.includes(s))!;
      state = processAction(state, passOf(state, claimant));
    }

    const next = ((seat + 1) % 4) as SeatIndex;
    expect(state.currentTurn).toBe(next);
    expect(state.phase).toEqual({ type: "draw", seat: next });
  }
  const final = state;

  it("passes the turn around the table in seat order", () => {
    expect(final.currentTurn).toBe(0);
    expect(final.phase).toEqual({ type: "draw", seat: 0 });
  });

  it("leaves every player with 13 tiles and no drawn tile", () => {
    for (const p of final.players) {
      expect(p.hand).toHaveLength(13);
      expect(p.drawnTile).toBeNull();
      expect(p.discards).toHaveLength(2);
    }
  });

  it("numbers discards in order across the table", () => {
    const orders = final.players
      .flatMap((p) => p.discards.map((d) => d.order))
      .sort((a, b) => a - b);
    expect(orders).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("draws exactly one tile per turn from the live wall", () => {
    // 68 live tiles, minus the hand-start draw and 7 further draws.
    expect(final.wall.liveTiles).toHaveLength(60);
    expect(final.wall.drawCount).toBe(8);
  });

  it("logs every action with a monotonic seq", () => {
    expect(final.history.map((a) => a.seq)).toEqual(
      Array.from({ length: final.history.length }, (_, i) => i),
    );
  });

  it("never loses or duplicates a tile", () => {
    const ids = [
      ...final.players.flatMap((p) => [
        ...p.hand,
        ...(p.drawnTile ? [p.drawnTile] : []),
        ...p.discards.map((d) => d.tile),
        ...p.melds.flatMap((m) => m.tiles),
      ]),
      ...final.wall.liveTiles,
      ...final.wall.deadWall,
    ].map((t) => t.id);
    expect(ids).toHaveLength(136);
    expect(new Set(ids).size).toBe(136);
  });
});

/* ---------- Kongs and the dead wall ---------- */

/** Seat 0 in the action phase with a rigged hand, drawn tile and melds. */
function actionPhase(hand: Tile[], drawn: Tile | null, melds: Meld[] = []): GameState {
  const started = processAction(fresh(), handStart);
  return {
    ...started,
    players: started.players.map((p) =>
      p.seat === 0 ? { ...p, hand, drawnTile: drawn, melds } : p,
    ),
  };
}

const kongOf = (
  state: GameState,
  variant: KongAction["variant"],
  tiles: readonly Tile[],
): KongAction => ({
  type: "kong",
  seq: state.history.length,
  seat: state.currentTurn,
  timestamp: T0 + 5000,
  variant,
  tiles,
});

const backOfDeadWall = (state: GameState): Tile =>
  state.wall.deadWall[state.wall.deadWall.length - 1];

describe("processAction: concealed kong", () => {
  const sevens = [bam(7), bam(7), bam(7), bam(7)];
  const oldDrawn = dts(2);
  const before = actionPhase([...sevens, ...filler(9)], oldDrawn);
  const snapshot = structuredClone(before);
  const replacement = backOfDeadWall(before);
  const action = kongOf(before, "concealed", sevens);
  const next = processAction(before, action);
  const player = next.players[0];

  it("melds the four tiles as a closed kong", () => {
    expect(player.melds).toHaveLength(1);
    expect(player.melds[0]).toMatchObject({
      type: "kong",
      kongVariant: "concealed",
      isOpen: false,
      createdAtActionSeq: action.seq,
    });
    expect(player.melds[0].tiles).toHaveLength(4);
  });

  it("draws the replacement from the back of the dead wall", () => {
    expect(player.drawnTile).toEqual(replacement);
    expect(next.wall.deadWall[next.wall.deadWall.length - 1]).toEqual(
      before.wall.deadWall[before.wall.deadWall.length - 2],
    );
    expect(next.wall.deadDrawCount).toBe(before.wall.deadDrawCount + 1);
  });

  it("refills the dead wall from the live wall (see dead wall balancing)", () => {
    expect(next.wall.deadWall).toHaveLength(before.wall.deadWallSize);
    expect(next.wall.liveTiles).toEqual(before.wall.liveTiles.slice(0, -1));
    expect(next.wall.drawCount).toBe(before.wall.drawCount);
  });

  it("moves the old drawn tile into the hand", () => {
    expect(player.hand).toHaveLength(10);
    expect(player.hand.some((t) => t.id === oldDrawn.id)).toBe(true);
    expect(sevens.every((s) => !player.hand.some((h) => h.id === s.id))).toBe(true);
  });

  it("routes the player back to the action phase after the kong", () => {
    expect(next.currentTurn).toBe(0);
    expect(next.phase).toEqual({ type: "action", seat: 0, afterKong: true });
  });

  it("logs the kong and then the dead-wall draw", () => {
    const [kongEntry, drawEntry] = next.history.slice(-2);
    expect(kongEntry).toEqual(action);
    expect(drawEntry).toEqual({
      type: "draw",
      seq: before.history.length + 1,
      seat: 0,
      timestamp: T0 + 5000,
      tile: replacement,
      fromDeadWall: true,
    });
  });

  it("lets the player discard the replacement tile", () => {
    const after = processAction(next, discardOf(next, replacement, true));
    expect(after.players[0].drawnTile).toBeNull();
    expect(after.players[0].hand).toHaveLength(10);
    expect(after.players[0].discards.map((d) => d.tile.id)).toEqual([replacement.id]);
  });

  it("does not mutate the previous state", () => {
    expect(before).toEqual(snapshot);
  });

  it("draws consecutive replacements from successive dead-wall tiles", () => {
    const eights = [bam(8), bam(8), bam(8), bam(8)];
    const twice = actionPhase([...sevens, ...eights, ...filler(5)], dts(2));
    const first = processAction(twice, kongOf(twice, "concealed", sevens));
    const second = processAction(first, kongOf(first, "concealed", eights));
    const deadWall = twice.wall.deadWall;
    expect(first.players[0].drawnTile).toEqual(deadWall[deadWall.length - 1]);
    expect(second.players[0].drawnTile).toEqual(deadWall[deadWall.length - 2]);
    expect(second.wall.deadDrawCount).toBe(2);
    expect(second.players[0].melds).toHaveLength(2);
  });

  it("rejects an exposed kong declared on your own turn", () => {
    expect(() => processAction(before, kongOf(before, "exposed", sevens))).toThrow();
  });

  it("rejects tiles that are not four identical tiles in hand", () => {
    const mixed = [sevens[0], sevens[1], sevens[2], before.players[0].hand[4]];
    expect(() => processAction(before, kongOf(before, "concealed", mixed))).toThrow();
    expect(() => processAction(before, kongOf(before, "concealed", sevens.slice(0, 3)))).toThrow();
  });

  it("rejects tiles the player does not hold", () => {
    const strangers = [bam(7), bam(7), bam(7), bam(7)];
    expect(() => processAction(before, kongOf(before, "concealed", strangers))).toThrow();
  });

  it("rejects a kong from the wrong seat", () => {
    expect(() => processAction(before, { ...kongOf(before, "concealed", sevens), seat: 1 })).toThrow();
  });

  it("rejects a kong outside the action phase", () => {
    const { state: drawPhase } = afterDealerDiscards();
    expect(() => processAction(drawPhase, kongOf(drawPhase, "concealed", sevens))).toThrow();
    const { state: window } = afterDealerDiscards({ 2: handOf(bam(5), bam(5)) });
    expect(() => processAction(window, kongOf(window, "concealed", sevens))).toThrow();
  });

  it("rejects a kong when the dead wall is empty", () => {
    const empty: GameState = { ...before, wall: { ...before.wall, deadWall: [] } };
    expect(() => processAction(empty, kongOf(empty, "concealed", sevens))).toThrow();
  });
});

describe("processAction: added kong", () => {
  const nines = () => [bam(9), bam(9), bam(9)];
  const openPung = (tiles: Tile[]): Meld => ({
    type: "pung",
    tiles,
    claimedTile: tiles[2],
    claimedFrom: 2,
    isOpen: true,
  });

  it("promotes an open pung with the drawn tile and draws a dead-wall replacement", () => {
    const pung = openPung(nines());
    const fourth = bam(9);
    const before = actionPhase(filler(10), fourth, [pung]);
    const snapshot = structuredClone(before);
    const action = kongOf(before, "added", [fourth]);
    const next = processAction(before, action);
    const player = next.players[0];

    expect(player.melds).toHaveLength(1);
    expect(player.melds[0]).toMatchObject({
      type: "kong",
      kongVariant: "added",
      isOpen: true,
      claimedFrom: 2,
    });
    expect(player.melds[0].tiles).toHaveLength(4);
    expect(player.hand).toHaveLength(10);
    expect(player.drawnTile).toEqual(backOfDeadWall(before));
    expect(next.wall.deadWall).toHaveLength(before.wall.deadWall.length);
    expect(next.phase).toEqual({ type: "action", seat: 0, afterKong: true });
    expect(next.history.slice(-2)[0]).toEqual(action);
    expect(next.history.slice(-1)[0]).toMatchObject({ type: "draw", fromDeadWall: true });
    expect(before).toEqual(snapshot);
  });

  it("promotes with a tile from the hand and keeps the drawn tile", () => {
    const fourth = bam(9);
    const oldDrawn = dts(2);
    const before = actionPhase([fourth, ...filler(9)], oldDrawn, [openPung(nines())]);
    const next = processAction(before, kongOf(before, "added", [fourth]));
    const player = next.players[0];

    expect(player.hand).toHaveLength(10);
    expect(player.hand.some((t) => t.id === fourth.id)).toBe(false);
    expect(player.hand.some((t) => t.id === oldDrawn.id)).toBe(true);
    expect(player.drawnTile).toEqual(backOfDeadWall(before));
  });

  it("rejects a tile that does not match an open pung", () => {
    const before = actionPhase(filler(10), bam(9), [openPung(nines())]);
    const wrong = before.players[0].hand[0];
    expect(() => processAction(before, kongOf(before, "added", [wrong]))).toThrow();
    expect(() => processAction(before, kongOf(before, "added", [bam(9)]))).toThrow();
  });

  it("rejects an added kong with no pung to promote", () => {
    const drawn = bam(9);
    const before = actionPhase(filler(10), drawn, []);
    expect(() => processAction(before, kongOf(before, "added", [drawn]))).toThrow();
  });

  it("rejects an added kong with more or fewer than one tile", () => {
    const drawn = bam(9);
    const before = actionPhase(filler(10), drawn, [openPung(nines())]);
    expect(() => processAction(before, kongOf(before, "added", []))).toThrow();
    expect(() => processAction(before, kongOf(before, "added", [drawn, drawn]))).toThrow();
  });
});

describe("processAction: exposed kong claimed from a discard", () => {
  const { state: window, discard } = afterDealerDiscards({
    2: handOf(bam(5), bam(5), bam(5)),
  });
  const kongOption = windowOf(window).availableClaims.find((c) => c.kind === "kong")!;
  const replacement = backOfDeadWall(window);
  const snapshot = structuredClone(window);
  const action = claimOf(window, 2, "kong", kongOption.usingTiles);
  const next = processAction(window, action);
  const claimer = next.players[2];

  it("offers both a pung and a kong when the hand holds three", () => {
    expect(summary(window)).toEqual(["2:pung", "2:kong"]);
    expect(kongOption.usingTiles).toHaveLength(3);
  });

  it("melds an exposed kong and removes the discard from the river", () => {
    expect(claimer.melds).toHaveLength(1);
    expect(claimer.melds[0]).toMatchObject({
      type: "kong",
      kongVariant: "exposed",
      isOpen: true,
      claimedFrom: 0,
      claimedTile: discard,
    });
    expect(claimer.melds[0].tiles).toHaveLength(4);
    expect(claimer.hand).toHaveLength(10);
    expect(next.players[0].discards[0]).toMatchObject({ claimedBy: 2 });
    expect(next.lastDiscard).toBeNull();
  });

  it("draws the replacement from the back of the dead wall", () => {
    expect(claimer.drawnTile).toEqual(replacement);
    expect(next.wall.deadWall).toEqual([
      window.wall.liveTiles[window.wall.liveTiles.length - 1],
      ...window.wall.deadWall.slice(0, -1),
    ]);
    expect(next.wall.deadDrawCount).toBe(1);
    expect(next.wall.liveTiles).toEqual(window.wall.liveTiles.slice(0, -1));
  });

  it("gives the claimer the turn in the action phase", () => {
    expect(next.currentTurn).toBe(2);
    expect(next.phase).toEqual({ type: "action", seat: 2, afterKong: true });
  });

  it("logs the claim and then the dead-wall draw", () => {
    const [claimEntry, drawEntry] = next.history.slice(-2);
    expect(claimEntry).toEqual(action);
    expect(drawEntry).toEqual({
      type: "draw",
      seq: window.history.length + 1,
      seat: 2,
      timestamp: T0 + 4000,
      tile: replacement,
      fromDeadWall: true,
    });
  });

  it("lets the claimer discard the replacement tile", () => {
    const after = processAction(next, discardOf(next, replacement, true));
    expect(after.players[2].drawnTile).toBeNull();
    expect(after.players[2].hand).toHaveLength(10);
  });

  it("does not mutate the previous state", () => {
    expect(window).toEqual(snapshot);
  });

  it("still allows a plain pung on the same hand", () => {
    const pungOption = windowOf(window).availableClaims.find((c) => c.kind === "pung")!;
    const punged = processAction(window, claimOf(window, 2, "pung", pungOption.usingTiles));
    expect(punged.players[2].hand).toHaveLength(11);
    expect(punged.players[2].drawnTile).toBeNull();
    expect(punged.wall.deadDrawCount).toBe(0);
  });

  it("rejects a kong claim when the dead wall is empty", () => {
    const empty: GameState = { ...window, wall: { ...window.wall, deadWall: [] } };
    expect(() => processAction(empty, claimOf(empty, 2, "kong", kongOption.usingTiles))).toThrow();
  });

  it("makes a kong wait for a higher-priority win", () => {
    const { state: race } = afterDealerDiscards({
      2: handOf(bam(5), bam(5), bam(5)),
      3: winningHand(),
    });
    const using = windowOf(race).availableClaims.find((c) => c.kind === "kong")!.usingTiles;
    expect(() => processAction(race, claimOf(race, 2, "kong", using))).toThrow();
  });
});

/* ---------- Dead wall balancing ---------- */

describe("dead wall balancing", () => {
  const sevens = [bam(7), bam(7), bam(7), bam(7)];
  const eights = [bam(8), bam(8), bam(8), bam(8)];
  const before = actionPhase([...sevens, ...eights, ...filler(5)], dts(2));
  const lastLive = before.wall.liveTiles[before.wall.liveTiles.length - 1];

  it("starts with a full dead wall", () => {
    expect(before.wall.deadWall).toHaveLength(16);
    expect(before.wall.deadWallSize).toBe(16);
  });

  it("moves the last live tile to the front of the dead wall after a replacement draw", () => {
    const next = processAction(before, kongOf(before, "concealed", sevens));
    expect(next.wall.deadWall).toHaveLength(16);
    expect(next.wall.deadWall[0]).toEqual(lastLive);
    expect(next.wall.deadWall.slice(1)).toEqual(before.wall.deadWall.slice(0, -1));
    expect(next.wall.liveTiles).toEqual(before.wall.liveTiles.slice(0, -1));
  });

  it("stays at 16 tiles through repeated kongs", () => {
    const first = processAction(before, kongOf(before, "concealed", sevens));
    const second = processAction(first, kongOf(first, "concealed", eights));
    expect(second.wall.deadWall).toHaveLength(16);
    expect(second.wall.liveTiles).toHaveLength(before.wall.liveTiles.length - 2);
    expect(second.wall.deadDrawCount).toBe(2);
  });

  it("serves the moved live tile as a later replacement", () => {
    // A two-tile dead wall of known non-bamboo tiles, and a known tile at the live wall's tail.
    const sixes = [bam(6), bam(6), bam(6), bam(6)];
    const [a, b, tail] = [dts(8), dts(6), chr(6)];
    const rigged = actionPhase([...sevens, ...eights, ...sixes, ...filler(1)], dts(2));
    let current: GameState = {
      ...rigged,
      wall: {
        ...rigged.wall,
        deadWall: [a, b],
        liveTiles: [...rigged.wall.liveTiles.slice(0, -1), tail],
      },
    };

    current = processAction(current, kongOf(current, "concealed", sevens));
    expect(current.players[0].drawnTile).toEqual(b);
    expect(current.wall.deadWall).toEqual([tail, a]);

    current = processAction(current, kongOf(current, "concealed", eights));
    expect(current.players[0].drawnTile).toEqual(a);

    current = processAction(current, kongOf(current, "concealed", sixes));
    expect(current.players[0].drawnTile).toEqual(tail);
    expect(current.wall.deadWall).toHaveLength(2);
  });

  it("lets the dead wall shrink once the live wall is empty", () => {
    const empty: GameState = { ...before, wall: { ...before.wall, liveTiles: [] } };
    const next = processAction(empty, kongOf(empty, "concealed", sevens));
    expect(next.wall.liveTiles).toEqual([]);
    expect(next.wall.deadWall).toEqual(empty.wall.deadWall.slice(0, -1));
    expect(next.wall.deadWall).toHaveLength(15);
  });

  it("balances after an exposed kong claim too", () => {
    const { state: window } = afterDealerDiscards({ 2: handOf(bam(5), bam(5), bam(5)) });
    const using = windowOf(window).availableClaims.find((c) => c.kind === "kong")!.usingTiles;
    const next = processAction(window, claimOf(window, 2, "kong", using));
    expect(next.wall.deadWall).toHaveLength(16);
    expect(next.wall.liveTiles).toHaveLength(window.wall.liveTiles.length - 1);
  });

  it("never loses or duplicates a tile when balancing", () => {
    const first = processAction(before, kongOf(before, "concealed", sevens));
    const ids = [...first.wall.liveTiles, ...first.wall.deadWall].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(before.wall.liveTiles.length + before.wall.deadWall.length - 1);
  });
});

/* ---------- Robbing the kong ---------- */

describe("robbing the kong", () => {
  const nines = () => [bam(9), bam(9), bam(9)];
  const openPung = (tiles: Tile[]): Meld => ({
    type: "pung",
    tiles,
    claimedTile: tiles[2],
    claimedFrom: 2,
    isOpen: true,
  });

  /** Seat 0 holds an open pung of 9s and the fourth 9 as its drawn tile. Seat 3 waits on a 9. */
  function addedKongSetup(opponents: Partial<Record<SeatIndex, Tile[]>> = { 3: winningHand(bam(9)) }) {
    const fourth = bam(9);
    const base = actionPhase(filler(10), fourth, [openPung(nines())]);
    const state: GameState = {
      ...base,
      players: base.players.map((p) =>
        p.seat !== 0 && opponents[p.seat] ? { ...p, hand: opponents[p.seat]! } : p,
      ),
    };
    return { state, fourth, action: kongOf(state, "added", [fourth]) };
  }

  it("opens a win-only claim window instead of completing the kong", () => {
    const { state, fourth, action } = addedKongSetup();
    const snapshot = structuredClone(state);
    const next = processAction(state, action);

    expect(next.phase).toMatchObject({
      type: "claim-window",
      discardedBy: 0,
      isRobbingKong: true,
      passed: [],
    });
    expect(windowOf(next).tile).toEqual(fourth);
    expect(windowOf(next).pendingKong).toEqual(action);
    expect(summary(next)).toEqual(["3:win"]);

    // Nothing has happened to the kong yet: same pung, no replacement, wall untouched.
    expect(next.players[0].melds[0]).toMatchObject({ type: "pung" });
    expect(next.players[0].drawnTile).toEqual(fourth);
    expect(next.wall).toEqual(state.wall);
    expect(next.history[next.history.length - 1]).toEqual(action);
    expect(state).toEqual(snapshot);
  });

  it("offers only wins, even to seats that could pung or chow the tile", () => {
    const { state, action } = addedKongSetup({
      1: handOf(bam(7), bam(8)), // could chow a 9 from a discard
      2: handOf(bam(9), bam(9)), // could pung a 9 from a discard
      3: winningHand(bam(9)),
    });
    const next = processAction(state, action);
    expect(summary(next)).toEqual(["3:win"]);
  });

  it("completes the kong right away when nobody can rob it", () => {
    const { state, fourth, action } = addedKongSetup({});
    const next = processAction(state, action);
    expect(next.phase).toEqual({ type: "action", seat: 0, afterKong: true });
    expect(next.players[0].melds[0]).toMatchObject({ type: "kong", kongVariant: "added" });
    expect(next.players[0].hand.some((t) => t.id === fourth.id)).toBe(false);
  });

  it("a win ends the hand as robbing-kong and the kong never happens", () => {
    const { state, fourth, action } = addedKongSetup();
    const window = processAction(state, action);
    const claim = claimOf(window, 3, "win");
    const next = processAction(window, claim);

    expect(next.phase).toMatchObject({
      type: "hand-end",
      reason: "robbing-kong",
      winners: [3],
      winningTile: fourth,
      totalFan: 3,
      payments: [{ from: 0, to: 3, amount: 8 }], // the declarer is the chucker
    });
    expect(next.currentTurn).toBe(3);
    expect(next.history[next.history.length - 1]).toEqual(claim);

    // The winner holds 14 tiles including the robbed 9; the declarer lost it and kept the pung.
    expect(next.players[3].hand).toHaveLength(14);
    expect(next.players[3].hand.some((t) => t.id === fourth.id)).toBe(true);
    expect(next.players[0].drawnTile).toBeNull();
    expect(next.players[0].melds).toHaveLength(1);
    expect(next.players[0].melds[0]).toMatchObject({ type: "pung" });
    expect(next.players[0].melds[0].tiles).toHaveLength(3);

    // No replacement was drawn and the wall did not move.
    expect(next.wall).toEqual(state.wall);
    expect(next.history.some((a) => a.type === "draw" && a.fromDeadWall)).toBe(false);
  });

  it("takes the robbed tile from the declarer's hand when it was not the drawn tile", () => {
    const fourth = bam(9);
    const oldDrawn = dts(2);
    const base = actionPhase([fourth, ...filler(9)], oldDrawn, [openPung(nines())]);
    const state: GameState = {
      ...base,
      players: base.players.map((p) => (p.seat === 3 ? { ...p, hand: winningHand(bam(9)) } : p)),
    };
    const window = processAction(state, kongOf(state, "added", [fourth]));
    const next = processAction(window, claimOf(window, 3, "win"));
    expect(next.players[0].hand.some((t) => t.id === fourth.id)).toBe(false);
    expect(next.players[0].drawnTile).toEqual(oldDrawn);
  });

  it("completes the kong and draws the replacement once every seat passes", () => {
    const { state, fourth, action } = addedKongSetup();
    const window = processAction(state, action);
    const replacement = backOfDeadWall(state);
    const pass = passOf(window, 3);
    const next = processAction(window, pass);

    expect(next.currentTurn).toBe(0);
    expect(next.phase).toEqual({ type: "action", seat: 0, afterKong: true });
    expect(next.players[0].melds[0]).toMatchObject({ type: "kong", kongVariant: "added" });
    expect(next.players[0].melds[0].tiles).toHaveLength(4);
    expect(next.players[0].drawnTile).toEqual(replacement);
    expect(next.players[0].hand.some((t) => t.id === fourth.id)).toBe(false);
    expect(next.wall.deadDrawCount).toBe(1);
    expect(next.wall.deadWall).toHaveLength(16); // balanced from the live wall

    const [passEntry, drawEntry] = next.history.slice(-2);
    expect(passEntry).toEqual(pass);
    expect(drawEntry).toMatchObject({
      type: "draw",
      seat: 0,
      tile: replacement,
      fromDeadWall: true,
      seq: window.history.length + 1,
    });
  });

  it("lets the declarer discard after a failed robbery", () => {
    const { state, action } = addedKongSetup();
    const window = processAction(state, action);
    const done = processAction(window, passOf(window, 3));
    const replacement = done.players[0].drawnTile!;
    const after = processAction(done, discardOf(done, replacement, true));
    expect(after.players[0].drawnTile).toBeNull();
    expect(after.players[0].discards).toHaveLength(1);
  });

  it("waits for every seat that can rob before completing", () => {
    const { state, action } = addedKongSetup({
      1: winningHand(bam(9)),
      3: winningHand(bam(9)),
    });
    const window = processAction(state, action);
    expect(summary(window)).toEqual(["1:win", "3:win"]);

    const afterFirst = processAction(window, passOf(window, 1));
    expect(afterFirst.phase).toMatchObject({ type: "claim-window", isRobbingKong: true });
    expect(windowOf(afterFirst).passed).toEqual([1]);

    const afterSecond = processAction(afterFirst, passOf(afterFirst, 3));
    expect(afterSecond.phase).toEqual({ type: "action", seat: 0, afterKong: true });
  });

  it("lets a later seat rob after an earlier one passes", () => {
    const { state, action } = addedKongSetup({
      1: winningHand(bam(9)),
      3: winningHand(bam(9)),
    });
    const window = processAction(state, action);
    const afterPass = processAction(window, passOf(window, 1));
    const next = processAction(afterPass, claimOf(afterPass, 3, "win"));
    expect(next.phase).toMatchObject({ type: "hand-end", reason: "robbing-kong", winners: [3] });
  });

  it("rejects pung, chow and kong claims during the window", () => {
    const { state, action } = addedKongSetup({ 2: handOf(bam(9), bam(9)), 3: winningHand(bam(9)) });
    const window = processAction(state, action);
    const using = state.players[2].hand.filter((t) => rankOf(t) === 9).slice(0, 2);
    expect(() => processAction(window, claimOf(window, 2, "pung", using))).toThrow();
    expect(() => processAction(window, claimOf(window, 2, "chow", using))).toThrow();
    expect(() => processAction(window, claimOf(window, 2, "kong", using))).toThrow();
  });

  it("rejects a pass from the declarer or from a seat that cannot win", () => {
    const { state, action } = addedKongSetup();
    const window = processAction(state, action);
    expect(() => processAction(window, passOf(window, 0))).toThrow();
    expect(() => processAction(window, passOf(window, 1))).toThrow();
  });

  it("blocks any other action while the window is open", () => {
    const { state, fourth, action } = addedKongSetup();
    const window = processAction(state, action);
    expect(() => processAction(window, discardOf(window, fourth, true))).toThrow();
    expect(() => processAction(window, kongOf(window, "concealed", [fourth]))).toThrow();
  });

  it("does not open a window for a concealed kong", () => {
    const sevens = [bam(7), bam(7), bam(7), bam(7)];
    const base = actionPhase([...sevens, ...filler(9)], dts(2));
    const state: GameState = {
      ...base,
      players: base.players.map((p) => (p.seat === 3 ? { ...p, hand: winningHand(bam(7)) } : p)),
    };
    const next = processAction(state, kongOf(state, "concealed", sevens));
    expect(next.phase).toEqual({ type: "action", seat: 0, afterKong: true });
  });
});

/* ---------- Self-draw win ---------- */

describe("processAction: self-draw win", () => {
  /** Seat 0 holds `hand` and has just drawn `drawn`, in their action phase. */
  function drawnState(hand: Tile[], drawn: Tile): GameState {
    const started = processAction(fresh(), handStart);
    return {
      ...started,
      players: started.players.map((p) => (p.seat === 0 ? { ...p, hand, drawnTile: drawn } : p)),
    };
  }

  const winOf = (state: GameState, tile: Tile, seat: SeatIndex = 0): WinAction => ({
    type: "win",
    seq: state.history.length,
    seat,
    timestamp: T0 + 5000,
    method: "self-draw",
    winningTile: tile,
  });

  it("ends the hand as a self-draw win, recording winner, tile, hand and fan", () => {
    const drawn = bam(5);
    const state = drawnState(winningHand(bam(9)).slice(0, 12).concat(bam(5)), drawn);
    const next = processAction(state, winOf(state, drawn));

    expect(next.phase.type).toBe("hand-end");
    if (next.phase.type !== "hand-end") return;
    expect(next.phase.reason).toBe("win-self-draw");
    expect(next.phase.winners).toEqual([0]);
    expect(next.phase.winningTile).toEqual(drawn);
    expect(next.phase.result?.totalFan).toBeGreaterThan(2);
    expect(next.players[0].hand).toHaveLength(14);
    expect(next.players[0].drawnTile).toBeNull();
    expect(next.history[next.history.length - 1].type).toBe("win");
  });

  it("does not mutate the previous state", () => {
    const drawn = bam(5);
    const state = drawnState(winningHand().slice(0, 12).concat(bam(5)), drawn);
    const snapshot = structuredClone(state);
    processAction(state, winOf(state, drawn));
    expect(state).toEqual(snapshot);
  });

  it("rejects a complete hand that scores under the 3 fan minimum", () => {
    const drawn = bam(5);
    const state = drawnState(cheapHand().slice(0, 12).concat(bam(5)), drawn);
    expect(() => processAction(state, winOf(state, drawn))).toThrow();
  });

  it("rejects a draw that does not complete the hand", () => {
    const drawn = chr(1);
    const state = drawnState(winningHand().slice(0, 12).concat(bam(5)), drawn);
    expect(() => processAction(state, winOf(state, drawn))).toThrow();
  });

  it("rejects a win from the wrong seat, outside an action phase, or on a discard", () => {
    const drawn = bam(5);
    const state = drawnState(winningHand().slice(0, 12).concat(bam(5)), drawn);
    expect(() => processAction(state, winOf(state, drawn, 1))).toThrow();
    expect(() => processAction(fresh(), winOf(fresh(), drawn))).toThrow();
    expect(() => processAction(state, { ...winOf(state, drawn), method: "discard" })).toThrow();
  });
});
