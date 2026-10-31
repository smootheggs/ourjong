import type {
  BotDifficulty,
  ClaimKind,
  ClaimOption,
  DragonName,
  Meld,
  SuitName,
  Tile,
  TileFace,
  WindName,
} from "./types.ts";
import { calculateFan } from "./scoring.ts";

/** Source of randomness in [0, 1). Defaults to Math.random; tests pass a stub. */
export type Rng = () => number;

/* ---------- Face indexing ---------- */

// 0-26 suit tiles (bamboo, characters, dots; ranks 1-9), 27-30 winds, 31-33 dragons.
const SUIT_ORDER: readonly SuitName[] = ["bamboo", "characters", "dots"];
const WIND_ORDER: readonly WindName[] = ["east", "south", "west", "north"];
const DRAGON_ORDER: readonly DragonName[] = ["red", "green", "white"];
const WIND_BASE = 27;
const DRAGON_BASE = 31;
const FACE_COUNT = 34;

const isSuitIndex = (i: number) => i < WIND_BASE;

/** Index 0-33 for scoring faces; null for flowers, seasons and custom faces. */
function faceIndex(face: TileFace): number | null {
  switch (face.kind) {
    case "suit":
      return SUIT_ORDER.indexOf(face.suit) * 9 + face.rank - 1;
    case "wind":
      return WIND_BASE + WIND_ORDER.indexOf(face.wind);
    case "dragon":
      return DRAGON_BASE + DRAGON_ORDER.indexOf(face.dragon);
    default:
      return null;
  }
}

function countFaces(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(FACE_COUNT).fill(0);
  for (const tile of tiles) {
    const index = faceIndex(tile.face);
    if (index !== null) counts[index]++;
  }
  return counts;
}

const pick = <T>(items: readonly T[], rng: Rng): T =>
  items[Math.min(items.length - 1, Math.floor(rng() * items.length))];

/* ---------- Shanten (distance from a winning hand) ---------- */

/* ---------- The minimum-fan rule ---------- */

/** What the scoring needs to know to decide whether a finished hand may win. */
export interface WinContext {
  readonly seatWind: WindName;
  readonly prevailingWind: WindName;
  /** Hong Kong Old Style: a hand may only win with at least this many fan. */
  readonly minimumFan: number;
}

/** East seat, east round, 3 fan: what the UI assumes when it passes nothing. */
export const DEFAULT_WIN_CONTEXT: WinContext = {
  seatWind: "east",
  prevailingWind: "east",
  minimumFan: 3,
};

/**
 * Fan the hand would score by winning on `tile`. `hand` is the concealed tiles WITHOUT the
 * tile (13 minus three per meld); 0 when the hand is not actually complete.
 */
export function fanForWin(
  hand: readonly Tile[],
  melds: readonly Meld[],
  tile: Tile,
  context: WinContext = DEFAULT_WIN_CONTEXT,
): number {
  return calculateFan([...hand], [...melds], tile, context.seatWind, context.prevailingWind).totalFan;
}

/** True when winning on `tile` scores at least the minimum, i.e. the win is legal. */
export function meetsMinimumFan(
  hand: readonly Tile[],
  melds: readonly Meld[],
  tile: Tile,
  context: WinContext = DEFAULT_WIN_CONTEXT,
): boolean {
  return fanForWin(hand, melds, tile, context) >= context.minimumFan;
}

/**
 * Should a seat declare a win on the tile it just drew? Yes whenever the tile completes the
 * hand and the hand scores the minimum fan, at every difficulty: a bot never turns down a
 * legal win. `hand` is the concealed tiles without `drawnTile`.
 */
export function shouldDeclareSelfDrawWin(
  hand: readonly Tile[],
  melds: readonly Meld[],
  drawnTile: Tile | null,
  context: WinContext = DEFAULT_WIN_CONTEXT,
): boolean {
  if (drawnTile === null) return false;
  return meetsMinimumFan(hand, melds, drawnTile, context);
}

/**
 * Like `shanten`, but a complete hand that scores under the minimum fan is NOT finished:
 * it cannot legally win, so it counts as 0 (ready) rather than -1. Pass the full hand
 * including the tile that completed it; anything that is not complete is unchanged.
 */
export function effectiveShanten(
  tiles: readonly Tile[],
  melds: readonly Meld[],
  context: WinContext = DEFAULT_WIN_CONTEXT,
): number {
  const base = shanten(tiles, melds.length);
  if (base !== -1 || tiles.length === 0) return base;
  const winningTile = tiles[tiles.length - 1];
  return fanForWin(tiles, melds, winningTile, context) >= context.minimumFan ? -1 : 0;
}

/**
 * How many tiles a hand is away from winning: -1 is a complete hand, 0 is ready (one tile
 * from winning), 1 needs two tiles, and so on. Counts four sets and a pair; `meldCount`
 * is the number of melds already made (kongs count once). Flowers and other bonus faces
 * are ignored. Works for any number of tiles, so it can compare a hand before and after a
 * claim.
 */
export function shanten(tiles: readonly Tile[], meldCount = 0): number {
  const counts = countFaces(tiles);
  let best = 8;

  const go = (from: number, sets: number, partials: number, hasPair: boolean): void => {
    let i = from;
    while (i < FACE_COUNT && counts[i] === 0) i++;

    if (i >= FACE_COUNT) {
      const usedSets = Math.min(sets, 4);
      const usedPartials = Math.max(0, Math.min(partials, 4 - usedSets));
      best = Math.min(best, 8 - 2 * usedSets - usedPartials - (hasPair ? 1 : 0));
      return;
    }

    const rank = i % 9;
    const suited = isSuitIndex(i);

    // Complete sets.
    if (counts[i] >= 3) {
      counts[i] -= 3;
      go(i, sets + 1, partials, hasPair);
      counts[i] += 3;
    }
    if (suited && rank <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
      counts[i]--;
      counts[i + 1]--;
      counts[i + 2]--;
      go(i, sets + 1, partials, hasPair);
      counts[i]++;
      counts[i + 1]++;
      counts[i + 2]++;
    }

    // The pair, or a second pair acting as a partial pung.
    if (counts[i] >= 2) {
      counts[i] -= 2;
      go(i, sets, hasPair ? partials + 1 : partials, true);
      counts[i] += 2;
    }

    // Partial sequences.
    if (suited && rank <= 7 && counts[i + 1] > 0) {
      counts[i]--;
      counts[i + 1]--;
      go(i, sets, partials + 1, hasPair);
      counts[i]++;
      counts[i + 1]++;
    }
    if (suited && rank <= 6 && counts[i + 2] > 0) {
      counts[i]--;
      counts[i + 2]--;
      go(i, sets, partials + 1, hasPair);
      counts[i]++;
      counts[i + 2]++;
    }

    // Leave this tile out of every group.
    counts[i]--;
    go(i, sets, partials, hasPair);
    counts[i]++;
  };

  go(0, meldCount, 0, false);
  return best;
}

/* ---------- Discards ---------- */

/**
 * How much a tile is worth keeping; the lowest-valued tile is discarded.
 *
 *   100  part of a triplet (or a four of a kind)
 *    90  part of a complete sequence
 *    80  matches one of our open pungs (could become an added kong)
 *    60  part of a pair (62 for an honor pair)
 *    45  part of a two-sided sequence draw, 35 for the 1-2 / 8-9 edge draws
 *    30  part of a gap draw such as 4-6
 *    20  isolated middle tile (3-7)
 *    15  isolated 2 or 8
 *    10  isolated terminal (1 or 9)
 *     0  isolated wind or dragon
 *    -1  anything that cannot score (flowers, custom faces)
 */
function keepValue(index: number | null, counts: readonly number[], openPungs: ReadonlySet<number>) {
  if (index === null) return -1;
  const count = counts[index];
  if (count >= 3) return 100;

  const suited = isSuitIndex(index);
  const rank = index % 9;
  const has = (offset: number): boolean => {
    const r = rank + offset;
    return suited && r >= 0 && r <= 8 && counts[index + offset] > 0;
  };

  if (suited && ((has(-2) && has(-1)) || (has(-1) && has(1)) || (has(1) && has(2)))) return 90;
  if (openPungs.has(index)) return 80;
  if (count === 2) return suited ? 60 : 62;

  if (suited) {
    let value = 0;
    // Adjacent tile: 4-5 is open on both sides, 1-2 and 8-9 only on one.
    for (const offset of [-1, 1]) {
      if (!has(offset)) continue;
      const low = offset === 1 ? rank : rank - 1;
      value = Math.max(value, low === 0 || low === 7 ? 35 : 45);
    }
    if (value > 0) return value;
    if (has(-2) || has(2)) return 30;
    if (rank === 0 || rank === 8) return 10;
    if (rank === 1 || rank === 7) return 15;
    return 20;
  }

  return 0;
}

/**
 * Picks the tile to throw away.
 *
 * - `hand`: every tile you hold, including the one just drawn.
 * - `melds`: your open melds (used to keep tiles that could extend an open pung).
 * - easy: a random tile.
 * - medium / hard: discards the least useful tile: isolated winds and dragons first, then
 *   isolated terminals, then isolated middle tiles, keeping pairs, partial sequences and
 *   complete melds. (Hard will add defensive reading later; for now it plays like medium.)
 *
 * Ties go to the later tile in `hand`, so a freshly drawn tile is thrown before an equal one.
 */
export function getBestDiscard(
  hand: readonly Tile[],
  melds: readonly Meld[],
  difficulty: BotDifficulty,
  rng: Rng = Math.random,
): Tile {
  if (hand.length === 0) throw new Error("Cannot discard from an empty hand");
  if (difficulty === "easy") return pick(hand, rng);

  const counts = countFaces(hand);
  const openPungs = new Set<number>();
  for (const meld of melds) {
    if (meld.type !== "pung" || meld.tiles.length === 0) continue;
    const index = faceIndex(meld.tiles[0].face);
    if (index !== null) openPungs.add(index);
  }

  let best = hand[0];
  let bestValue = Infinity;
  for (const tile of hand) {
    const value = keepValue(faceIndex(tile.face), counts, openPungs);
    if (value <= bestValue) {
      best = tile;
      bestValue = value;
    }
  }
  return best;
}

/* ---------- Claims ---------- */

// When two claims are equally good, prefer the one that scores more or draws extra.
const CLAIM_TIE_ORDER: Record<ClaimKind, number> = { win: 0, kong: 1, pung: 2, chow: 3 };

/**
 * Decides what to do with a discard.
 *
 * - `hand`: your concealed tiles (without the discard).
 * - `melds`: your open melds.
 * - `availableClaims`: the claims open to you on this discard.
 * - A win is taken only if it scores at least the minimum fan (3 in Hong Kong Old Style).
 *   A cheaper "win" is ignored and the other claims are judged as usual.
 * - easy: flips a coin between passing and a random claim.
 * - medium / hard: claims only when it moves the hand closer to winning (a lower shanten
 *   after the best follow-up discard), or when a dragon pung/kong keeps the hand level and
 *   guarantees a fan. Otherwise passes. Returns the chosen ClaimOption itself.
 */
export function getBestClaim(
  hand: readonly Tile[],
  melds: readonly Meld[],
  discard: Tile,
  availableClaims: readonly ClaimOption[],
  difficulty: BotDifficulty,
  rng: Rng = Math.random,
  context: WinContext = DEFAULT_WIN_CONTEXT,
): ClaimOption | "pass" {
  const win = availableClaims.find(
    (c) => c.kind === "win" && meetsMinimumFan(hand, melds, discard, context),
  );
  if (win) return win;

  // An illegal (under-minimum) win is not a claim at all.
  const claims = availableClaims.filter((c) => c.kind !== "win");
  if (claims.length === 0) return "pass";

  if (difficulty === "easy") {
    if (rng() >= 0.5) return "pass";
    return pick(claims, rng);
  }

  const current = shanten(hand, melds.length);
  const isDragon = discard.face.kind === "dragon";

  let best: { option: ClaimOption; after: number } | null = null;

  for (const option of claims) {
    const used = new Set(option.usingTiles.map((t) => t.id));
    const remaining = hand.filter((t) => !used.has(t.id));
    const meldCount = melds.length + 1;

    let after: number;
    if (option.kind === "kong") {
      // A kong needs no discard: the replacement draw comes from the dead wall.
      after = shanten(remaining, meldCount);
    } else {
      // A pung or chow must be followed by a discard; assume the best one.
      after = Infinity;
      const tried = new Set<string>();
      for (const tile of remaining) {
        const key = JSON.stringify(tile.face);
        if (tried.has(key)) continue;
        tried.add(key);
        const rest = remaining.filter((t) => t.id !== tile.id);
        after = Math.min(after, shanten(rest, meldCount));
      }
      if (after === Infinity) after = shanten(remaining, meldCount);
    }

    const dragonSet = isDragon && (option.kind === "pung" || option.kind === "kong");
    if (!(after < current || (after === current && dragonSet))) continue;

    if (
      best === null ||
      after < best.after ||
      (after === best.after && CLAIM_TIE_ORDER[option.kind] < CLAIM_TIE_ORDER[best.option.kind])
    ) {
      best = { option, after };
    }
  }

  return best ? best.option : "pass";
}
