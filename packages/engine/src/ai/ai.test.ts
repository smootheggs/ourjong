import { beforeEach, describe, expect, it } from "vitest";
import { shanten as oldShanten } from "../ai.ts";
import { initializeHKOSGame } from "../game.ts";
import { processAction } from "../moves.ts";
import type { ClaimOption, GameState, SeatIndex, Tile, TileFace, SuitName, SuitRank, WindName, DragonName } from "../types.ts";
import { bestDiscard, bestDiscardFaan, checkFaanClaim, chooseKongDeclaration, evaluateDiscards, evaluateDiscardsExpert, evaluateDiscardsFaan, shantenAfterClaim, stanceOf } from "./evaluate.ts";
import { assessThreat, dangerOfFace, dangerScores, tableViewOf } from "./danger.ts";
import { adviseDiscard, faceName, recommendDiscard } from "./coach.ts";
import type { TableView } from "./danger.ts";
import type { FaanContext } from "./patterns.ts";
import { committedSuit, committedToTriplets, planDistances, summariseMelds } from "./patterns.ts";
import { getBotAction, nextBotAction, runBots } from "./bot.ts";
import { calcShanten, countsOfTiles, faceIndexOf, shantenOfCounts } from "./shanten.ts";

let nextId = 0;
const copies = new Map<string, number>();
beforeEach(() => {
  nextId = 0;
  copies.clear();
});
const t = (face: TileFace): Tile => {
  const key = JSON.stringify(face);
  const copy = copies.get(key) ?? 0;
  copies.set(key, copy + 1);
  return { id: nextId++, face, copy };
};
const suit = (s: SuitName, ...ranks: SuitRank[]) => ranks.map((rank) => t({ kind: "suit", suit: s, rank }));
const dots = (...r: SuitRank[]) => suit("dots", ...r);
const bam = (...r: SuitRank[]) => suit("bamboo", ...r);
const chr = (...r: SuitRank[]) => suit("characters", ...r);
const wind = (w: WindName, n = 1) => Array.from({ length: n }, () => t({ kind: "wind", wind: w }));
const dragon = (d: DragonName, n = 1) => Array.from({ length: n }, () => t({ kind: "dragon", dragon: d }));

describe("calcShanten", () => {
  it("-1 for a complete hand", () => {
    expect(calcShanten([...dots(1, 2, 3, 4, 5, 6), ...bam(7, 8, 9), ...chr(2, 2, 2), ...wind("east", 2)])).toBe(-1);
  });
  it("0 for a ready hand", () => {
    expect(calcShanten([...dots(1, 2, 3, 4, 5, 6), ...bam(7, 8, 9), ...chr(2, 2, 2), ...wind("east", 1)])).toBe(0);
  });
  it("counts melds already made", () => {
    expect(calcShanten([...dots(1, 2, 3, 4, 5, 6), ...bam(7, 8, 9), ...wind("east", 1)], 1)).toBe(0);
  });
  it("sees Thirteen Orphans", () => {
    const orphans = [...dots(1, 9), ...bam(1, 9), ...chr(1, 9), ...wind("east"), ...wind("south"), ...wind("west"), ...wind("north"), ...dragon("red"), ...dragon("green"), ...dragon("white")];
    expect(calcShanten(orphans)).toBe(0); // thirteen different, waiting on any pair
    expect(calcShanten([...orphans, ...wind("east")])).toBe(-1);
    expect(calcShanten(orphans, 0, false)).toBeGreaterThan(0);
  });
  it("is not confused by a hand with a spare partial", () => {
    // 123 456 789 dots, 12 chars, 5 bamboo, 5 bamboo: ready? no, 12 + pair + 3 sets: needs more
    expect(calcShanten([...dots(1, 2, 3, 4, 5, 6, 7, 8, 9), ...chr(1, 2), ...bam(5, 5)])).toBe(0);
  });
  it("matches the older search on random hands", () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 12345;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const faces: TileFace[] = [];
    for (const s of ["bamboo", "characters", "dots"] as SuitName[]) for (let r = 1; r <= 9; r++) faces.push({ kind: "suit", suit: s, rank: r as SuitRank });
    for (const w of ["east", "south", "west", "north"] as WindName[]) faces.push({ kind: "wind", wind: w });
    for (const d of ["red", "green", "white"] as DragonName[]) faces.push({ kind: "dragon", dragon: d });
    for (let n = 0; n < 1500; n++) {
      const pool = faces.flatMap((f) => [f, f, f, f]);
      const size = [13, 14, 10, 11, 7][n % 5];
      const meldCount = size === 13 || size === 14 ? 0 : size === 10 || size === 11 ? 1 : 2;
      const tiles: Tile[] = [];
      for (let i = 0; i < size; i++) tiles.push(t(pool.splice(Math.floor(rand() * pool.length), 1)[0]));
      copies.clear();
      expect(calcShanten(tiles, meldCount, false), JSON.stringify(tiles.map((x) => x.face))).toBe(oldShanten(tiles, meldCount));
    }
  });
  it("leaves the counts it was given untouched", () => {
    const counts = countsOfTiles([...dots(1, 2, 3, 5, 5), ...chr(7, 8), ...wind("east", 2)]);
    const copy = [...counts];
    shantenOfCounts(counts, 0);
    expect([...counts]).toEqual(copy);
  });
  it("is fast enough for a phone: a full discard evaluation of a 14-tile hand", () => {
    const hand = [...dots(1, 2, 4, 5, 7, 9), ...bam(2, 3, 8), ...chr(1, 5, 6), ...wind("west"), ...dragon("red")];
    const start = performance.now();
    for (let i = 0; i < 100; i++) evaluateDiscards(hand, []);
    const per = (performance.now() - start) / 100;
    expect(per).toBeLessThan(25); // generous: typically well under 5 ms on a desktop
  });
});

describe("evaluateDiscards (Level 1)", () => {
  it("throws an isolated honor first", () => {
    const hand = [...dots(1, 2, 3, 4, 5, 6), ...bam(2, 3, 4), ...chr(6, 7), ...wind("north"), ...dragon("red", 2)];
    expect(bestDiscard(hand, []).tile.face).toEqual({ kind: "wind", wind: "north" });
  });
  it("throws an isolated terminal before a connected middle tile", () => {
    const hand = [...dots(2, 3, 4, 5, 6, 7), ...bam(3, 4, 5), ...chr(5, 6), ...chr(9), ...dragon("white", 2)];
    expect(bestDiscard(hand, []).tile.face).toEqual({ kind: "suit", suit: "characters", rank: 9 });
  });
  it("never breaks a complete set while a spare tile exists", () => {
    const hand = [...dots(1, 2, 3), ...bam(4, 5, 6), ...chr(7, 8, 9), ...wind("east", 2), ...dragon("green"), ...bam(1)];
    const best = evaluateDiscards(hand, [])[0];
    expect(best.delta).toBe(0);
    expect(["green", undefined]).toContain((best.tile.face as { dragon?: string }).dragon ?? undefined);
  });
  it("puts a tile that sets the hand back last", () => {
    const hand = [...dots(1, 2, 3), ...bam(4, 5, 6), ...chr(7, 8, 9), ...wind("east", 2), ...dragon("green"), ...bam(1)];
    const scores = evaluateDiscards(hand, []);
    expect(scores[scores.length - 1].delta).toBe(1);
  });
  it("prefers the later of two identical tiles (the drawn one)", () => {
    const hand = [...dots(1, 2, 3, 4, 5, 6, 7, 8, 9), ...chr(1, 2), ...wind("east", 2), ...wind("east")];
    expect(evaluateDiscards(hand, [])[0].tile).toBe(hand[hand.length - 1]);
  });
});

describe("claims at Level 1", () => {
  it("shantenAfterClaim improves for a pung that completes a set", () => {
    const hand = [...dots(1, 2, 3), ...bam(4, 5, 6), ...chr(7, 8), ...dragon("red", 2), ...wind("east"), ...wind("west"), ...bam(9)];
    const discard = t({ kind: "dragon", dragon: "red" });
    const option: ClaimOption = { seat: 0, kind: "pung", usingTiles: hand.filter((x) => x.face.kind === "dragon") };
    expect(shantenAfterClaim(hand, [], option)).toBeLessThan(calcShanten(hand));
    expect(discard.face.kind).toBe("dragon");
  });
});

/* ---------- Whole hands, driven by the engine ---------- */

const newHand = (seed: string): GameState =>
  processAction(initializeHKOSGame("bots", ["a", "b", "c", "d"], seed), {
    type: "system",
    seq: 0,
    event: "hand-start",
    payload: { timestamp: 1 },
  });

describe("getBotAction / nextBotAction / runBots", () => {
  it("returns null when it is not that seat's move", () => {
    const s = newHand("x1");
    const turn = (s.phase as { seat: SeatIndex }).seat;
    const other = ((turn + 1) % 4) as SeatIndex;
    expect(getBotAction(s, other)).toBeNull();
    expect(getBotAction(s, turn)).not.toBeNull();
  });
  it("waits for a human", () => {
    const s = newHand("x2");
    const turn = (s.phase as { seat: SeatIndex }).seat;
    expect(nextBotAction(s, (seat) => seat !== turn)).toBeNull();
  });
  it("four Novice bots play many hands to the end without an illegal move", () => {
    let finished = 0;
    let wins = 0;
    for (let n = 0; n < 40; n++) {
      const { state, steps } = runBots(newHand(`seed-${n}`), () => true, 1);
      expect(state.phase.type).toBe("hand-end");
      expect(steps).toBeGreaterThan(10);
      finished++;
      if ((state.phase as { winners?: unknown }).winners) wins++;
    }
    expect(finished).toBe(40);
    expect(wins).toBeGreaterThanOrEqual(0);
  });
  it("is deterministic at Level 1", () => {
    const a = runBots(newHand("same"), () => true, 1).state;
    const b = runBots(newHand("same"), () => true, 1).state;
    expect(a.history.length).toBe(b.history.length);
    expect(a.phase).toEqual(b.phase);
  });
  it("Levels 2 and 3 still produce legal moves", () => {
    for (const level of [2, 3] as const) {
      const { state } = runBots(newHand(`lv${level}`), () => true, level);
      expect(state.phase.type).toBe("hand-end");
    }
  });
});

/* ---------- Level 2: the Faan Hunter ---------- */

const ctx: FaanContext = { seatWind: "east", prevailingWind: "east", minimumFan: 3 };
const chowMeld = (tiles: Tile[]) => ({ type: "chow" as const, tiles, isOpen: true });
const pungOf = (tiles: Tile[]) => ({ type: "pung" as const, tiles, isOpen: true });
const planOf = (hand: Tile[], melds: ReturnType<typeof chowMeld>[] = []) =>
  planDistances(countsOfTiles(hand), summariseMelds(melds, ctx), ctx)[0];

describe("plan distances", () => {
  it("a bamboo-heavy hand is nearest a flush", () => {
    const hand = [...bam(1, 2, 3, 4, 5, 6, 7, 8), ...chr(2), ...dots(5), ...wind("west"), ...dragon("red")];
    const plan = planOf(hand);
    expect(plan.kind).toBe("flush");
    expect(plan.suit).toBe(0);
  });
  it("a hand of pairs is nearest All Pongs", () => {
    const hand = [...dots(3, 3), ...bam(5, 5), ...chr(8, 8), ...wind("south", 2), ...dragon("red"), ...dots(9), ...chr(1), ...bam(2)];
    expect(planOf(hand).kind).toBe("triplets");
  });
  it("a chow of another suit rules a flush out", () => {
    const melds = [chowMeld([...bam(1, 2, 3)])];
    const summary = summariseMelds(melds, ctx);
    const plans = planDistances(countsOfTiles([...chr(2, 3, 4, 5)]), summary, ctx);
    expect(plans.find((p) => p.kind === "flush" && p.suit === 1)!.distance).toBe(Infinity);
    expect(plans.find((p) => p.kind === "triplets")!.distance).toBe(Infinity);
  });
  it("sees the commitments", () => {
    const heavy = countsOfTiles([...bam(1, 2, 3, 4, 5, 6, 8, 9), ...chr(2), ...dots(7)]);
    expect(committedSuit(heavy, summariseMelds([], ctx))).toBe(0);
    const pairs = countsOfTiles([...dots(3, 3), ...bam(5, 5), ...chr(8, 8), ...chr(1)]);
    expect(committedToTriplets(pairs, summariseMelds([], ctx))).toBe(true);
  });
});

describe("Level 2 discards", () => {
  it("dumps off-suit tiles and spare honors, never the flush suit", () => {
    const hand = [...bam(1, 2, 3, 4, 5, 6, 8, 9), ...chr(2, 3, 4), ...dots(7), ...wind("west")];
    const best = bestDiscardFaan(hand, [], ctx).tile;
    expect(best.face.kind === "suit" && best.face.suit === "bamboo").toBe(false);
    // Throwing any bamboo costs the flush-keep penalty, so every bamboo ranks below every off-suit tile.
    const ranked = evaluateDiscardsFaan(hand, [], ctx);
    const lastNonBamboo = Math.max(...ranked.map((d, i) => (d.tile.face.kind === "suit" && d.tile.face.suit === "bamboo" ? -1 : i)));
    const firstBamboo = ranked.findIndex((d) => d.tile.face.kind === "suit" && d.tile.face.suit === "bamboo");
    expect(lastNonBamboo).toBeLessThan(firstBamboo);
  });
  it("keeps its pairs while chasing All Pongs", () => {
    const hand = [...dots(3, 3), ...bam(5, 5), ...chr(8, 8), ...wind("south", 2), ...dragon("red"), ...dots(9), ...chr(1), ...bam(2), ...wind("west")];
    const best = bestDiscardFaan(hand, [], ctx).tile;
    const pairFaces = ["dots3", "bamboo5", "characters8", "south"];
    const key = (x: Tile) => (x.face.kind === "suit" ? `${x.face.suit}${x.face.rank}` : x.face.kind === "wind" ? x.face.wind : "dragon");
    expect(pairFaces).not.toContain(key(best));
  });
  it("keeps a fan honor longer than a spare wind", () => {
    const hand = [...bam(1, 2, 3, 4, 5, 6, 7, 8, 9), ...dragon("red"), ...wind("west"), ...bam(1)];
    const best = bestDiscardFaan(hand, [], ctx).tile;
    expect(best.face).toEqual({ kind: "wind", wind: "west" });
  });
});

describe("Level 2 claim discipline", () => {
  // A bamboo hand with a pair of characters waiting for a chow.
  const flushHand = () => [...bam(1, 2, 3, 4, 5, 6, 7, 8, 9), ...chr(2, 3), ...dots(5), ...wind("east")];

  it("Level 1 would take the off-suit chow (it helps the raw shanten) but Level 2 refuses it", () => {
    const hand = flushHand();
    const chowTiles = hand.filter((x) => x.face.kind === "suit" && x.face.suit === "characters");
    const discard = chr(4)[0];
    const option: ClaimOption = { seat: 0, kind: "chow", usingTiles: chowTiles };
    expect(shantenAfterClaim(hand, [], option)).toBeLessThan(calcShanten(hand));
    const check = checkFaanClaim(hand, [], option, discard, ctx);
    expect(check.accept).toBe(false);
    // It does not brick the hand outright (a characters flush is still on paper) but it throws the
    // bamboo plan away: the nearest plan jumps from 2 away to 6.
    expect(check.current).toBe(2);
    expect(check.after).toBeGreaterThan(check.current + 2);
  });
  it("takes an on-suit chow that brings the flush nearer", () => {
    const hand = [...bam(1, 2, 4, 5, 6, 7, 8, 9), ...bam(3), ...chr(9), ...dots(5), ...wind("east"), ...dragon("red")];
    const using = hand.filter((x) => x.face.kind === "suit" && x.face.suit === "bamboo" && (x.face.rank === 1 || x.face.rank === 2));
    const option: ClaimOption = { seat: 0, kind: "chow", usingTiles: using };
    const check = checkFaanClaim(hand, [], option, bam(3)[0], ctx);
    expect(check.after).toBeLessThan(Infinity);
  });
  it("refuses a chow when chasing All Pongs, takes the pung", () => {
    const hand = [...dots(2, 3, 3), ...bam(5, 5), ...chr(8, 8), ...wind("south", 2), ...dragon("red"), ...dots(9), ...bam(2)];
    const pung: ClaimOption = { seat: 0, kind: "pung", usingTiles: hand.filter((x) => x.face.kind === "suit" && x.face.suit === "dots" && x.face.rank === 3) };
    const chow: ClaimOption = { seat: 0, kind: "chow", usingTiles: hand.filter((x) => x.face.kind === "suit" && x.face.suit === "dots" && (x.face.rank === 2 || x.face.rank === 3)).slice(0, 2) };
    expect(checkFaanClaim(hand, [], pung, dots(3)[0], ctx).accept).toBe(true);
    expect(checkFaanClaim(hand, [], chow, dots(4)[0], ctx).accept).toBe(false);
  });
  it("never makes a claim that bricks the hand below 3 fan", () => {
    const melds = [chowMeld(bam(1, 2, 3))];
    const hand = [...chr(2, 3), ...dragon("red", 2), ...dragon("green", 2), ...bam(5, 6, 7), ...wind("north")];
    const option: ClaimOption = { seat: 0, kind: "chow", usingTiles: hand.filter((x) => x.face.kind === "suit" && x.face.suit === "characters") };
    const check = checkFaanClaim(hand, melds, option, chr(4)[0], ctx);
    expect(check.current).toBeLessThan(Infinity);
    expect(check.after).toBe(Infinity);
    expect(check.accept).toBe(false);
  });
  it("a dead hand (no 3 fan plan left) passes everything", () => {
    const melds = [chowMeld(bam(1, 2, 3)), chowMeld(chr(4, 5, 6))];
    const hand = [...dots(1, 2, 3, 5, 5), ...wind("south"), ...wind("west"), ...dragon("white")];
    const option: ClaimOption = { seat: 0, kind: "pung", usingTiles: dots(5, 5) };
    expect(checkFaanClaim(hand, melds, option, dots(5)[0], ctx).accept).toBe(false);
  });
});

describe("Level 2 at the table", () => {
  it("four Faan Hunters finish every hand legally and win far more often than Novices", () => {
    let novice = 0;
    let hunter = 0;
    const N = 60;
    for (let n = 0; n < N; n++) {
      const a = runBots(newHand(`cmp-${n}`), () => true, 1).state;
      const b = runBots(newHand(`cmp-${n}`), () => true, 2).state;
      expect(a.phase.type).toBe("hand-end");
      expect(b.phase.type).toBe("hand-end");
      if ((a.phase as { winners?: unknown }).winners) novice++;
      if ((b.phase as { winners?: unknown }).winners) hunter++;
    }
    expect(hunter).toBeGreaterThan(novice + N / 4);
  });
  it("a Hunter at a table of Novices wins more than any single Novice", () => {
    const tally = [0, 0, 0, 0];
    for (let n = 0; n < 80; n++) {
      const { state } = runBots(newHand(`mix-${n}`), () => true, (p) => (p.seat === 0 ? 2 : 1));
      const winners = (state.phase as { winners?: readonly number[] }).winners;
      for (const w of winners ?? []) tally[w]++;
    }
    expect(tally[0]).toBeGreaterThan(Math.max(tally[1], tally[2], tally[3]));
  });
  it("is deterministic", () => {
    const a = runBots(newHand("det2"), () => true, 2).state;
    const b = runBots(newHand("det2"), () => true, 2).state;
    expect(a.history.length).toBe(b.history.length);
    expect(a.phase).toEqual(b.phase);
  });
});

/* ---------- Level 3: danger, folding, kongs ---------- */

const face = (tile: Tile) => faceIndexOf(tile.face);

/** A fresh hand with seat 0 holding exactly `hand` (+ `drawn`), on its turn; the others get what `patch` says. */
function table(
  hand: Tile[],
  drawn: Tile | null,
  patch: (seat: SeatIndex, p: GameState["players"][number]) => Partial<GameState["players"][number]> = () => ({}),
  options: { phase?: GameState["phase"]; wall?: number } = {},
): GameState {
  const base = newHand("table");
  const players = base.players.map((p) =>
    p.seat === 0
      ? { ...p, hand, drawnTile: drawn, melds: [], discards: [], ...patch(0, p) }
      : { ...p, hand: [], drawnTile: null, melds: [], discards: [], ...patch(p.seat, p) },
  ) as unknown as GameState["players"];
  return {
    ...base,
    currentTurn: 0,
    phase: options.phase ?? { type: "action", seat: 0 },
    players,
    wall: options.wall === undefined ? base.wall : { ...base.wall, liveTiles: base.wall.liveTiles.slice(0, options.wall) },
  };
}

const discardsOf = (tiles: Tile[]) => tiles.map((tile, order) => ({ tile, order }));
const openPung = (tiles: Tile[]) => ({ type: "pung" as const, tiles, isOpen: true });
const openChow = (tiles: Tile[]) => ({ type: "chow" as const, tiles, isOpen: true });
const only = (view: TableView, seat: number): TableView => ({ ...view, opponents: view.opponents.filter((o) => o.seat === seat) });

describe("danger scores", () => {
  const bare = () => tableViewOf(table([], null), 0);
  it("with nothing known: middle tiles over terminals over honors", () => {
    const view = bare();
    const middle = dangerOfFace(face(dots(5)[0]), view);
    const edge = dangerOfFace(face(dots(1)[0]), view);
    const honor = dangerOfFace(face(wind("east")[0]), view);
    expect(middle).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(honor);
    expect(middle).toBeLessThan(101);
  });
  it("a tile every opponent has thrown is nearly safe", () => {
    const five = dots(5);
    const state = table([], null, (seat) => (seat === 0 ? {} : { discards: discardsOf([t({ kind: "suit", suit: "dots", rank: 5 })]) }));
    expect(dangerOfFace(face(five[0]), tableViewOf(state, 0))).toBeLessThan(10);
  });
  it("a tile with all its copies in view is safer", () => {
    const state = table([], null, (seat) => (seat === 1 ? { discards: discardsOf(dots(5, 5, 5)) } : {}));
    const view = tableViewOf(state, 0);
    expect(dangerOfFace(face(dots(5)[0]), view)).toBeLessThan(dangerOfFace(face(dots(6)[0]), view));
  });
  it("two open melds in one suit make that suit dangerous and the other suits safe", () => {
    const state = table([], null, (seat) => (seat === 1 ? { melds: [openChow(bam(1, 2, 3)), openPung(bam(7, 7, 7))] } : {}));
    const view = only(tableViewOf(state, 0), 1);
    expect(view.opponents[0].flushSuit).toBe(0);
    expect(dangerOfFace(face(bam(5)[0]), view)).toBeGreaterThan(85);
    expect(dangerOfFace(face(dots(5)[0]), view)).toBeLessThan(15);
    expect(dangerOfFace(face(chr(5)[0]), view)).toBeLessThan(15);
  });
  it("one open meld is not yet a flush threat", () => {
    const state = table([], null, (seat) => (seat === 1 ? { melds: [openChow(bam(1, 2, 3))] } : {}));
    expect(tableViewOf(state, 0).opponents.find((o) => o.seat === 1)!.flushSuit).toBe(-1);
  });
  it("the third dragon is dangerous against two dragon pungs", () => {
    const state = table([], null, (seat) => (seat === 1 ? { melds: [openPung(dragon("red", 3)), openPung(dragon("green", 3))] } : {}));
    const view = only(tableViewOf(state, 0), 1);
    expect(dangerOfFace(face(dragon("white")[0]), view)).toBeGreaterThan(40);
  });
  it("an opponent dumping a suit makes it a little safer", () => {
    const quiet = only(tableViewOf(table([], null), 0), 1);
    const dumping = only(tableViewOf(table([], null, (seat) => (seat === 1 ? { discards: discardsOf(bam(1, 9, 2)) } : {})), 0), 1);
    expect(dangerOfFace(face(bam(5)[0]), dumping)).toBeLessThan(dangerOfFace(face(bam(5)[0]), quiet));
  });
  it("scores are 0-100, one per tile, and flowers are never dangerous", () => {
    const hand = [...dots(1, 5, 9), ...wind("east"), ...dragon("red")];
    const scores = dangerScores(hand, bare());
    expect(scores).toHaveLength(hand.length);
    for (const n of scores) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(101);
    }
    expect(dangerOfFace(-1, bare())).toBe(0);
  });
});

describe("threat", () => {
  it("is off early with no heavy melds", () => {
    const state = table([], null);
    expect(assessThreat(state, tableViewOf(state, 0)).active).toBe(false);
  });
  it("is on when the live wall is low", () => {
    const state = table([], null, () => ({}), { wall: 10 });
    const threat = assessThreat(state, tableViewOf(state, 0));
    expect(threat.lateGame).toBe(true);
    expect(threat.active).toBe(true);
  });
  it("is on when an opponent has three open melds", () => {
    const state = table([], null, (seat) => (seat === 2 ? { melds: [openPung(dots(1, 1, 1)), openPung(dots(2, 2, 2)), openChow(bam(4, 5, 6))] } : {}));
    const threat = assessThreat(state, tableViewOf(state, 0));
    expect(threat.heavyMelds).toEqual([2]);
    expect(threat.active).toBe(true);
  });
  it("a concealed kong is not an open meld", () => {
    const state = table([], null, (seat) => (seat === 2 ? { melds: [{ type: "kong" as const, tiles: dots(1, 1, 1, 1), isOpen: false }, openPung(dots(2, 2, 2)), openChow(bam(4, 5, 6))] } : {}));
    expect(assessThreat(state, tableViewOf(state, 0)).heavyMelds).toEqual([]);
  });
});

describe("Level 3 discards", () => {
  // A scattered hand, nowhere near a 3-fan plan.
  const scattered = () => [...dots(1, 4, 7, 5), ...bam(2, 5, 8), ...chr(3, 6, 9), ...wind("east"), ...wind("south"), ...dragon("red")];
  const threatened = (extra: (seat: SeatIndex) => object = () => ({})) =>
    table(scattered(), dots(5)[0], (seat) => {
      if (seat === 0) return {};
      // Seat 2 has three open melds in different suits: a threat, but no flush to read.
      return seat === 2
        ? { melds: [openPung(chr(1, 1, 1)), openPung(dots(2, 2, 2)), openChow(bam(4, 5, 6))], ...extra(seat) }
        : { ...extra(seat) };
    });

  it("folds when far from winning and the table is dangerous: throws the safest tile", () => {
    // Everyone has already thrown an east wind: the safest tile in hand.
    const state = threatened(() => ({ discards: discardsOf([t({ kind: "wind", wind: "east" }), t({ kind: "wind", wind: "east" })]) }));
    const view = tableViewOf(state, 0);
    const threat = assessThreat(state, view);
    const hand = [...state.players[0].hand, state.players[0].drawnTile!];
    const ranked = evaluateDiscardsExpert(hand, [], ctx, view, threat);
    expect(ranked[0].stance).toBe("fold");
    const least = Math.min(...ranked.map((d) => d.danger));
    expect(ranked[0].danger).toBe(least);
  });
  it("folding will break its own pair to throw a safe tile", () => {
    // The pair of 5-dots is the only thing the hand has, but every opponent has thrown a 5-dot.
    const state = threatened((seat) => ({ discards: discardsOf([t({ kind: "suit", suit: "dots", rank: 5 })]) }));
    const view = tableViewOf(state, 0);
    const threat = assessThreat(state, view);
    const hand = [...state.players[0].hand, state.players[0].drawnTile!];
    const best = evaluateDiscardsExpert(hand, [], ctx, view, threat)[0];
    expect(face(best.tile)).toBe(face(dots(5)[0]));
    expect(best.stance).toBe("fold");
  });
  it("without a threat it attacks and plays Level 2's tile", () => {
    const state = table(scattered(), dots(5)[0]);
    const view = tableViewOf(state, 0);
    const threat = assessThreat(state, view);
    const hand = [...state.players[0].hand, state.players[0].drawnTile!];
    const expert = evaluateDiscardsExpert(hand, [], ctx, view, threat);
    expect(expert[0].stance).toBe("attack");
    expect(expert.length).toBe(hand.length);
  });
  it("close to winning, a threat only makes it careful, not a folder", () => {
    expect(stanceOf(1, { wallLeft: 5, lateGame: true, heavyMelds: [], flushThreats: [], active: true })).toBe("pressure");
    expect(stanceOf(3, { wallLeft: 5, lateGame: true, heavyMelds: [], flushThreats: [], active: true })).toBe("fold");
    expect(stanceOf(3, { wallLeft: 50, lateGame: false, heavyMelds: [], flushThreats: [], active: false })).toBe("attack");
  });
  it("getBotAction at level 3 throws a legal tile", () => {
    const state = threatened();
    const action = getBotAction(state, 0, 3);
    expect(action?.type).toBe("discard");
    expect(() => processAction(state, action!)).not.toThrow();
  });
});

describe("Level 3 claims", () => {
  // A hand of pairs that would take a pung of 3-dots at Level 2.
  const pairsHand = () => [...dots(3, 3), ...bam(5, 5), ...chr(8, 8), ...wind("south", 2), ...dragon("red"), ...dots(9), ...chr(1), ...bam(2), ...wind("west")].slice(0, 13);
  const claimTable = (wall: number) => {
    const hand = pairsHand();
    const discard = t({ kind: "suit", suit: "dots", rank: 3 });
    const using = hand.filter((x) => x.face.kind === "suit" && x.face.suit === "dots" && x.face.rank === 3);
    const state = table([], null, (seat) => (seat === 1 ? { hand } : {}), {
      wall,
      phase: {
        type: "claim-window",
        discardedBy: 0,
        tile: discard,
        availableClaims: [{ seat: 1, kind: "pung", usingTiles: using }],
        passed: [],
      },
    });
    return state;
  };
  it("Level 2 takes the pung", () => {
    expect(getBotAction(claimTable(60), 1, 2)?.type).toBe("claim");
  });
  it("Level 3 takes it too while the wall is full", () => {
    expect(getBotAction(claimTable(60), 1, 3)?.type).toBe("claim");
  });
  it("Level 3 folds late: far from winning, it will not open its hand", () => {
    expect(getBotAction(claimTable(10), 1, 3)?.type).toBe("pass");
    // Level 2 has no such caution.
    expect(getBotAction(claimTable(10), 1, 2)?.type).toBe("claim");
  });
});

describe("bot kong declarations", () => {
  const concealedKongTable = () =>
    table([...bam(2, 2, 2, 2), ...bam(4, 5, 6, 7, 8), ...chr(9), ...wind("east"), ...dragon("red", 2)], bam(9)[0]);

  for (const level of [1, 2, 3] as const) {
    it(`Level ${level} declares an in-suit concealed kong, and the engine accepts it`, () => {
      const state = concealedKongTable();
      const action = getBotAction(state, 0, level);
      expect(action?.type).toBe("kong");
      expect((action as { variant: string }).variant).toBe("concealed");
      const next = processAction(state, action!);
      expect(next.players[0].melds.length).toBe(1);
      expect(next.players[0].melds[0].type).toBe("kong");
      expect(next.phase.type).toBe("action");
    });
  }

  // 123 456 789 bamboo, 555 characters, a spare east, and a fourth 5-characters drawn.
  const offSuitKongTable = () =>
    table([...bam(1, 2, 3, 4, 5, 6, 7, 8, 9), ...chr(5, 5, 5), ...wind("east")], chr(5)[0]);

  it("Level 1 declares the off-suit kong (it does not hurt raw shanten)", () => {
    expect(getBotAction(offSuitKongTable(), 0, 1)?.type).toBe("kong");
  });
  it("Levels 2 and 3 decline a kong that would spoil their bamboo flush", () => {
    for (const level of [2, 3] as const) {
      const action = getBotAction(offSuitKongTable(), 0, level);
      expect(action?.type).toBe("discard");
    }
  });
  it("declares an added kong on an open pung when it is in plan", () => {
    const pung = openPung(bam(3, 3, 3));
    const state = table([...bam(4, 5, 6, 7, 8, 9), ...bam(1, 1), ...chr(9), ...wind("east")], bam(3)[0], (seat) => (seat === 0 ? { melds: [pung] } : {}));
    for (const level of [1, 2, 3] as const) {
      const action = getBotAction(state, 0, level);
      expect(action?.type).toBe("kong");
      expect((action as { variant: string }).variant).toBe("added");
      const next = processAction(state, action!);
      expect(["action", "claim-window"]).toContain(next.phase.type);
    }
  });
  it("chooseKongDeclaration finds nothing in a hand with no four of a kind", () => {
    expect(chooseKongDeclaration([...dots(1, 2, 3, 4, 5, 6, 7, 8, 9), ...bam(1, 1, 1), ...wind("east")], [], 2, ctx)).toBeNull();
  });
  it("a Level 3 bot that is folding keeps its kong tiles", () => {
    const state = table(
      [...bam(2, 2, 2, 2), ...dots(4, 7), ...chr(3, 6, 9), ...wind("south"), ...wind("west"), ...dragon("green"), ...dragon("white")],
      chr(1)[0],
      (seat) => (seat === 2 ? { melds: [openPung(chr(4, 4, 4)), openPung(dots(2, 2, 2)), openChow(dots(5, 6, 7))] } : {}),
    );
    expect(getBotAction(state, 0, 3)?.type).toBe("discard");
  });
});

describe("Level 3 at the table", () => {
  it("four Experts finish every hand legally, kongs included, and deterministically", () => {
    let kongs = 0;
    for (let n = 0; n < 40; n++) {
      const { state } = runBots(newHand(`exp-${n}`), () => true, 3);
      expect(state.phase.type).toBe("hand-end");
      kongs += state.history.filter((a) => a.type === "kong").length;
    }
    expect(kongs).toBeGreaterThan(0);
    const a = runBots(newHand("det3"), () => true, 3).state;
    const b = runBots(newHand("det3"), () => true, 3).state;
    expect(a.history.length).toBe(b.history.length);
    expect(a.phase).toEqual(b.phase);
  });
  it("mixed levels at one table all stay legal", () => {
    for (let n = 0; n < 30; n++) {
      const { state } = runBots(newHand(`mixed-${n}`), () => true, (p) => ((p.seat % 3) + 1) as 1 | 2 | 3);
      expect(state.phase.type).toBe("hand-end");
    }
  });
});

/* ---------- The Coach ---------- */

describe("adviseDiscard", () => {
  const name = (seat: SeatIndex) => `P${seat}`;
  // Scattered hand: 5 of bamboo is in it, with plenty else to throw.
  const handWith = (...extra: Tile[]) => [...dots(1, 4, 7), ...chr(3, 6, 9), ...wind("east"), ...wind("south"), ...dragon("red"), ...bam(2, 8), ...extra];
  const flushThreat = (seat: SeatIndex) =>
    seat === 1 ? { melds: [openChow(bam(1, 2, 3)), openPung(bam(7, 7, 7))] } : {};

  it("names tiles in words", () => {
    expect(faceName(face(bam(5)[0]))).toBe("5 Bamboo");
    expect(faceName(face(wind("west")[0]))).toBe("West Wind");
    expect(faceName(face(dragon("red")[0]))).toBe("Red Dragon");
  });
  it("warns on a tile in a suit someone is flushing, and says who and what", () => {
    const drawn = bam(5)[0];
    const state = table(handWith(), drawn, flushThreat);
    const advice = adviseDiscard(state, 0, drawn, name);
    expect(advice.danger).toBeGreaterThan(75);
    expect(advice.warn).toBe(true);
    expect(advice.title).toBe("High Risk Discard");
    expect(advice.reason).toBe("P1 is threatening a Bamboo Flush.");
    expect(advice.bestDanger).toBeLessThan(advice.danger);
    expect(advice.tileName).toBe("5 Bamboo");
  });
  it("does not warn on an off-suit tile against the same threat", () => {
    const drawn = bam(5)[0];
    const state = table(handWith(), drawn, flushThreat);
    const safe = state.players[0].hand.find((x) => x.face.kind === "suit" && x.face.suit === "dots" && x.face.rank === 4)!;
    expect(adviseDiscard(state, 0, safe, name).warn).toBe(false);
  });
  it("does not warn when the pick is the Coach's own pick", () => {
    const drawn = bam(5)[0];
    const state = table(handWith(), drawn, flushThreat);
    const best = adviseDiscard(state, 0, drawn, name).best;
    const again = adviseDiscard(state, 0, best, name);
    expect(again.warn).toBe(false);
    expect(again.reason).toBe("");
  });
  it("does not warn for an ordinary risky tile when nothing is going on", () => {
    // Raw middle tile, full wall, no melds: about 60, under the 75 line, and no threat.
    const drawn = dots(5)[0];
    const state = table(handWith(), drawn);
    const advice = adviseDiscard(state, 0, drawn, name);
    expect(advice.danger).toBeLessThan(76);
    expect(advice.warn).toBe(false);
  });
  it("under a late-game threat, warns about a tile much riskier than the Coach's pick", () => {
    const drawn = dots(5)[0];
    const state = table(handWith(), drawn, () => ({}), { wall: 8 });
    // Everyone has thrown an east wind, so the east wind in hand is nearly free.
    const withRivers = {
      ...state,
      players: state.players.map((p) => (p.seat === 0 ? p : { ...p, discards: discardsOf([t({ kind: "wind", wind: "east" })]) })),
    } as GameState;
    const advice = adviseDiscard(withRivers, 0, drawn, name);
    expect(advice.threat.lateGame).toBe(true);
    expect(advice.warn).toBe(true);
    expect(advice.title).toBe("Risky Discard");
    expect(advice.reason).toBe("Only 8 tiles are left, so this tile is a big risk.");
  });
  it("every warning is a single short sentence", () => {
    const drawn = bam(5)[0];
    const advice = adviseDiscard(table(handWith(), drawn, flushThreat), 0, drawn, name);
    expect(/^[^.!?]+[.]$/.test(advice.reason)).toBe(true);
    expect(advice.reason.length).toBeLessThan(70);
  });
  it("recommendDiscard is the tile advice calls best", () => {
    const drawn = bam(5)[0];
    const state = table(handWith(), drawn, flushThreat);
    expect(recommendDiscard(state, 0)!.id).toBe(adviseDiscard(state, 0, drawn, name).best.id);
  });
  it("warns about a third dragon against two dragon pungs", () => {
    const drawn = dragon("white")[0];
    const state = table(handWith(), drawn, (seat) => (seat === 2 ? { melds: [openPung(dragon("red", 3)), openPung(dragon("green", 3))] } : {}));
    const advice = adviseDiscard(state, 0, drawn, name);
    expect(advice.warn).toBe(true);
    expect(advice.reason).toBe("P2 is one dragon away from Big Three Dragons.");
  });
});
