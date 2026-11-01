import { getHiddenKongs, getPromotedKongs } from "../evaluator.ts";
import type { ClaimKind, ClaimOption, Meld, Tile } from "../types.ts";
import { dangerScores } from "./danger.ts";
import type { TableView, Threat } from "./danger.ts";
import {
  committedSuit,
  committedToTriplets,
  faanDistance,
  honorValue,
  nearestPlan,
  summariseMelds,
} from "./patterns.ts";
import type { FaanContext, MeldSummary, Plan } from "./patterns.ts";
import {
  calcShanten,
  FACE_COUNT,
  countsOfTiles,
  faceIndexOf,
  isHonorFace,
  shantenOfCounts,
} from "./shanten.ts";

/** One way to discard, scored. */
export interface DiscardScore {
  readonly tile: Tile;
  /** Shanten of the hand once this tile is gone. */
  readonly shantenAfter: number;
  /** `shantenAfter` minus the shanten of the hand as it stands: 0 keeps pace, 1 sets it back. */
  readonly delta: number;
  /**
   * How many tiles (counted by face, from this hand's point of view only) would improve the
   * hand next. Only worked out for the best tier of discards; 0 for the rest.
   */
  readonly ukeire: number;
  /** Higher is better. Dominated by the shanten delta; see `scoreOf`. */
  readonly score: number;
}

/** Shanten delta outweighs everything else: one step of shanten is worth more than any ukeire. */
const SHANTEN_WEIGHT = 1000;

/**
 * Level 1 scoring: `-delta * 1000`, then, among discards that leave the same shanten, the
 * one that keeps the most tiles that help (ukeire), then a small nudge that throws honors
 * before terminals before 2s and 8s before the middle tiles. Both tie-breaks only ever
 * separate discards the shanten could not.
 */
function scoreOf(delta: number, ukeire: number, face: number): number {
  const rank = face % 9;
  const edge = isHonorFace(face) ? 0.3 : rank === 0 || rank === 8 ? 0.2 : rank === 1 || rank === 7 ? 0.1 : 0;
  return -delta * SHANTEN_WEIGHT + ukeire + edge;
}

/** Tiles that would lower the shanten of `counts` (a hand with a free slot), summed by copies left. */
function ukeireOf(counts: Uint8Array, meldCount: number, base: number): number {
  let total = 0;
  for (let face = 0; face < FACE_COUNT; face++) {
    const left = 4 - counts[face];
    if (left <= 0) continue;
    counts[face]++;
    if (shantenOfCounts(counts, meldCount) < base) total += left;
    counts[face]--;
  }
  return total;
}

/**
 * Scores every legal discard from `hand` (all the concealed tiles, drawn tile included),
 * best first. Equal scores keep later tiles first, so a freshly drawn tile goes before an
 * identical one already in the hand.
 */
export function evaluateDiscards(hand: readonly Tile[], melds: readonly Meld[]): DiscardScore[] {
  const meldCount = melds.length;
  const counts = countsOfTiles(hand);
  const before = shantenOfCounts(counts, meldCount);

  // Work per distinct face: a hand holds at most 14 tiles, so at most 14 faces.
  const shantenByFace = new Map<number, number>();
  let best = Infinity;
  for (const tile of hand) {
    const face = faceIndexOf(tile.face);
    if (face < 0 || shantenByFace.has(face)) continue;
    counts[face]--;
    const after = shantenOfCounts(counts, meldCount);
    counts[face]++;
    shantenByFace.set(face, after);
    if (after < best) best = after;
  }

  const ukeireByFace = new Map<number, number>();
  for (const [face, after] of shantenByFace) {
    if (after !== best) continue;
    counts[face]--;
    ukeireByFace.set(face, ukeireOf(counts, meldCount, after));
    counts[face]++;
  }

  const scored = hand.map((tile, order) => {
    const face = faceIndexOf(tile.face);
    // Flowers and the like cannot score, so they are always the first to go.
    if (face < 0) {
      return { order, entry: { tile, shantenAfter: -2, delta: -1, ukeire: 0, score: Infinity } };
    }
    const shantenAfter = shantenByFace.get(face)!;
    const delta = shantenAfter - before;
    const ukeire = ukeireByFace.get(face) ?? 0;
    return { order, entry: { tile, shantenAfter, delta, ukeire, score: scoreOf(delta, ukeire, face) } };
  });

  scored.sort((a, b) => b.entry.score - a.entry.score || b.order - a.order);
  return scored.map((s) => s.entry);
}

/** The discard Level 1 plays: the top of `evaluateDiscards`. */
export function bestDiscard(hand: readonly Tile[], melds: readonly Meld[]): DiscardScore {
  if (hand.length === 0) throw new Error("Cannot discard from an empty hand");
  return evaluateDiscards(hand, melds)[0];
}

/**
 * Shanten once `option` is taken: a pung or chow is followed by the best discard, a kong
 * needs none (its replacement tile comes from the dead wall). `hand` is the concealed tiles
 * WITHOUT the claimed discard, as in `ClaimOption.usingTiles`.
 */
export function shantenAfterClaim(hand: readonly Tile[], melds: readonly Meld[], option: ClaimOption): number {
  const counts = countsOfTiles(hand);
  for (const tile of option.usingTiles) {
    const face = faceIndexOf(tile.face);
    if (face >= 0) counts[face]--;
  }
  const meldCount = melds.length + 1;
  if (option.kind === "kong") return shantenOfCounts(counts, meldCount);

  let best = Infinity;
  for (let face = 0; face < FACE_COUNT; face++) {
    if (counts[face] === 0) continue;
    counts[face]--;
    best = Math.min(best, shantenOfCounts(counts, meldCount));
    counts[face]++;
  }
  return best === Infinity ? shantenOfCounts(counts, meldCount) : best;
}

/** When two claims are equally close to winning, the bigger meld goes first. */
export const CLAIM_PREFERENCE: Record<ClaimKind, number> = { win: 0, kong: 1, pung: 2, chow: 3 };

/* ---------- Level 2: the Faan Hunter ---------- */

/** A discard scored by how far it leaves the hand from a legal (3+ fan) win. */
export interface FaanDiscardScore extends DiscardScore {
  /** Distance to the nearest 3+ fan plan once this tile is gone (Infinity when none is left). */
  readonly planDistance: number;
  /** The plan the hand is closest to after this discard. */
  readonly plan: Plan | null;
}

/** Discarding a tile of the suit the hand is going for. Bigger than any tie-break, smaller than a step of distance. */
export const FLUSH_KEEP_PENALTY = 700;
/** Breaking a pair (or a pung) while chasing All Pongs. */
export const PAIR_KEEP_PENALTY = 450;
export const PUNG_KEEP_PENALTY = 600;

/** Ukeire against the plan distance: tiles that bring the hand a step nearer a 3+ fan win. */
function faanUkeireOf(counts: Uint8Array, summary: MeldSummary, ctx: FaanContext, base: number): number {
  let total = 0;
  for (let face = 0; face < FACE_COUNT; face++) {
    const left = 4 - counts[face];
    if (left <= 0) continue;
    counts[face]++;
    if (faanDistance(counts, summary, ctx) < base) total += left;
    counts[face]--;
  }
  return total;
}

/**
 * Level 2 discards. Distance is measured to the nearest plan that can actually reach the minimum
 * fan (a flush, All Pongs, honor pungs, Thirteen Orphans), not to any four-sets-and-a-pair
 * hand, because a 1-fan hand cannot win. On top of that:
 *
 *   - a hand with 8+ tiles of one suit (melds included) pays FLUSH_KEEP_PENALTY for throwing
 *     a tile of it, so the off-suits and spare honors are dumped first;
 *   - a hand with several pairs and no chow pays PAIR_KEEP_PENALTY / PUNG_KEEP_PENALTY for
 *     breaking one, so it keeps chasing All Pongs instead of trading pairs for chows;
 *   - dragons and the seat and round winds, which score by themselves as pungs, are kept a
 *     hair longer than other honors.
 *
 * With no plan left at all (a bad claim in the past) it plays Level 1: nothing to protect.
 */
export function evaluateDiscardsFaan(
  hand: readonly Tile[],
  melds: readonly Meld[],
  ctx: FaanContext,
): FaanDiscardScore[] {
  const summary = summariseMelds(melds, ctx);
  const counts = countsOfTiles(hand);
  const before = faanDistance(counts, summary, ctx);

  if (before === Infinity) {
    return evaluateDiscards(hand, melds).map((d) => ({ ...d, planDistance: Infinity, plan: null }));
  }

  const suit = committedSuit(counts, summary);
  const pongs = committedToTriplets(counts, summary);

  // Per distinct face, as before.
  const distanceByFace = new Map<number, number>();
  let best = Infinity;
  for (const tile of hand) {
    const face = faceIndexOf(tile.face);
    if (face < 0 || distanceByFace.has(face)) continue;
    counts[face]--;
    const after = faanDistance(counts, summary, ctx);
    counts[face]++;
    distanceByFace.set(face, after);
    if (after < best) best = after;
  }

  const ukeireByFace = new Map<number, number>();
  const planByFace = new Map<number, Plan | null>();
  for (const [face, after] of distanceByFace) {
    counts[face]--;
    planByFace.set(face, nearestPlan(counts, summary, ctx));
    if (after === best) ukeireByFace.set(face, faanUkeireOf(counts, summary, ctx, after));
    counts[face]++;
  }

  const scored = hand.map((tile, order) => {
    const face = faceIndexOf(tile.face);
    if (face < 0) {
      return {
        order,
        entry: { tile, shantenAfter: -2, delta: -1, ukeire: 0, score: Infinity, planDistance: -2, plan: null },
      };
    }
    const planDistance = distanceByFace.get(face)!;
    const delta = planDistance - before;
    const ukeire = ukeireByFace.get(face) ?? 0;

    const rank = face % 9;
    // Fan honors are kept a little longer; other honors and terminals go first.
    let nudge: number;
    if (face >= 27) nudge = honorValue(face, ctx) > 0 ? -0.2 : 0.3;
    else nudge = rank === 0 || rank === 8 ? 0.2 : rank === 1 || rank === 7 ? 0.1 : 0;

    let penalty = 0;
    if (suit >= 0 && face < 27 && Math.floor(face / 9) === suit) penalty += FLUSH_KEEP_PENALTY;
    if (pongs) {
      if (counts[face] === 2) penalty += PAIR_KEEP_PENALTY;
      else if (counts[face] >= 3) penalty += PUNG_KEEP_PENALTY;
    }

    const shantenAfter = (() => {
      counts[face]--;
      const value = shantenOfCounts(counts, melds.length);
      counts[face]++;
      return value;
    })();

    return {
      order,
      entry: {
        tile,
        shantenAfter,
        delta,
        ukeire,
        score: -delta * SHANTEN_WEIGHT + ukeire + nudge - penalty,
        planDistance,
        plan: planByFace.get(face) ?? null,
      },
    };
  });

  scored.sort((a, b) => b.entry.score - a.entry.score || b.order - a.order);
  return scored.map((s) => s.entry);
}

/** The discard Level 2 plays. */
export function bestDiscardFaan(hand: readonly Tile[], melds: readonly Meld[], ctx: FaanContext): FaanDiscardScore {
  if (hand.length === 0) throw new Error("Cannot discard from an empty hand");
  return evaluateDiscardsFaan(hand, melds, ctx)[0];
}

/** What a claim does to the hand's fan prospects. */
export interface FaanClaimCheck {
  /** Plan distance now. Infinity: the hand can no longer reach the minimum fan. */
  readonly current: number;
  /** Plan distance after the claim and the best discard after it (Infinity if the claim bricks the hand). */
  readonly after: number;
  /** The claim is a pung or kong of dragons, the seat wind or the round wind: it banks fan at once. */
  readonly banksFan: boolean;
  /** Level 2 takes it: still able to reach 3 fan, and nearer to winning (or level and banking fan). */
  readonly accept: boolean;
}

/**
 * Claim discipline. A claim is refused when it rules out every 3+ fan plan (it would brick the
 * hand), and also when it would leave the hand no nearer a winning plan than it is now, which
 * is what rejects an off-suit chow from a flush hand even though it helps the raw shanten.
 *
 * `hand` is the concealed tiles WITHOUT the claimed `discard`.
 */
export function checkFaanClaim(
  hand: readonly Tile[],
  melds: readonly Meld[],
  option: ClaimOption,
  discard: Tile,
  ctx: FaanContext,
): FaanClaimCheck {
  const current = faanDistance(countsOfTiles(hand), summariseMelds(melds, ctx), ctx);

  const meld: Meld = {
    type: option.kind === "kong" ? "kong" : option.kind === "chow" ? "chow" : "pung",
    tiles: [...option.usingTiles, discard],
    isOpen: true,
  };
  const nextMelds = [...melds, meld];
  const summary = summariseMelds(nextMelds, ctx);

  const counts = countsOfTiles(hand);
  for (const tile of option.usingTiles) {
    const face = faceIndexOf(tile.face);
    if (face >= 0) counts[face]--;
  }

  let after: number;
  if (option.kind === "kong") {
    after = faanDistance(counts, summary, ctx);
  } else {
    after = Infinity;
    for (let face = 0; face < FACE_COUNT; face++) {
      if (counts[face] === 0) continue;
      counts[face]--;
      after = Math.min(after, faanDistance(counts, summary, ctx));
      counts[face]++;
    }
    if (after === Infinity) after = faanDistance(counts, summary, ctx);
  }

  const first = faceIndexOf(discard.face);
  const banksFan = option.kind !== "chow" && first >= 27 && honorValue(first, ctx) > 0;
  const stillPossible = after !== Infinity;
  // A hand already out of 3+ fan plans cannot win; it passes rather than open itself up further.
  const accept =
    current === Infinity
      ? false
      : stillPossible && (after < current || (after === current && banksFan));

  return { current, after, banksFan, accept };
}

/* ---------- Level 3: defense ---------- */

/** More than this many steps from a 3+ fan plan counts as "far from winning". */
export const FOLD_DISTANCE = 2;

/**
 * attack    play for the win (Level 2's discards, with danger as a light tie-break)
 * pressure  there is a threat but the hand is close: keep attacking, avoid the worst tiles
 * fold      there is a threat and the hand is far from winning: throw the safest tile
 */
export type Stance = "attack" | "pressure" | "fold";

export function stanceOf(handDistance: number, threat: Threat): Stance {
  if (!threat.active) return "attack";
  return handDistance > FOLD_DISTANCE ? "fold" : "pressure";
}

/**
 * How much one point of danger costs, per stance. A step of plan distance is worth 1000.
 * Attack is a tie-break only: in simulation a weight of 1 (one tile of ukeire per point) cost
 * Level 3 over a quarter of its wins and saved no deal-ins, so with no threat it plays exactly
 * like Level 2.
 */
export const DANGER_WEIGHT: Record<Stance, number> = { attack: 0.01, pressure: 4, fold: 20 };

/** A discard scored for Level 3. */
export interface ExpertDiscardScore extends FaanDiscardScore {
  /** 0-100, from the public information on the table (see danger.ts). */
  readonly danger: number;
  readonly stance: Stance;
}

/**
 * Level 3 discards: Level 2's plan-aware scores with the table's danger folded in.
 *
 * - attack: `faanScore - 0.01 * danger`: Level 2's choice, with danger only breaking exact ties.
 * - pressure: `faanScore - 4 * danger`: still going for the win, but it will not feed an
 *   opponent a tile that is much more dangerous than the alternatives.
 * - fold: `-20 * danger + faanScore / 100`. Safety decides; the hand's own value only orders
 *   equally safe tiles. This will break pairs, sequences, even a tenpai hand's wait (a hand
 *   close to winning is `pressure`, not `fold`), to throw a tile no one can use.
 *
 * `hand` includes the drawn tile.
 */
export function evaluateDiscardsExpert(
  hand: readonly Tile[],
  melds: readonly Meld[],
  ctx: FaanContext,
  view: TableView,
  threat: Threat,
): ExpertDiscardScore[] {
  const faan = evaluateDiscardsFaan(hand, melds, ctx);

  let handDistance = Infinity;
  for (const d of faan) if (d.planDistance >= -1 && d.planDistance < handDistance) handDistance = d.planDistance;
  const stance = stanceOf(handDistance, threat);

  const dangerByTile = new Map<number, number>();
  const scores = dangerScores(hand, view);
  hand.forEach((tile, i) => dangerByTile.set(tile.id, scores[i]));

  const original = new Map<number, number>();
  faan.forEach((d, i) => original.set(d.tile.id, i));

  const out = faan.map((d) => {
    const danger = dangerByTile.get(d.tile.id) ?? 0;
    // Tiles that cannot score at all (flowers) stay first: Infinity.
    let score: number;
    if (d.score === Infinity) score = Infinity;
    else if (stance === "fold") score = -DANGER_WEIGHT.fold * danger + d.score / 100;
    else score = d.score - DANGER_WEIGHT[stance] * danger;
    return { ...d, danger, stance, score };
  });

  // Same tie rule as before: the faan order (later tile first) decides equal scores.
  return out
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d.score - a.d.score || a.i - b.i)
    .map((x) => x.d);
}

export function bestDiscardExpert(
  hand: readonly Tile[],
  melds: readonly Meld[],
  ctx: FaanContext,
  view: TableView,
  threat: Threat,
): ExpertDiscardScore {
  if (hand.length === 0) throw new Error("Cannot discard from an empty hand");
  return evaluateDiscardsExpert(hand, melds, ctx, view, threat)[0];
}

/** Plan distance of a hand as it stands (13 tiles, or the best 13 after a discard from 14). */
export function handFaanDistance(hand: readonly Tile[], melds: readonly Meld[], ctx: FaanContext): number {
  return faanDistance(countsOfTiles(hand), summariseMelds(melds, ctx), ctx);
}

/* ---------- Declaring your own kongs ---------- */

export type KongPick =
  | { readonly variant: "concealed"; readonly tiles: readonly Tile[] }
  | { readonly variant: "added"; readonly tiles: readonly [Tile] };

/**
 * A concealed or added kong worth declaring on this turn, or null. `held` is the hand with the
 * drawn tile.
 *
 * - Level 1 declares one whenever it does not set the hand back (raw shanten).
 * - Levels 2 and 3 also need the 3+ fan plan to survive: the nearest plan must still exist and be
 *   no further away than before. A concealed kong of characters in a bamboo flush, say, puts a
 *   meld of the wrong suit in the hand and is declined.
 *
 * With several to choose from, the one that leaves the hand nearest a win goes first.
 */
export function chooseKongDeclaration(
  held: readonly Tile[],
  melds: readonly Meld[],
  level: 1 | 2 | 3,
  ctx: FaanContext,
): KongPick | null {
  interface Candidate {
    pick: KongPick;
    rest: Tile[];
    next: Meld[];
  }
  const candidates: Candidate[] = [];

  for (const group of getHiddenKongs(held)) {
    const used = new Set(group.map((t) => t.id));
    candidates.push({
      pick: { variant: "concealed", tiles: group },
      rest: held.filter((t) => !used.has(t.id)),
      next: [...melds, { type: "kong", tiles: group, isOpen: false, kongVariant: "concealed" }],
    });
  }
  for (const option of getPromotedKongs(held, melds)) {
    candidates.push({
      pick: { variant: "added", tiles: [option.tile] },
      rest: held.filter((t) => t.id !== option.tile.id),
      next: melds.map((m) =>
        m === option.meld ? { ...m, type: "kong" as const, tiles: [...m.tiles, option.tile], kongVariant: "added" as const } : m,
      ),
    });
  }
  if (candidates.length === 0) return null;

  const beforeRaw = calcShanten(held, melds.length);
  const beforePlan = handFaanDistance(held, melds, ctx);

  let best: { pick: KongPick; after: number } | null = null;
  for (const c of candidates) {
    let after: number;
    if (level === 1) {
      after = calcShanten(c.rest, c.next.length);
      if (after > beforeRaw) continue;
    } else {
      after = handFaanDistance(c.rest, c.next, ctx);
      if (beforePlan === Infinity || after === Infinity || after > beforePlan) continue;
    }
    if (best === null || after < best.after) best = { pick: c.pick, after };
  }
  return best ? best.pick : null;
}
