import { beforeEach, describe, expect, it } from "vitest";
import {
  effectiveShanten,
  getBestClaim,
  getBestDiscard,
  shanten,
  shouldDeclareSelfDrawWin,
} from "./ai.ts";
import type {
  ClaimOption,
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

const pungMeld = (tiles: Tile[]): Meld => ({ type: "pung", tiles, isOpen: true });

/** An rng that returns the given values in order, then repeats the last one. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

const option = (kind: ClaimOption["kind"], ...usingTiles: Tile[]): ClaimOption => ({
  seat: 0,
  kind,
  usingTiles,
});

const isHonor = (tile: Tile) => tile.face.kind === "wind" || tile.face.kind === "dragon";

/* ---------- shanten ---------- */

describe("shanten", () => {
  it("is -1 for a complete hand", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...bamboo(4, 5, 6),
      ...chars(7, 8, 9),
      ...wind("east", 3),
      ...dragon("red", 2),
    ];
    expect(shanten(hand)).toBe(-1);
  });

  it("is 0 for a hand one tile from winning", () => {
    const hand = [
      ...dots(1, 2, 3),
      ...bamboo(4, 5, 6),
      ...chars(7, 8, 9),
      ...wind("east", 3),
      ...dragon("red", 1),
    ];
    expect(shanten(hand)).toBe(0);
  });

  it("counts open melds as sets", () => {
    // 11 concealed tiles + one open meld = a complete hand once the pair is present.
    const hand = [...dots(1, 2, 3), ...bamboo(4, 5, 6), ...chars(7, 8, 9), ...dragon("red", 2)];
    expect(shanten(hand, 1)).toBe(-1);
  });

  it("gets worse as tiles stop connecting", () => {
    const connected = [...dots(1, 2, 3), ...bamboo(4, 5, 6), ...chars(2, 3), ...wind("east", 2)];
    const scattered = [...dots(1, 4, 7), ...bamboo(2, 5, 8), ...chars(3, 6, 9), ...wind("east", 1)];
    expect(shanten(connected)).toBeLessThan(shanten(scattered));
  });

  it("ignores flowers", () => {
    const hand = [...dots(1, 2, 3), t({ kind: "flower", number: 1 })];
    expect(shanten(hand)).toBe(shanten(dots(1, 2, 3)));
  });
});

/* ---------- getBestDiscard ---------- */

describe("getBestDiscard", () => {
  it("throws on an empty hand", () => {
    expect(() => getBestDiscard([], [], "medium")).toThrow();
  });

  describe("easy", () => {
    it("picks a random tile from the hand", () => {
      const hand = [...dots(1, 2, 3, 4, 5)];
      expect(getBestDiscard(hand, [], "easy", () => 0)).toBe(hand[0]);
      expect(getBestDiscard(hand, [], "easy", () => 0.5)).toBe(hand[2]);
      expect(getBestDiscard(hand, [], "easy", () => 0.999)).toBe(hand[4]);
    });

    it("never returns a tile outside the hand", () => {
      const hand = [...dots(1, 2, 3), ...wind("east", 2)];
      for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.9999]) {
        expect(hand).toContain(getBestDiscard(hand, [], "easy", () => r));
      }
    });
  });

  describe.each(["medium", "hard"] as const)("%s", (difficulty) => {
    it("discards an isolated wind or dragon before anything else", () => {
      const hand = [
        ...dots(1, 2, 3),
        ...bamboo(4, 5, 6),
        ...bamboo(7, 8, 9),
        ...chars(7, 7),
        ...wind("east"),
        ...dragon("red"),
        ...chars(1),
      ];
      const discard = getBestDiscard(hand, [], difficulty);
      expect(isHonor(discard)).toBe(true);
    });

    it("discards an isolated terminal before an isolated middle tile", () => {
      const hand = [
        ...dots(1, 2, 3),
        ...bamboo(4, 5, 6),
        ...bamboo(7, 8, 9),
        ...chars(8, 8, 8),
        ...chars(1),
        ...chars(4),
      ];
      const discard = getBestDiscard(hand, [], difficulty);
      expect(discard.face).toEqual({ kind: "suit", suit: "characters", rank: 1 });
    });

    it("keeps pairs, partial sequences and complete melds over isolated honors", () => {
      const keepers = [
        ...dots(2, 3), // partial sequence
        ...bamboo(4, 5, 6, 7, 8, 9), // complete sequences
        ...chars(8, 8), // pair
        ...chars(4), // isolated middle tile
      ];
      const honors = [...wind("east"), ...dragon("red"), ...wind("north")];
      const discard = getBestDiscard([...keepers, ...honors], [], difficulty);
      expect(honors).toContain(discard);
    });

    it("keeps a tile that matches an open pung", () => {
      const eastPung = pungMeld(wind("east", 3));
      const east = wind("east");
      const north = wind("north");
      const red = dragon("red");
      const hand = [
        ...dots(1, 2, 3),
        ...bamboo(4, 5, 6),
        ...chars(8, 8),
        ...east,
        ...north,
        ...red,
      ];
      const discard = getBestDiscard(hand, [eastPung], difficulty);
      expect(discard).not.toBe(east[0]);
      expect(isHonor(discard)).toBe(true);
    });

    it("discards a flower or other unscoring tile first", () => {
      const flower = t({ kind: "flower", number: 2 });
      const hand = [...dots(1, 2, 3), ...bamboo(4, 5, 6), ...wind("east"), flower];
      expect(getBestDiscard(hand, [], difficulty)).toBe(flower);
    });

    it("throws away the later of two equal tiles", () => {
      const [first, second] = wind("east", 1).concat(wind("south", 1));
      const hand = [...dots(1, 2, 3), first, second];
      expect(getBestDiscard(hand, [], difficulty)).toBe(second);
    });
  });

  it("hard plays the same discard as medium for now", () => {
    const hand = [
      ...dots(2, 3),
      ...bamboo(4, 5, 6, 7, 8, 9),
      ...chars(8, 8),
      ...chars(4),
      ...wind("east"),
      ...dragon("red"),
    ];
    expect(getBestDiscard(hand, [], "hard")).toBe(getBestDiscard(hand, [], "medium"));
  });
});

/* ---------- getBestClaim ---------- */

describe("getBestClaim", () => {
  /** Two sets, two pairs and three loose honors: two tiles from tenpai. */
  const twoPairHand = () => [
    ...dots(1, 2, 3),
    ...bamboo(4, 5, 6),
    ...chars(7, 7),
    ...chars(2, 2),
    ...wind("north"),
    ...wind("east"),
    ...dragon("green"),
  ];

  /** Ready hand: three sets, a pair of `pairTile`, and a bamboo 2-3 draw. */
  const readyHand = (pairTile: () => Tile[]) => [
    ...dots(1, 2, 3),
    ...bamboo(4, 5, 6),
    ...chars(7, 8, 9),
    ...pairTile(),
    ...bamboo(2, 3),
  ];

  describe.each(["easy", "medium", "hard"] as const)("%s", (difficulty) => {
    it("takes a win that scores the 3 fan minimum", () => {
      // Three dragon pungs (3 fan), a dots chow and a single wait on bamboo 5.
      const hand = [...dragon("red", 3), ...dragon("green", 3), ...dragon("white", 3), ...dots(1, 2, 3), ...bamboo(5)];
      const discard = bamboo(5)[0];
      const win = option("win");
      const claims = [option("pung", hand[0], hand[1]), win];
      // An rng that would make easy pass if it were consulted.
      expect(getBestClaim(hand, [], discard, claims, difficulty, () => 0.99)).toBe(win);
    });

    it("refuses a win under the 3 fan minimum", () => {
      // Complete on bamboo 5 with all chows: legal shape, but under 3 fan.
      const hand = [...dots(1, 2, 3), ...dots(4, 5, 6), ...chars(7, 8, 9), ...chars(2, 3, 4), ...bamboo(5)];
      const discard = bamboo(5)[0];
      expect(getBestClaim(hand, [], discard, [option("win")], difficulty, () => 0.99)).toBe("pass");
    });

    it("passes when there is nothing to claim", () => {
      expect(getBestClaim(twoPairHand(), [], chars(5)[0], [], difficulty, () => 0)).toBe("pass");
    });
  });

  describe("easy", () => {
    it("passes when the coin says pass", () => {
      const hand = twoPairHand();
      const discard = chars(7)[0];
      const pung = option("pung", hand[6], hand[7]);
      expect(getBestClaim(hand, [], discard, [pung], "easy", sequence(0.9))).toBe("pass");
    });

    it("claims a random option when the coin says claim", () => {
      const hand = twoPairHand();
      const discard = chars(7)[0];
      const pung = option("pung", hand[6], hand[7]);
      const chow = option("chow", hand[0], hand[1]);
      expect(getBestClaim(hand, [], discard, [pung, chow], "easy", sequence(0.1, 0))).toBe(pung);
      expect(getBestClaim(hand, [], discard, [pung, chow], "easy", sequence(0.1, 0.99))).toBe(chow);
    });
  });

  describe.each(["medium", "hard"] as const)("%s", (difficulty) => {
    it("claims a pung that brings the hand closer to winning", () => {
      const hand = twoPairHand();
      const discard = chars(7)[0];
      const pung = option("pung", hand[6], hand[7]);
      expect(shanten(hand)).toBe(2);
      expect(getBestClaim(hand, [], discard, [pung], difficulty)).toBe(pung);
    });

    it("passes on a pung that does not improve the hand", () => {
      // Ready hand waiting on a pair of east: punging east wrecks the pair and the wait.
      const hand = readyHand(() => wind("east", 2));
      const discard = wind("east")[0];
      const pung = option("pung", hand[9], hand[10]);
      expect(shanten(hand)).toBe(0);
      expect(getBestClaim(hand, [], discard, [pung], difficulty)).toBe("pass");
    });

    it("still claims a dragon pung that keeps the hand level", () => {
      const hand = readyHand(() => dragon("red", 2));
      const discard = dragon("red")[0];
      const pung = option("pung", hand[9], hand[10]);
      expect(getBestClaim(hand, [], discard, [pung], difficulty)).toBe(pung);
    });

    it("passes on a chow that leaves the hand no closer", () => {
      // Two loose tiles next to the discard, with nothing else to build around them.
      const hand = [
        ...dots(1, 2, 3),
        ...bamboo(4, 5, 6),
        ...chars(7, 7),
        ...chars(2, 2),
        ...wind("north"),
        ...wind("east"),
        ...wind("south"),
      ];
      const discard = bamboo(9)[0];
      const chow = option("chow", hand[0], hand[1]); // not tiles that combine with a 9
      expect(getBestClaim(hand, [], discard, [chow], difficulty)).toBe("pass");
    });

    it("prefers the claim that leaves the hand closest to winning", () => {
      // Pung of 7s or chow of 7-8-9: the pung keeps the hand two pairs from a set.
      const hand = [
        ...dots(1, 2, 3),
        ...bamboo(4, 5, 6),
        ...chars(7, 7),
        ...chars(8, 9),
        ...wind("north"),
        ...wind("east"),
        ...dragon("green"),
      ];
      const discard = chars(7)[0];
      const pung = option("pung", hand[6], hand[7]);
      const chow = option("chow", hand[8], hand[9]);
      const result = getBestClaim(hand, [], discard, [pung, chow], difficulty);
      expect(result).not.toBe("pass");
      if (result !== "pass") {
        const used = new Set(result.usingTiles.map((tile) => tile.id));
        const remaining = hand.filter((tile) => !used.has(tile.id));
        const rest = Math.min(
          ...remaining.map((tile) =>
            shanten(
              remaining.filter((x) => x.id !== tile.id),
              1,
            ),
          ),
        );
        const otherOption = result === pung ? chow : pung;
        const otherUsed = new Set(otherOption.usingTiles.map((tile) => tile.id));
        const otherRemaining = hand.filter((tile) => !otherUsed.has(tile.id));
        const otherRest = Math.min(
          ...otherRemaining.map((tile) =>
            shanten(
              otherRemaining.filter((x) => x.id !== tile.id),
              1,
            ),
          ),
        );
        expect(rest).toBeLessThanOrEqual(otherRest);
      }
    });
  });
});

describe("effectiveShanten: the 3 fan minimum", () => {
  it("counts a complete hand worth 3+ fan as finished (-1)", () => {
    const hand = [...dragon("red", 3), ...dragon("green", 3), ...dragon("white", 3), ...dots(1, 2, 3), ...bamboo(5, 5)];
    expect(shanten(hand)).toBe(-1);
    expect(effectiveShanten(hand, [])).toBe(-1);
  });

  it("counts a complete hand under 3 fan as still 0 (it cannot win)", () => {
    const hand = [...dots(1, 2, 3), ...dots(4, 5, 6), ...chars(7, 8, 9), ...chars(2, 3, 4), ...bamboo(5, 5)];
    expect(shanten(hand)).toBe(-1);
    expect(effectiveShanten(hand, [])).toBe(0);
  });

  it("leaves incomplete hands alone", () => {
    const hand = [...dots(1, 2, 3), ...bamboo(4, 5, 6), ...chars(7, 8, 9), ...bamboo(2, 3), ...wind("east", 2)];
    expect(effectiveShanten(hand, [])).toBe(shanten(hand));
  });
});

describe("shouldDeclareSelfDrawWin", () => {
  it("declares a win on a drawn tile that completes a 3+ fan hand", () => {
    const hand = [...dragon("red", 3), ...dragon("green", 3), ...dragon("white", 3), ...dots(1, 2, 3), ...bamboo(5)];
    const drawn = bamboo(5)[0];
    expect(shouldDeclareSelfDrawWin(hand, [], drawn)).toBe(true);
  });

  it("does not declare a complete hand that is under the 3 fan minimum", () => {
    const hand = [...dots(1, 2, 3), ...dots(4, 5, 6), ...chars(7, 8, 9), ...chars(2, 3, 4), ...bamboo(5)];
    expect(shouldDeclareSelfDrawWin(hand, [], bamboo(5)[0])).toBe(false);
  });

  it("does not declare when the draw does not complete the hand, or nothing was drawn", () => {
    const hand = [...dots(1, 2, 3), ...bamboo(4, 5, 6), ...chars(7, 8, 9), ...wind("east", 2), ...bamboo(2, 3)];
    expect(shouldDeclareSelfDrawWin(hand, [], chars(1)[0])).toBe(false);
    expect(shouldDeclareSelfDrawWin(hand, [], null)).toBe(false);
  });
});
