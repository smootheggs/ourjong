import type { Meld, Tile, TileFace, TileFaceKey } from "./types.ts";

interface Group {
  /** Only numeric suits may form chows. */
  readonly sequenceable: boolean;
  /** Suits: index = rank - 1 (0..8). Honors: a single slot holding the copy count. */
  readonly counts: number[];
}

/** Stable identity of a face, e.g. "suit:bamboo:3" or "wind:east". */
export function faceKeyOf(face: TileFace): TileFaceKey {
  switch (face.kind) {
    case "suit":
      return `suit:${face.suit}:${face.rank}`;
    case "wind":
      return `wind:${face.wind}`;
    case "dragon":
      return `dragon:${face.dragon}`;
    case "flower":
      return `flower:${face.number}`;
    case "season":
      return `season:${face.number}`;
    case "custom":
      return `custom:${face.key}`;
  }
}

/**
 * Groups tiles by suit (numeric suits) or by individual face (winds/dragons).
 * Returns null if the hand contains a tile that cannot be part of a winning
 * hand (bonus tiles, custom faces) or an impossible number of copies.
 */
function groupTiles(tiles: readonly Tile[]): Group[] | null {
  const suits = new Map<string, number[]>();
  const honors = new Map<string, number[]>();

  for (const tile of tiles) {
    const face = tile.face;
    switch (face.kind) {
      case "suit": {
        const counts = suits.get(face.suit) ?? new Array<number>(9).fill(0);
        counts[face.rank - 1]++;
        suits.set(face.suit, counts);
        break;
      }
      case "wind": {
        const key = `wind:${face.wind}`;
        const counts = honors.get(key) ?? [0];
        counts[0]++;
        honors.set(key, counts);
        break;
      }
      case "dragon": {
        const key = `dragon:${face.dragon}`;
        const counts = honors.get(key) ?? [0];
        counts[0]++;
        honors.set(key, counts);
        break;
      }
      default:
        // flower / season / custom tiles never belong in the melded hand
        return null;
    }
  }

  const groups: Group[] = [
    ...[...suits.values()].map((counts) => ({ sequenceable: true, counts })),
    ...[...honors.values()].map((counts) => ({ sequenceable: false, counts })),
  ];

  if (groups.some((g) => g.counts.some((c) => c > 4))) return null;
  return groups;
}

/** Recursive backtracking: can these counts be split entirely into pongs/chows? */
function canFormMelds(counts: number[], sequenceable: boolean): boolean {
  const i = counts.findIndex((n) => n > 0);
  if (i === -1) return true;

  if (counts[i] >= 3) {
    counts[i] -= 3;
    const ok = canFormMelds(counts, sequenceable);
    counts[i] += 3;
    if (ok) return true;
  }

  if (sequenceable && i + 2 < counts.length && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--;
    counts[i + 1]--;
    counts[i + 2]--;
    const ok = canFormMelds(counts, sequenceable);
    counts[i]++;
    counts[i + 1]++;
    counts[i + 2]++;
    if (ok) return true;
  }

  return false;
}

/**
 * Thirteen Orphans: 14 tiles that are all terminals or honors, covering all 13 kinds once
 * with one of them doubled. It has no melds, so it cannot be found by splitting the hand.
 */
function isThirteenOrphans(tiles: readonly Tile[]): boolean {
  if (tiles.length !== 14) return false;
  const kinds = new Set<string>();
  for (const { face } of tiles) {
    const orphan =
      face.kind === "wind" ||
      face.kind === "dragon" ||
      (face.kind === "suit" && (face.rank === 1 || face.rank === 9));
    if (!orphan) return false;
    kinds.add(faceKeyOf(face));
  }
  return kinds.size === 13;
}

/**
 * True if the tiles split into melds (chows/pungs) plus exactly one pair.
 * The count must be 2 mod 3, so hands with open melds (fewer concealed tiles) work too.
 */
function canDecompose(tiles: readonly Tile[]): boolean {
  if (tiles.length < 2 || tiles.length % 3 !== 2) return false;
  if (isThirteenOrphans(tiles)) return true;

  const groups = groupTiles(tiles);
  if (groups === null) return false;

  for (const group of groups) {
    for (let k = 0; k < group.counts.length; k++) {
      if (group.counts[k] < 2) continue;

      group.counts[k] -= 2; // try this as the pair
      const ok = groups.every((g) => canFormMelds(g.counts, g.sequenceable));
      group.counts[k] += 2;

      if (ok) return true;
    }
  }
  return false;
}

/** True if exactly 14 tiles form 4 melds (chow or pung) plus 1 pair, or Thirteen Orphans. */
export function isWinningHand(tiles: readonly Tile[]): boolean {
  return tiles.length === 14 && canDecompose(tiles);
}

/* ---------- Claim evaluation ---------- */

/** The two hand tiles that would pung the discard, or [] if there are none. */
export function pongTiles(hand: readonly Tile[], discard: Tile): Tile[] {
  const kind = discard.face.kind;
  if (kind !== "suit" && kind !== "wind" && kind !== "dragon") return [];

  const key = faceKeyOf(discard.face);
  const matches = hand.filter((t) => faceKeyOf(t.face) === key);
  return matches.length >= 2 ? matches.slice(0, 2) : [];
}

/** True if the hand holds two tiles identical to the discard. */
export function canPong(hand: readonly Tile[], discard: Tile): boolean {
  return pongTiles(hand, discard).length === 2;
}

/**
 * Every pair of hand tiles that forms a sequence with the discard, lowest rank first.
 * Only suit tiles can chow. Whether the claimer may chow from this discarder (HKOS:
 * only the player immediately before you) is a seating rule checked by the engine.
 */
export function canChow(hand: readonly Tile[], discard: Tile): Tile[][] {
  const face = discard.face;
  if (face.kind !== "suit") return [];

  const suit = face.suit;
  const rank: number = face.rank;
  const find = (r: number): Tile | undefined =>
    hand.find((t) => t.face.kind === "suit" && t.face.suit === suit && t.face.rank === r);

  const patterns: ReadonlyArray<readonly [number, number]> = [
    [rank - 2, rank - 1],
    [rank - 1, rank + 1],
    [rank + 1, rank + 2],
  ];

  const combos: Tile[][] = [];
  for (const [low, high] of patterns) {
    if (low < 1 || high > 9) continue;
    const a = find(low);
    const b = find(high);
    if (a && b) combos.push([a, b]);
  }
  return combos;
}

/**
 * True if the concealed hand plus the discard forms a complete hand (melds + one pair).
 * Structure only: the minimum-score requirement is not checked here.
 */
export function canWin(hand: readonly Tile[], discard: Tile): boolean {
  return canDecompose([...hand, discard]);
}

/* ---------- Kongs ---------- */

/** Only suit tiles, winds and dragons can be melded; bonus and custom tiles cannot. */
const isMeldable = (tile: Tile): boolean =>
  tile.face.kind === "suit" || tile.face.kind === "wind" || tile.face.kind === "dragon";

/** The three hand tiles that would form an exposed kong with the discard, or []. */
export function kongTiles(hand: readonly Tile[], discard: Tile): Tile[] {
  if (!isMeldable(discard)) return [];

  const key = faceKeyOf(discard.face);
  const matches = hand.filter((t) => faceKeyOf(t.face) === key);
  return matches.length >= 3 ? matches.slice(0, 3) : [];
}

/** True if the hand holds three tiles identical to another player's discard. */
export function canKong(hand: readonly Tile[], discard: Tile): boolean {
  return kongTiles(hand, discard).length === 3;
}

/**
 * Concealed kongs available on your own turn: every set of four identical tiles.
 * Pass the hand including the drawn tile.
 */
export function getHiddenKongs(hand: readonly Tile[]): Tile[][] {
  const byFace = new Map<TileFaceKey, Tile[]>();
  for (const tile of hand) {
    if (!isMeldable(tile)) continue;
    const key = faceKeyOf(tile.face);
    byFace.set(key, [...(byFace.get(key) ?? []), tile]);
  }
  return [...byFace.values()].filter((group) => group.length >= 4).map((group) => group.slice(0, 4));
}

/** An open pung that can grow into a kong with a matching tile from the hand. */
export interface PromotedKong {
  readonly meld: Meld;
  readonly tile: Tile;
}

/**
 * Added kongs available on your own turn: an open pung plus the fourth identical tile in
 * your hand. Pass the hand including the drawn tile.
 */
export function getPromotedKongs(hand: readonly Tile[], melds: readonly Meld[]): PromotedKong[] {
  const options: PromotedKong[] = [];
  for (const meld of melds) {
    if (meld.type !== "pung" || meld.tiles.length === 0) continue;

    const key = faceKeyOf(meld.tiles[0].face);
    const tile = hand.find((t) => faceKeyOf(t.face) === key);
    if (tile !== undefined) options.push({ meld, tile });
  }
  return options;
}
