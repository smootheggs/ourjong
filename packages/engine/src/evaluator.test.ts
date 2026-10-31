import { beforeEach, describe, expect, it } from "vitest";
import {
  canChow,
  canKong,
  canPong,
  canWin,
  getHiddenKongs,
  getPromotedKongs,
  isWinningHand,
  kongTiles,
  pongTiles,
} from "./evaluator.ts";
import type {
  DragonName,
  Meld,
  SuitName,
  SuitRank,
  Tile,
  TileFace,
  WindName,
} from "./types.ts";

/* ---------- Mock tile factory ---------- */

let nextId = 0;
const copiesByFace = new Map<string, number>();

beforeEach(() => {
  nextId = 0;
  copiesByFace.clear();
});

const faceKey = (face: TileFace): string => JSON.stringify(face);

/** Builds a valid Tile with a unique id and the next free copy index (0-3). */
const t = (face: TileFace): Tile => {
  const key = faceKey(face);
  const copy = copiesByFace.get(key) ?? 0;
  if (copy > 3) throw new Error(`More than 4 copies of ${key} in a test hand`);
  copiesByFace.set(key, copy + 1);
  return { id: nextId++, face, copy };
};

const suit = (s: SuitName, ...ranks: SuitRank[]): Tile[] =>
  ranks.map((rank) => t({ kind: "suit", suit: s, rank }));
const dots = (...ranks: SuitRank[]) => suit("dots", ...ranks);
const bamboo = (...ranks: SuitRank[]) => suit("bamboo", ...ranks);
const chars = (...ranks: SuitRank[]) => suit("characters", ...ranks);

const wind = (name: WindName, n = 1): Tile[] =>
  Array.from({ length: n }, () => t({ kind: "wind", wind: name }));
const dragon = (name: DragonName, n = 1): Tile[] =>
  Array.from({ length: n }, () => t({ kind: "dragon", dragon: name }));

/** Ranks of each combo, e.g. [[4, 6]] — easier to assert than whole tiles. */
const comboRanks = (combos: Tile[][]): number[][] =>
  combos.map((combo) => combo.map((tile) => (tile.face.kind === "suit" ? tile.face.rank : 0)));

/* ---------- Tests ---------- */

describe("isWinningHand", () => {
  it("accepts 4 chows and 1 pair", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(2, 3, 4),
      ...chars(5, 5),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(true);
  });

  it("accepts 4 pungs and 1 pair", () => {
    const hand = [
      ...dots(1, 1, 1),
      ...bamboo(5, 5, 5),
      ...chars(9, 9, 9),
      ...dragon("red", 3),
      ...wind("east", 2),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(true);
  });

  it("accepts a mix of chows, pungs and an honor pair", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...bamboo(7, 8, 9),
      ...chars(5, 5, 5),
      ...wind("west", 3),
      ...dragon("red", 2),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(true);
  });

  it("needs backtracking to find the right pair/meld split", () => {
    const hand = [
      ...dots(2, 2, 2, 2, 3, 3, 4, 4),
      ...bamboo(1, 2, 3),
      ...chars(7, 7, 7),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(true);
  });

  it("rejects 14 tiles with no pair", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...dots(7, 8, 9),
      ...bamboo(1, 2, 3),
      ...bamboo(5),
      ...chars(8),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(false);
  });

  it("rejects a hand with only 13 tiles", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(2, 3, 4),
      ...chars(5),
    ];
    expect(hand).toHaveLength(13);
    expect(isWinningHand(hand)).toBe(false);
  });

  it("rejects a near-miss with a stranded 1-2-4 sequence", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(5, 5),
      ...chars(1, 2, 4),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(false);
  });

  it("never lets honors form chows", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...dots(7, 8, 9),
      ...bamboo(5, 5),
      ...wind("east"),
      ...wind("south"),
      ...wind("west"),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(false);
  });

  it("does not form chows across suits", () => {
    const hand = [
      ...dots(1, 2),
      ...bamboo(3),
      ...dots(4, 5, 6),
      ...dots(7, 8, 9),
      ...chars(5, 5),
      ...bamboo(1, 2, 3),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(false);
  });

  it("rejects hands containing bonus tiles", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(2, 3, 4),
      ...chars(5),
      t({ kind: "flower", number: 1 }),
    ];
    expect(hand).toHaveLength(14);
    expect(isWinningHand(hand)).toBe(false);
  });
});

describe("canPong", () => {
  it("is true with two identical tiles in hand", () => {
    const hand = [...dots(5, 5), ...chars(1)];
    expect(canPong(hand, t({ kind: "suit", suit: "dots", rank: 5 }))).toBe(true);
  });

  it("is false with only one matching tile", () => {
    const hand = [...dots(5), ...chars(5, 5)];
    expect(canPong(hand, t({ kind: "suit", suit: "dots", rank: 5 }))).toBe(false);
  });

  it("does not match the same rank in another suit", () => {
    const hand = [...bamboo(5, 5)];
    expect(canPong(hand, t({ kind: "suit", suit: "dots", rank: 5 }))).toBe(false);
  });

  it("works for winds and dragons", () => {
    const hand = [...wind("east", 2), ...dragon("red", 2)];
    expect(canPong(hand, t({ kind: "wind", wind: "east" }))).toBe(true);
    expect(canPong(hand, t({ kind: "dragon", dragon: "red" }))).toBe(true);
    expect(canPong(hand, t({ kind: "wind", wind: "south" }))).toBe(false);
  });

  it("never pongs a bonus tile", () => {
    const hand = [t({ kind: "flower", number: 1 }), t({ kind: "flower", number: 1 })];
    expect(canPong(hand, t({ kind: "flower", number: 1 }))).toBe(false);
  });

  it("returns exactly the two tiles that would be used", () => {
    const hand = [...dots(5, 5, 5)];
    const used = pongTiles(hand, t({ kind: "suit", suit: "dots", rank: 5 }));
    expect(used).toHaveLength(2);
    expect(used.every((tile) => hand.includes(tile))).toBe(true);
  });
});

describe("canChow", () => {
  it("finds a middle-gap chow (4-_-6 with a 5)", () => {
    const hand = [...dots(4, 6), ...chars(1)];
    const combos = canChow(hand, t({ kind: "suit", suit: "dots", rank: 5 }));
    expect(comboRanks(combos)).toEqual([[4, 6]]);
  });

  it("handles the low edge (discard 1 needs 2-3)", () => {
    const hand = [...dots(2, 3, 9)];
    const combos = canChow(hand, t({ kind: "suit", suit: "dots", rank: 1 }));
    expect(comboRanks(combos)).toEqual([[2, 3]]);
  });

  it("handles the high edge (discard 9 needs 7-8)", () => {
    const hand = [...dots(7, 8, 1)];
    const combos = canChow(hand, t({ kind: "suit", suit: "dots", rank: 9 }));
    expect(comboRanks(combos)).toEqual([[7, 8]]);
  });

  it("returns every valid combination, lowest first", () => {
    const hand = [...dots(3, 4, 6, 7)];
    const combos = canChow(hand, t({ kind: "suit", suit: "dots", rank: 5 }));
    expect(comboRanks(combos)).toEqual([
      [3, 4],
      [4, 6],
      [6, 7],
    ]);
  });

  it("returns the actual hand tiles", () => {
    const hand = [...dots(4, 6)];
    const [combo] = canChow(hand, t({ kind: "suit", suit: "dots", rank: 5 }));
    expect(combo[0]).toBe(hand[0]);
    expect(combo[1]).toBe(hand[1]);
  });

  it("does not chow across suits", () => {
    const hand = [...bamboo(4, 6)];
    expect(canChow(hand, t({ kind: "suit", suit: "dots", rank: 5 }))).toEqual([]);
  });

  it("returns nothing when a tile is missing", () => {
    const hand = [...dots(4, 8)];
    expect(canChow(hand, t({ kind: "suit", suit: "dots", rank: 5 }))).toEqual([]);
  });

  it("never chows honors", () => {
    const hand = [...wind("east", 1), ...wind("west", 1)];
    expect(canChow(hand, t({ kind: "wind", wind: "south" }))).toEqual([]);
  });
});

describe("canWin", () => {
  it("wins on the discard that completes a 13-tile hand", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(2, 3, 4),
      ...chars(5),
    ];
    expect(hand).toHaveLength(13);
    expect(canWin(hand, t({ kind: "suit", suit: "characters", rank: 5 }))).toBe(true);
  });

  it("does not win on a tile that leaves the hand incomplete", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(2, 3, 4),
      ...chars(5),
    ];
    expect(canWin(hand, t({ kind: "suit", suit: "characters", rank: 6 }))).toBe(false);
  });

  it("wins on an edge/middle wait completing a chow", () => {
    const hand = [
      ...dots(1, 2),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(2, 3, 4),
      ...chars(5, 5),
    ];
    expect(canWin(hand, t({ kind: "suit", suit: "dots", rank: 3 }))).toBe(true);
  });

  it("wins by completing an honor pung", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(5, 5),
      ...wind("east", 2),
    ];
    expect(hand).toHaveLength(13);
    expect(canWin(hand, t({ kind: "wind", wind: "east" }))).toBe(true);
  });

  it("works for hands that already have open melds (fewer concealed tiles)", () => {
    const hand = [...dots(1, 2), ...chars(5, 5)];
    expect(canWin(hand, t({ kind: "suit", suit: "dots", rank: 3 }))).toBe(true);
    expect(canWin(hand, t({ kind: "suit", suit: "dots", rank: 4 }))).toBe(false);
  });

  it("does not mutate the hand it is given", () => {
    const hand = [...dots(1, 2), ...chars(5, 5)];
    const before = hand.map((tile) => tile.id);
    canWin(hand, t({ kind: "suit", suit: "dots", rank: 3 }));
    expect(hand.map((tile) => tile.id)).toEqual(before);
  });
});

describe("canKong", () => {
  it("is true with three identical tiles in hand", () => {
    const hand = [...dots(5, 5, 5), ...chars(1)];
    expect(canKong(hand, t({ kind: "suit", suit: "dots", rank: 5 }))).toBe(true);
  });

  it("is false with only two (that is a pung, not a kong)", () => {
    const hand = [...dots(5, 5)];
    expect(canKong(hand, t({ kind: "suit", suit: "dots", rank: 5 }))).toBe(false);
  });

  it("does not match the same rank in another suit", () => {
    const hand = [...bamboo(5, 5, 5)];
    expect(canKong(hand, t({ kind: "suit", suit: "dots", rank: 5 }))).toBe(false);
  });

  it("works for winds and dragons", () => {
    const hand = [...wind("east", 3), ...dragon("red", 3)];
    expect(canKong(hand, t({ kind: "wind", wind: "east" }))).toBe(true);
    expect(canKong(hand, t({ kind: "dragon", dragon: "red" }))).toBe(true);
    expect(canKong(hand, t({ kind: "dragon", dragon: "green" }))).toBe(false);
  });

  it("never kongs a bonus tile", () => {
    const hand = [1, 1, 1].map(() => t({ kind: "flower", number: 1 }));
    expect(canKong(hand, t({ kind: "flower", number: 1 }))).toBe(false);
  });

  it("returns exactly the three tiles that would be used", () => {
    // Three 5-dots in hand + the discard = the fourth (last) copy. Other tiles are different faces.
    const hand = [...dots(5, 5, 5), ...chars(1, 2), ...bamboo(9)];
    const used = kongTiles(hand, t({ kind: "suit", suit: "dots", rank: 5 }));
    expect(used).toHaveLength(3);
    expect(used.every((tile) => hand.includes(tile))).toBe(true);
    expect(used.every((tile) => tile.face.kind === "suit" && tile.face.suit === "dots")).toBe(true);
  });
});

describe("getHiddenKongs", () => {
  it("finds every set of four identical tiles", () => {
    const hand = [...dots(5, 5, 5, 5), ...wind("east", 4), ...chars(1, 2)];
    const kongs = getHiddenKongs(hand);
    expect(kongs).toHaveLength(2);
    expect(kongs.every((group) => group.length === 4)).toBe(true);
    expect(kongs[0].every((tile) => tile.face.kind === "suit")).toBe(true);
    expect(kongs[1].every((tile) => tile.face.kind === "wind")).toBe(true);
  });

  it("ignores triples and mixed suits", () => {
    const hand = [...dots(5, 5, 5), ...bamboo(5), ...chars(5)];
    expect(getHiddenKongs(hand)).toEqual([]);
  });

  it("returns the actual hand tiles", () => {
    const hand = [...bamboo(7, 7, 7, 7)];
    const [group] = getHiddenKongs(hand);
    expect(group.every((tile) => hand.includes(tile))).toBe(true);
  });

  it("returns nothing for an empty hand", () => {
    expect(getHiddenKongs([])).toEqual([]);
  });
});

describe("getPromotedKongs", () => {
  const pung = (tiles: Tile[]): Meld => ({ type: "pung", tiles, isOpen: true, claimedFrom: 2 });

  it("matches an open pung with the fourth tile in hand", () => {
    const meld = pung(bamboo(7, 7, 7));
    const hand = [...bamboo(7), ...chars(1)];
    const options = getPromotedKongs(hand, [meld]);
    expect(options).toHaveLength(1);
    expect(options[0].meld).toBe(meld);
    expect(options[0].tile).toBe(hand[0]);
  });

  it("returns nothing when the fourth tile is missing", () => {
    const meld = pung(bamboo(7, 7, 7));
    expect(getPromotedKongs([...bamboo(8), ...dots(7)], [meld])).toEqual([]);
  });

  it("finds one option per promotable pung", () => {
    const melds = [pung(bamboo(7, 7, 7)), pung(wind("east", 3))];
    const hand = [...bamboo(7), ...wind("east")];
    expect(getPromotedKongs(hand, melds)).toHaveLength(2);
  });

  it("ignores chows, even when the hand holds a tile matching the chow", () => {
    const chow: Meld = { type: "chow", tiles: bamboo(4, 5, 6), isOpen: true };
    // The hand's 4-bamboo matches the chow's first tile, but a chow can never become a kong.
    expect(getPromotedKongs([...bamboo(4), ...chars(1)], [chow])).toEqual([]);
  });

  it("ignores melds that are already kongs", () => {
    // A kong uses all four copies of its face, so the hand cannot hold a matching tile;
    // this checks that an existing kong is simply never offered for promotion.
    const kong: Meld = { type: "kong", tiles: dots(7, 7, 7, 7), isOpen: true };
    expect(getPromotedKongs([...bamboo(7), ...chars(7)], [kong])).toEqual([]);
  });
});
