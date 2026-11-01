import type { Meld, WindName } from "../types.ts";
import { FACE_COUNT, faceIndexOf, orphansShanten, shantenOfCounts } from "./shanten.ts";

/**
 * Fan awareness for the Level 2 bot.
 *
 * Hong Kong Old Style only lets a hand win with 3 fan or more, and (see PATTERN_FAN in
 * scoring.ts) a 1-fan "Common Hand" can never get there on its own. So every legal win falls in
 * one of a few families, and this file measures how far a hand is from each ("plan distance",
 * counted exactly like shanten: 0 is ready, -1 is complete):
 *
 *   flush     Half or Full Flush (Hun Yat / Ching Yat): one suit, plus honors. 3 fan.
 *   triplets  All Pongs (Deui Deui Wu): four pungs and a pair. 3 fan.
 *   honors    Enough fan from pungs of dragons, the seat wind and the round wind (1 fan each),
 *             with Small Three Dragons' bonus, on top of any other shape.
 *   orphans   Thirteen Orphans, a limit hand.
 *
 * The distance to the nearest plan is the bot's real distance from winning. A plan whose melds
 * are already ruled out (a chow of another suit, say, for a flush) is infinitely far away.
 */

export interface FaanContext {
  readonly seatWind: WindName;
  readonly prevailingWind: WindName;
  /** Fewest fan a hand may win with. Defaults to 3, the Hong Kong Old Style rule. */
  readonly minimumFan?: number;
}

export type PlanKind = "flush" | "triplets" | "honors" | "orphans";

export interface Plan {
  readonly kind: PlanKind;
  /** 0-2 for a flush (bamboo, characters, dots). */
  readonly suit?: number;
  /** Shanten-style distance to this plan; Infinity when the open melds rule it out. */
  readonly distance: number;
  /** Fan the plan is worth if it comes in, counting honor pungs already held. */
  readonly fan: number;
}

const WIND_BASE = 27;
const DRAGON_BASE = 31;
const WIND_ORDER: readonly WindName[] = ["east", "south", "west", "north"];

/** Hand has this many tiles of one suit (melds included): it is going for a flush. */
export const SUIT_COMMIT = 8;
/** This many pairs or pungs (open ones included) and no chow: it is going for All Pongs. */
export const PAIR_COMMIT = 3;

/* ---------- Melds, summarised once ---------- */

export interface MeldSummary {
  readonly count: number;
  /** Every meld is a pung or kong (so All Pongs is still possible). */
  readonly allPungs: boolean;
  /** Bit s set when a meld holds a tile of suit s (0 bamboo, 1 characters, 2 dots). */
  readonly suitMask: number;
  /** Melded tiles in each suit. */
  readonly suitTiles: readonly [number, number, number];
  /** Bit h set when a pung or kong of honor face 27 + h is melded. */
  readonly honorMask: number;
  /** Fan already banked by melded dragon, seat-wind and round-wind pungs. */
  readonly honorFan: number;
}

export function honorValue(face: number, ctx: FaanContext): number {
  if (face >= DRAGON_BASE) return 1;
  if (face < WIND_BASE) return 0;
  const seat = WIND_BASE + WIND_ORDER.indexOf(ctx.seatWind);
  const round = WIND_BASE + WIND_ORDER.indexOf(ctx.prevailingWind);
  return (face === seat ? 1 : 0) + (face === round ? 1 : 0);
}

export function summariseMelds(melds: readonly Meld[], ctx: FaanContext): MeldSummary {
  let allPungs = true;
  let suitMask = 0;
  const suitTiles: [number, number, number] = [0, 0, 0];
  let honorMask = 0;
  let honorFan = 0;
  for (const meld of melds) {
    if (meld.type === "chow") allPungs = false;
    const first = meld.tiles.length > 0 ? faceIndexOf(meld.tiles[0].face) : -1;
    if (first < 0) continue;
    if (first < WIND_BASE) {
      const suit = Math.floor(first / 9);
      suitMask |= 1 << suit;
      suitTiles[suit] += meld.tiles.length;
    } else if (meld.type !== "chow") {
      honorMask |= 1 << (first - WIND_BASE);
      honorFan += honorValue(first, ctx);
    }
  }
  return { count: melds.length, allPungs, suitMask, suitTiles, honorMask, honorFan };
}

/* ---------- Plan distances ---------- */

const scratch = new Uint8Array(FACE_COUNT);

/** Fan from honor triplets sitting in the concealed hand (they score when the hand wins). */
function concealedHonorFan(counts: Uint8Array, ctx: FaanContext): number {
  let fan = 0;
  for (let face = WIND_BASE; face < FACE_COUNT; face++) if (counts[face] >= 3) fan += honorValue(face, ctx);
  return fan;
}

function flushDistance(counts: Uint8Array, summary: MeldSummary, suit: number): number {
  if ((summary.suitMask & ~(1 << suit)) !== 0) return Infinity;
  // Only this suit and the honors count; everything else is dead weight.
  scratch.set(counts);
  for (let face = 0; face < WIND_BASE; face++) if (Math.floor(face / 9) !== suit) scratch[face] = 0;
  return shantenOfCounts(scratch, summary.count, false);
}

function tripletsDistance(counts: Uint8Array, summary: MeldSummary): number {
  if (!summary.allPungs) return Infinity;
  const room = Math.max(0, 4 - summary.count);
  let pungs = 0;
  let pairs = 0;
  for (let face = 0; face < FACE_COUNT; face++) {
    const n = counts[face];
    if (n >= 3) pungs++;
    else if (n === 2) pairs++;
  }
  const spare = Math.max(0, pungs - room); // a pung with nowhere to go can still be the pair
  pungs -= spare;
  const head = pairs > 0 || spare > 0 ? 1 : 0;
  if (pairs > 0) pairs--;
  const partials = Math.min(pairs, room - pungs);
  return 8 - 2 * (summary.count + pungs) - partials - head;
}

/** Best honor-pung plan: the cheapest set of pungs worth `minimumFan` fan (or Infinity), and its fan. */
function honorsPlan(counts: Uint8Array, summary: MeldSummary, ctx: FaanContext): { distance: number; fan: number } {
  const minimum = ctx.minimumFan ?? 3;
  // Honors already held in pairs or better and not yet melded are the candidates.
  const candidates: number[] = [];
  for (let h = 0; h < 7; h++) {
    if ((summary.honorMask & (1 << h)) !== 0) continue;
    if (counts[WIND_BASE + h] >= 2 && honorValue(WIND_BASE + h, ctx) > 0) candidates.push(WIND_BASE + h);
  }
  const room = Math.max(0, 4 - summary.count);

  let bestDistance = Infinity;
  let bestFan = 0;
  for (let pick = 0; pick < 1 << candidates.length; pick++) {
    const chosen = candidates.filter((_, i) => (pick & (1 << i)) !== 0);
    if (chosen.length > room) continue;

    let fan = summary.honorFan;
    let dragons = 0;
    for (let d = 0; d < 3; d++) if ((summary.honorMask & (1 << (4 + d))) !== 0) dragons++;
    for (const face of chosen) {
      fan += honorValue(face, ctx);
      if (face >= DRAGON_BASE) dragons++;
    }
    // Small Three Dragons: two dragon pungs and a pair of the third.
    if (dragons === 2) {
      for (let d = 0; d < 3; d++) {
        const face = DRAGON_BASE + d;
        const taken = (summary.honorMask & (1 << (4 + d))) !== 0 || chosen.includes(face);
        if (!taken && counts[face] >= 2) fan += 3;
      }
    }
    if (fan < minimum) continue;

    scratch.set(counts);
    let missing = 0;
    for (const face of chosen) {
      missing += Math.max(0, 3 - counts[face]);
      scratch[face] = 0;
    }
    const distance = shantenOfCounts(scratch, summary.count + chosen.length, false) + missing;
    if (distance < bestDistance || (distance === bestDistance && fan > bestFan)) {
      bestDistance = distance;
      bestFan = fan;
    }
  }
  return { distance: bestDistance, fan: bestFan };
}

/** Every plan the hand could still win by, nearest first (ties: richer plan first). */
export function planDistances(counts: Uint8Array, summary: MeldSummary, ctx: FaanContext): Plan[] {
  const bonus = summary.honorFan + concealedHonorFan(counts, ctx);
  const plans: Plan[] = [];

  for (let suit = 0; suit < 3; suit++) {
    plans.push({ kind: "flush", suit, distance: flushDistance(counts, summary, suit), fan: 3 + bonus });
  }
  plans.push({ kind: "triplets", distance: tripletsDistance(counts, summary), fan: 3 + bonus });
  const honors = honorsPlan(counts, summary, ctx);
  plans.push({ kind: "honors", distance: honors.distance, fan: honors.fan });
  plans.push({
    kind: "orphans",
    distance: summary.count === 0 ? orphansShanten(counts) : Infinity,
    fan: 13,
  });

  return plans.sort((a, b) => a.distance - b.distance || b.fan - a.fan);
}

/** The nearest plan, or null when no plan is left (the open melds have ruled them all out). */
export function nearestPlan(counts: Uint8Array, summary: MeldSummary, ctx: FaanContext): Plan | null {
  const best = planDistances(counts, summary, ctx)[0];
  return best.distance === Infinity ? null : best;
}

/** Distance to the nearest plan; Infinity when the hand can no longer reach the minimum fan. */
export function faanDistance(counts: Uint8Array, summary: MeldSummary, ctx: FaanContext): number {
  return planDistances(counts, summary, ctx)[0].distance;
}

/* ---------- Commitments (what the hand is leaning toward) ---------- */

/** The suit the hand is heavily in (8+ of its tiles, melds included) while a flush is still open, or -1. */
export function committedSuit(counts: Uint8Array, summary: MeldSummary): number {
  for (let suit = 0; suit < 3; suit++) {
    let total = summary.suitTiles[suit];
    for (let rank = 0; rank < 9; rank++) total += counts[suit * 9 + rank];
    if (total >= SUIT_COMMIT && (summary.suitMask & ~(1 << suit)) === 0) return suit;
  }
  return -1;
}

/** True when the hand holds several pairs (or pungs) and no chow: it should keep them and chase All Pongs. */
export function committedToTriplets(counts: Uint8Array, summary: MeldSummary): boolean {
  if (!summary.allPungs) return false;
  let groups = summary.count;
  for (let face = 0; face < FACE_COUNT; face++) if (counts[face] >= 2) groups++;
  return groups >= PAIR_COMMIT;
}

/** Fan-bearing honors (dragons, seat wind, round wind): worth keeping a little longer than other honors. */
export const isFanHonor = (face: number, ctx: FaanContext): boolean => honorValue(face, ctx) > 0;
