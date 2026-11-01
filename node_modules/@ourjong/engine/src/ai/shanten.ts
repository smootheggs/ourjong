import type { Tile, TileFace } from "../types.ts";

/**
 * Shanten: how many tiles a hand is away from winning.
 *
 *   -1  complete (four sets and a pair)
 *    0  ready: one tile from winning
 *    1  needs two more, and so on
 *
 * The usual "four sets and a pair" count is `8 - 2*sets - partials - pair`, where a partial is a
 * pair or a two-tile sequence draw and `sets + partials <= 4`. The suits and the honors never
 * interact, so each of the four groups is scanned on its own (a 9-tile line, small enough that
 * the search is a few hundred nodes at worst) and the four tables are merged with a tiny DP.
 * That is far cheaper than one search over all 34 faces, and it allocates nothing per call:
 * every buffer is reused, so it is safe to call hundreds of times per decision on a phone.
 *
 * Thirteen Orphans (a limit hand in Hong Kong Old Style) is not four sets and a pair, so it is
 * measured separately and the smaller number wins. Only a hand with no melds can be one.
 */

export const FACE_COUNT = 34;

// 0-26 suit tiles (bamboo, characters, dots; ranks 1-9), 27-30 winds (E S W N), 31-33 dragons (R G W).
const SUIT_BASE: Record<string, number> = { bamboo: 0, characters: 9, dots: 18 };
const WIND_BASE = 27;
const WIND_OFFSET: Record<string, number> = { east: 0, south: 1, west: 2, north: 3 };
const DRAGON_BASE = 31;
const DRAGON_OFFSET: Record<string, number> = { red: 0, green: 1, white: 2 };

/** Face index 0-33, or -1 for flowers, seasons and custom faces (they never count toward a hand). */
export function faceIndexOf(face: TileFace): number {
  switch (face.kind) {
    case "suit":
      return SUIT_BASE[face.suit] + face.rank - 1;
    case "wind":
      return WIND_BASE + WIND_OFFSET[face.wind];
    case "dragon":
      return DRAGON_BASE + DRAGON_OFFSET[face.dragon];
    default:
      return -1;
  }
}

export const isSuitFace = (index: number): boolean => index < WIND_BASE;
export const isHonorFace = (index: number): boolean => index >= WIND_BASE;
/** 1s and 9s of the suits, and every honor. */
export const isTerminalOrHonor = (index: number): boolean =>
  index >= WIND_BASE || index % 9 === 0 || index % 9 === 8;

/** How many of each of the 34 faces the tiles hold. */
export function countsOfTiles(tiles: readonly Tile[]): Uint8Array {
  const counts = new Uint8Array(FACE_COUNT);
  for (const tile of tiles) {
    const index = faceIndexOf(tile.face);
    if (index >= 0) counts[index]++;
  }
  return counts;
}

const ORPHANS: readonly number[] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

/* ---------- One group (a suit, or the honors) ---------- */

// Scratch state for the group search (module-level so a call allocates nothing).
let sCounts: Uint8Array = new Uint8Array(0);
let sBase = 0;
let sLen = 0;
let sSuited = false;
let sOut = new Int8Array(10);

/**
 * `out[pair * 5 + sets]` = the most partials that can sit beside `sets` complete sets in this
 * group, with (`pair` = 1) or without a pair taken from it; -1 when that combination is
 * impossible. Sets and partials are capped at four between them, which is all a hand can use.
 */
function dfs(i: number, sets: number, partials: number, pair: number): void {
  while (i < sLen && sCounts[sBase + i] === 0) i++;
  if (i >= sLen) {
    const k = pair * 5 + sets;
    if (partials > sOut[k]) sOut[k] = partials;
    return;
  }
  const at = sBase + i;
  const n = sCounts[at];
  const room = sets + partials < 4;

  if (n >= 3 && sets < 4) {
    sCounts[at] -= 3;
    dfs(i, sets + 1, partials, pair);
    sCounts[at] += 3;
  }
  if (sSuited && sets < 4 && i + 2 < sLen && sCounts[at + 1] > 0 && sCounts[at + 2] > 0) {
    sCounts[at]--;
    sCounts[at + 1]--;
    sCounts[at + 2]--;
    dfs(i, sets + 1, partials, pair);
    sCounts[at]++;
    sCounts[at + 1]++;
    sCounts[at + 2]++;
  }
  if (n >= 2) {
    sCounts[at] -= 2;
    if (pair === 0) dfs(i, sets, partials, 1); // the pair itself
    if (room) dfs(i, sets, partials + 1, pair); // or a pair waiting to become a triplet
    sCounts[at] += 2;
  }
  if (sSuited && room && i + 1 < sLen && sCounts[at + 1] > 0) {
    sCounts[at]--;
    sCounts[at + 1]--;
    dfs(i, sets, partials + 1, pair);
    sCounts[at]++;
    sCounts[at + 1]++;
  }
  if (sSuited && room && i + 2 < sLen && sCounts[at + 2] > 0) {
    sCounts[at]--;
    sCounts[at + 2]--;
    dfs(i, sets, partials + 1, pair);
    sCounts[at]++;
    sCounts[at + 2]++;
  }

  // This tile joins nothing.
  sCounts[at]--;
  dfs(i, sets, partials, pair);
  sCounts[at]++;
}

const tab = new Int8Array(10);
let dpA = new Int8Array(10);
let dpB = new Int8Array(10);

function scanGroup(counts: Uint8Array, base: number, len: number, suited: boolean): boolean {
  let any = false;
  for (let i = 0; i < len; i++) if (counts[base + i] !== 0) { any = true; break; }
  if (!any) return false;
  tab.fill(-1);
  sCounts = counts;
  sBase = base;
  sLen = len;
  sSuited = suited;
  sOut = tab;
  dfs(0, 0, 0, 0);
  return true;
}

/** Shanten toward Thirteen Orphans alone (13 minus the kinds held, minus one for a pair). */
export function orphansShanten(counts: Uint8Array): number {
  let kinds = 0;
  let pair = 0;
  for (const index of ORPHANS) {
    if (counts[index] > 0) kinds++;
    if (counts[index] > 1) pair = 1;
  }
  return 13 - kinds - pair;
}

/**
 * Shanten of a hand given as face counts. `meldCount` is the number of melds already made
 * (a kong counts once). Works for any tile count, so it measures a 14-tile hand, the 13 left
 * after a discard, and the hand after a claim alike. `special` also considers Thirteen Orphans.
 *
 * Note: it reads `counts` but leaves it unchanged when it returns.
 */
export function shantenOfCounts(counts: Uint8Array, meldCount = 0, special = true): number {
  dpA.fill(-1);
  dpA[0] = 0; // no pair, no sets, no partials yet

  for (let g = 0; g < 4; g++) {
    const found = g < 3 ? scanGroup(counts, g * 9, 9, true) : scanGroup(counts, WIND_BASE, 7, false);
    if (!found) continue;
    dpB.fill(-1);
    for (let p1 = 0; p1 < 2; p1++) {
      for (let m1 = 0; m1 < 5; m1++) {
        const a = dpA[p1 * 5 + m1];
        if (a < 0) continue;
        for (let p2 = 0; p1 + p2 < 2; p2++) {
          for (let m2 = 0; m1 + m2 < 5; m2++) {
            const b = tab[p2 * 5 + m2];
            if (b < 0) continue;
            const k = (p1 | p2) * 5 + m1 + m2;
            if (a + b > dpB[k]) dpB[k] = a + b;
          }
        }
      }
    }
    const swap = dpA;
    dpA = dpB;
    dpB = swap;
  }

  let best = 8;
  const maxSets = Math.max(0, 4 - meldCount);
  for (let p = 0; p < 2; p++) {
    for (let m = 0; m <= maxSets; m++) {
      const partials = dpA[p * 5 + m];
      if (partials < 0) continue;
      const sets = m + meldCount;
      const usable = Math.min(partials, Math.max(0, 4 - sets));
      const value = 8 - 2 * sets - usable - p;
      if (value < best) best = value;
    }
  }

  if (special && meldCount === 0) best = Math.min(best, orphansShanten(counts));
  return best;
}

/** Shanten of a list of tiles. See `shantenOfCounts`. Named apart from the older `shanten` in ai.ts. */
export function calcShanten(tiles: readonly Tile[], meldCount = 0, special = true): number {
  return shantenOfCounts(countsOfTiles(tiles), meldCount, special);
}
