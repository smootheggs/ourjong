import { beforeEach, describe, expect, it } from "vitest";
import {
  basePoints,
  calculateFan,
  fanToPoints,
  isLimitFan,
  LIMIT_FAN,
  PATTERN_FAN,
  patternLabels,
  PAYOUT_FAN_CAP,
  settleWin,
} from "./scoring.ts";
import { canWin, isWinningHand } from "./evaluator.ts";
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

/** Builds a valid Tile with a unique id and the next free copy index (0-3). */
const t = (face: TileFace): Tile => {
  const key = JSON.stringify(face);
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
const wind = (name: WindName, n: number): Tile[] =>
  Array.from({ length: n }, () => t({ kind: "wind", wind: name }));
const dragon = (name: DragonName, n: number): Tile[] =>
  Array.from({ length: n }, () => t({ kind: "dragon", dragon: name }));

/**
 * Scores a complete 14-tile hand with no open melds; the last tile is the winning tile.
 * Seat and prevalent winds default to ones none of the test hands use.
 */
const fan = (all: Tile[], seat: WindName = "north", prevalent: WindName = "north") =>
  calculateFan(all.slice(0, -1), [], all[all.length - 1], seat, prevalent);

const sorted = (patterns: string[]) => [...patterns].sort();

/** Three chows in three different suits plus a characters pair: scores nothing by itself. */
const plain = (): Tile[] => [
  ...dots(1, 2, 3),
  ...chars(4, 5, 6),
  ...bamboo(7, 8, 9),
  ...chars(2, 2),
];

/* ---------- Hand shapes ---------- */

describe("Common Hand (Ping Hu)", () => {
  it("scores 1 fan for 4 chows and a plain pair", () => {
    const result = fan([...plain(), ...dots(4, 5, 6)]);
    expect(result).toEqual({ totalFan: 1, patterns: ["Common Hand"] });
  });

  it("does not apply when the pair is an honor", () => {
    const result = fan([...dots(1, 2, 3), ...chars(4, 5, 6), ...bamboo(7, 8, 9), ...dots(4, 5, 6), ...dragon("red", 2)]);
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });

  it("does not apply when the hand contains a pung", () => {
    const result = fan([...dots(1, 1, 1), ...chars(4, 5, 6), ...bamboo(7, 8, 9), ...dots(4, 5, 6), ...chars(2, 2)]);
    expect(result.patterns).not.toContain("Common Hand");
  });
});

describe("All in Triplets (Dui Dui Hu)", () => {
  it("scores 3 fan for 4 pungs and a pair", () => {
    const result = fan([
      ...dots(1, 1, 1),
      ...bamboo(5, 5, 5),
      ...chars(9, 9, 9),
      ...dots(7, 7, 7),
      ...bamboo(2, 2),
    ]);
    expect(result).toEqual({ totalFan: 3, patterns: ["All in Triplets"] });
  });

  it("counts an open kong as a pung", () => {
    const kong: Meld = { type: "kong", tiles: wind("east", 4), isOpen: true };
    const hand = [...chars(3, 3, 3), ...bamboo(5, 5, 5), ...dots(8, 8, 8), ...chars(9)];
    const result = calculateFan(hand, [kong], chars(9)[0], "east", "south");
    expect(result.totalFan).toBe(4); // All in Triplets 3 + Seat Wind 1
    expect(sorted(result.patterns)).toEqual(["All in Triplets", "Seat Wind"]);
  });

  it("is not awarded when any group is a chow", () => {
    const result = fan([
      ...dots(1, 1, 1),
      ...bamboo(5, 5, 5),
      ...chars(7, 8, 9),
      ...dots(7, 7, 7),
      ...bamboo(2, 2),
    ]);
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });
});

/* ---------- Suit makeup ---------- */

describe("Mixed One Suit (Hun Yi Se)", () => {
  it("scores 3 fan for one suit plus honors", () => {
    const result = fan([
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...dots(7, 8, 9),
      ...wind("south", 3),
      ...dots(5, 5),
    ], "east", "east");
    expect(result).toEqual({ totalFan: 3, patterns: ["Mixed One Suit"] });
  });

  it("counts an honor pair as the honors", () => {
    const result = fan([
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...dots(7, 8, 9),
      ...dots(2, 3, 4),
      ...wind("south", 2),
    ]);
    // Honor pair: no Common Hand, just the suit pattern.
    expect(result).toEqual({ totalFan: 3, patterns: ["Mixed One Suit"] });
  });

  it("is not awarded across two suits", () => {
    const result = fan([
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...wind("south", 3),
      ...dots(5, 5),
    ]);
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });
});

describe("All One Suit (Qing Yi Se)", () => {
  it("scores 7 fan for a single suit, plus 1 for a common hand", () => {
    const result = fan([
      ...bamboo(1, 2, 3),
      ...bamboo(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...bamboo(2, 3, 4),
      ...bamboo(5, 5),
    ]);
    expect(result.totalFan).toBe(8);
    expect(sorted(result.patterns)).toEqual(["All One Suit", "Common Hand"]);
  });

  it("stacks with All in Triplets", () => {
    const result = fan([
      ...bamboo(1, 1, 1),
      ...bamboo(3, 3, 3),
      ...bamboo(5, 5, 5),
      ...bamboo(7, 7, 7),
      ...bamboo(9, 9),
    ]);
    expect(result.totalFan).toBe(10);
    expect(sorted(result.patterns)).toEqual(["All One Suit", "All in Triplets"]);
  });

  it("is not Mixed One Suit when there are no honors", () => {
    const result = fan([
      ...bamboo(1, 2, 3),
      ...bamboo(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...bamboo(2, 3, 4),
      ...bamboo(5, 5),
    ]);
    expect(result.patterns).not.toContain("Mixed One Suit");
  });
});

describe("All Honors (Zi Yi Se)", () => {
  const allHonors = (): Tile[] => [
    ...wind("east", 3),
    ...wind("south", 3),
    ...wind("west", 3),
    ...dragon("white", 3),
    ...dragon("red", 2),
  ];

  it("is a limit hand worth 10 fan", () => {
    const result = fan(allHonors());
    expect(result).toEqual({ totalFan: 10, patterns: ["All Honors"] });
    expect(PATTERN_FAN["All Honors"]).toBe(10);
  });

  it("stands alone: the pungs and winds inside it are not counted again", () => {
    // Seat wind east and prevalent wind south would be 2 more fan, All in Triplets 3 more, and
    // the white dragon 1 more, if a limit hand stacked.
    const result = fan(allHonors(), "east", "south");
    expect(result).toEqual({ totalFan: 10, patterns: ["All Honors"] });
  });

  it("applies to open melds and kongs too", () => {
    const melds: Meld[] = [
      { type: "pung", tiles: wind("east", 3), isOpen: true },
      { type: "kong", tiles: dragon("green", 4), isOpen: true },
    ];
    const hand = [...wind("west", 3), ...wind("north", 3), ...dragon("red", 1)];
    const result = calculateFan(hand, melds, dragon("red", 1)[0], "east", "east");
    expect(result).toEqual({ totalFan: 10, patterns: ["All Honors"] });
  });

  it("does not apply once a single suit tile is in the hand", () => {
    const result = fan([
      ...wind("east", 3),
      ...wind("south", 3),
      ...wind("west", 3),
      ...dragon("white", 3),
      ...dots(5, 5),
    ]);
    expect(result.patterns).not.toContain("All Honors");
    expect(result.patterns).toContain("Mixed One Suit");
  });
});

describe("Small Three Dragons (Siu Sam Yuen)", () => {
  const hand = (): Tile[] => [
    ...dragon("red", 3),
    ...dragon("green", 3),
    ...dragon("white", 2),
    ...dots(1, 2, 3),
    ...chars(4, 5, 6),
  ];

  it("is worth 5 fan with the two dragon pungs: 3 for the set, 1 for each pung", () => {
    const result = fan(hand());
    expect(result.totalFan).toBe(5);
    expect(sorted(result.patterns)).toEqual(["Green Dragon", "Red Dragon", "Small Three Dragons"]);
    expect(PATTERN_FAN["Small Three Dragons"]).toBe(3);
  });

  it("counts a dragon kong as the pung", () => {
    const melds: Meld[] = [{ type: "kong", tiles: dragon("red", 4), isOpen: true }];
    const rest = [...dragon("green", 3), ...dragon("white", 2), ...dots(1, 2, 3), ...chars(4, 5)];
    const result = calculateFan(rest, melds, chars(6)[0], "east", "south");
    expect(result.totalFan).toBe(5);
    expect(result.patterns).toContain("Small Three Dragons");
  });

  it("stacks with the rest of the hand", () => {
    // Plus All in Triplets (3) and a dots-only hand (Mixed One Suit, 3) = 5 + 3 + 3.
    const result = fan([
      ...dragon("red", 3),
      ...dragon("green", 3),
      ...dragon("white", 2),
      ...dots(2, 2, 2),
      ...dots(8, 8, 8),
    ]);
    expect(result.totalFan).toBe(11);
    expect(result.patterns).toEqual(
      expect.arrayContaining(["Small Three Dragons", "All in Triplets", "Mixed One Suit"]),
    );
  });

  it("needs the pair to be the third dragon", () => {
    const result = fan([
      ...dragon("red", 3),
      ...dragon("green", 3),
      ...dots(1, 2, 3),
      ...chars(4, 5, 6),
      ...dots(9, 9),
    ]);
    expect(result.patterns).not.toContain("Small Three Dragons");
    expect(result.totalFan).toBe(2);
  });

  it("is not awarded for only one dragon pung, or for a pung of the third dragon (that is bigger)", () => {
    const one = fan([
      ...dragon("red", 3),
      ...dragon("green", 2),
      ...dots(1, 2, 3),
      ...chars(4, 5, 6),
      ...bamboo(7, 8, 9),
    ]);
    expect(one.patterns).not.toContain("Small Three Dragons");
  });
});

describe("Small Four Winds (Siu Sei Hei)", () => {
  const hand = (): Tile[] => [
    ...wind("east", 3),
    ...wind("south", 3),
    ...wind("west", 3),
    ...wind("north", 2),
    ...dots(1, 2, 3),
  ];

  it("is worth 6 fan for three wind pungs and a pair of the fourth wind", () => {
    expect(PATTERN_FAN["Small Four Winds"]).toBe(6);
    const result = fan(hand(), "north", "north");
    expect(result.patterns).toContain("Small Four Winds");
    // The fourth set is a suit set (or the hand would be All Honors), so it is always also a
    // Mixed One Suit hand: 6 + 3. The seat and prevalent winds here match none of the pungs.
    expect(sorted(result.patterns)).toEqual(["Mixed One Suit", "Small Four Winds"]);
    expect(result.totalFan).toBe(9);
  });

  it("stacks with the seat wind and the prevalent wind", () => {
    const result = fan(hand(), "east", "south");
    expect(result.totalFan).toBe(11);
    expect(sorted(result.patterns)).toEqual([
      "Mixed One Suit",
      "Prevalent Wind",
      "Seat Wind",
      "Small Four Winds",
    ]);
  });

  it("is capped at 13 fan when everything stacks", () => {
    // Small Four Winds 6 + All in Triplets 3 + Mixed One Suit 3 + Seat 1 + Prevalent 1 = 14.
    const result = fan(
      [
        ...wind("east", 3),
        ...wind("south", 3),
        ...wind("west", 3),
        ...wind("north", 2),
        ...dots(7, 7, 7),
      ],
      "east",
      "south",
    );
    expect(result.totalFan).toBe(LIMIT_FAN);
    expect(result.patterns).toContain("Small Four Winds");
  });

  it("needs the pair to be the fourth wind", () => {
    const result = fan([
      ...wind("east", 3),
      ...wind("south", 3),
      ...wind("west", 3),
      ...dragon("red", 2),
      ...dots(1, 2, 3),
    ]);
    expect(result.patterns).not.toContain("Small Four Winds");
  });

  it("is All Honors, not Small Four Winds, when the last set is also honors", () => {
    const result = fan([
      ...wind("east", 3),
      ...wind("south", 3),
      ...wind("west", 3),
      ...wind("north", 2),
      ...dragon("red", 3),
    ]);
    expect(result).toEqual({ totalFan: 10, patterns: ["All Honors"] });
  });
});

describe("Thirteen Orphans (Sap Saam Yiu)", () => {
  /** One of each terminal and honor. The caller adds the doubled tile. */
  const orphans = (): Tile[] => [
    ...dots(1, 9),
    ...bamboo(1, 9),
    ...chars(1, 9),
    ...wind("east", 1),
    ...wind("south", 1),
    ...wind("west", 1),
    ...wind("north", 1),
    ...dragon("red", 1),
    ...dragon("green", 1),
    ...dragon("white", 1),
  ];

  it("is a limit hand worth 13 fan", () => {
    const result = fan([...orphans(), ...dots(1)]);
    expect(result).toEqual({ totalFan: 13, patterns: ["Thirteen Orphans"] });
    expect(PATTERN_FAN["Thirteen Orphans"]).toBe(LIMIT_FAN);
  });

  const doubles: Array<[string, () => Tile[]]> = [
    ["a nine", () => chars(9)],
    ["a one", () => bamboo(1)],
    ["a wind", () => wind("north", 1)],
    ["the white dragon", () => dragon("white", 1)],
    ["the red dragon", () => dragon("red", 1)],
  ];
  for (const [name, double] of doubles) {
    it(`works when ${name} is the doubled tile`, () => {
      expect(fan([...orphans(), ...double()]).patterns).toEqual(["Thirteen Orphans"]);
    });
  }

  it("scores on its own, whatever the seat and round winds", () => {
    expect(fan([...orphans(), ...wind("east", 1)], "east", "east")).toEqual({
      totalFan: 13,
      patterns: ["Thirteen Orphans"],
    });
  });

  it("scores the same with the winning tile passed separately", () => {
    const all = [...orphans(), ...dragon("red", 1)];
    const result = calculateFan(all.slice(0, 13), [], all[13], "east", "south");
    expect(result.patterns).toEqual(["Thirteen Orphans"]);
  });

  it("is not awarded with an ordinary tile in place of an orphan", () => {
    const missing = orphans().filter((tile) => !(tile.face.kind === "suit" && tile.face.suit === "dots" && tile.face.rank === 9));
    const result = fan([...missing, ...dots(5), ...dots(1)]);
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });

  it("is not awarded when one orphan is missing and another is tripled", () => {
    const missing = orphans().filter((tile) => !(tile.face.kind === "dragon" && tile.face.dragon === "white"));
    const result = fan([...missing, ...dots(1), ...dots(1)]);
    expect(result.patterns).not.toContain("Thirteen Orphans");
  });

  it("is not available with an open meld", () => {
    const pung: Meld = { type: "pung", tiles: dots(1, 1, 1), isOpen: true };
    const hand = [...orphans().slice(1, 11)];
    const result = calculateFan(hand, [pung], dragon("red", 1)[0], "east", "east");
    expect(result.patterns).not.toContain("Thirteen Orphans");
  });
});

describe("Thirteen Orphans in play", () => {
  it("counts as a complete hand for the evaluator", () => {
    const hand = [
      ...dots(1, 9), ...bamboo(1, 9), ...chars(1, 9),
      ...wind("east", 1), ...wind("south", 1), ...wind("west", 1), ...wind("north", 1),
      ...dragon("red", 1), ...dragon("green", 1), ...dragon("white", 1),
    ];
    expect(canWin(hand.slice(0, 13), dots(1)[0])).toBe(true);
    expect(isWinningHand([...hand, ...chars(9)])).toBe(true);
    // 13 different orphans and no pair is only waiting.
    expect(isWinningHand([...hand, ...dots(2)])).toBe(false);
  });
});

/* ---------- Honor bonuses ---------- */

describe("honor bonuses", () => {
  it("scores 1 fan per dragon pung", () => {
    const result = fan([
      ...dragon("red", 3),
      ...dragon("green", 3),
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(5, 5),
    ]);
    expect(result.totalFan).toBe(2);
    expect(sorted(result.patterns)).toEqual(["Green Dragon", "Red Dragon"]);
  });

  it("scores a dragon kong the same as a pung", () => {
    const kong: Meld = { type: "kong", tiles: dragon("white", 4), isOpen: false };
    const hand = [...dots(1, 2, 3), ...chars(4, 5, 6), ...bamboo(7, 8, 9), ...chars(2)];
    const result = calculateFan(hand, [kong], chars(2)[0], "east", "south");
    expect(result).toEqual({ totalFan: 1, patterns: ["White Dragon"] });
  });

  it("scores the seat wind", () => {
    const result = fan([...wind("east", 3), ...plain()], "east", "south");
    expect(result).toEqual({ totalFan: 1, patterns: ["Seat Wind"] });
  });

  it("scores the prevalent wind", () => {
    const result = fan([...wind("south", 3), ...plain()], "east", "south");
    expect(result).toEqual({ totalFan: 1, patterns: ["Prevalent Wind"] });
  });

  it("scores both when the seat and prevalent wind are the same wind", () => {
    const result = fan([...wind("east", 3), ...plain()], "east", "east");
    expect(result.totalFan).toBe(2);
    expect(sorted(result.patterns)).toEqual(["Prevalent Wind", "Seat Wind"]);
  });

  it("scores nothing for a wind that is neither the seat nor the prevalent wind", () => {
    const result = fan([...wind("west", 3), ...plain()], "east", "south");
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });

  it("scores seat and prevalent winds from two different pungs", () => {
    const result = fan(
      [...wind("east", 3), ...wind("south", 3), ...dots(1, 2, 3), ...chars(4, 5, 6), ...bamboo(7, 7)],
      "east",
      "south",
    );
    expect(result.totalFan).toBe(2);
    expect(sorted(result.patterns)).toEqual(["Prevalent Wind", "Seat Wind"]);
  });

  it("scores nothing for a pair of dragons or winds", () => {
    const result = fan([
      ...dots(1, 2, 3),
      ...chars(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...dots(4, 5, 6),
      ...dragon("red", 2),
    ], "east", "east");
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });
});

/* ---------- Combinations ---------- */

describe("combinations", () => {
  it("Mixed One Suit + Red Dragon = 4 fan", () => {
    const result = fan([
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...dots(7, 8, 9),
      ...dragon("red", 3),
      ...dots(5, 5),
    ]);
    expect(result.totalFan).toBe(4);
    expect(sorted(result.patterns)).toEqual(["Mixed One Suit", "Red Dragon"]);
  });

  it("stacks triplets, mixed suit and a seat wind", () => {
    // dots 111 222 333 + east pung + dots 99: read as four pungs (not three chows).
    const result = fan(
      [...dots(1, 1, 1, 2, 2, 2, 3, 3, 3), ...wind("east", 3), ...dots(9, 9)],
      "east",
      "south",
    );
    expect(result.totalFan).toBe(7); // All in Triplets 3 + Mixed One Suit 3 + Seat Wind 1
    expect(sorted(result.patterns)).toEqual(["All in Triplets", "Mixed One Suit", "Seat Wind"]);
  });

  it("picks the highest-scoring reading of an ambiguous hand", () => {
    // dots 111 222 333 456 99: three pungs + a chow (7) or four chows (7 + 1 = 8).
    const result = fan([...dots(1, 1, 1, 2, 2, 2, 3, 3, 3), ...dots(4, 5, 6), ...dots(9, 9)]);
    expect(result.totalFan).toBe(8);
    expect(sorted(result.patterns)).toEqual(["All One Suit", "Common Hand"]);
  });

  it("counts open melds toward the pattern", () => {
    const pung: Meld = { type: "pung", tiles: dragon("red", 3), isOpen: true };
    const hand = [...dots(1, 2, 3, 4, 5, 6, 7, 8, 9), ...dots(5)];
    const result = calculateFan(hand, [pung], dots(5)[0], "east", "south");
    expect(result.totalFan).toBe(4);
    expect(sorted(result.patterns)).toEqual(["Mixed One Suit", "Red Dragon"]);
  });

  it("scores an open chow as a chow", () => {
    const chow: Meld = { type: "chow", tiles: bamboo(1, 2, 3), isOpen: true };
    const hand = [...bamboo(4, 5, 6), ...bamboo(7, 8, 9), ...bamboo(2, 3, 4), ...bamboo(5)];
    const result = calculateFan(hand, [chow], bamboo(5)[0], "east", "south");
    expect(result.totalFan).toBe(8); // All One Suit 7 + Common Hand 1
  });
});

/* ---------- Edge cases ---------- */

describe("edge cases", () => {
  it("accepts the hand with or without the winning tile included", () => {
    const all = [...wind("east", 3), ...plain()];
    const winning = all[all.length - 1];
    const without = calculateFan(all.slice(0, -1), [], winning, "east", "south");
    const included = calculateFan(all, [], winning, "east", "south");
    expect(included).toEqual(without);
    expect(without.totalFan).toBe(1);
  });

  it("scores zero for a hand that is not a winning hand", () => {
    const result = fan([
      ...dots(1, 2, 3),
      ...dots(4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(5, 5),
      ...chars(1, 2, 4),
    ]);
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });

  it("scores zero for a valid hand with no patterns", () => {
    expect(fan([...dots(1, 1, 1), ...chars(4, 5, 6), ...bamboo(7, 8, 9), ...dots(5, 6, 7), ...chars(2, 2)])).toEqual({
      totalFan: 0,
      patterns: [],
    });
  });

  it("scores zero when the hand contains bonus tiles", () => {
    const result = fan([...plain().slice(0, 10), t({ kind: "flower", number: 1 }), ...dots(9, 9, 9)]);
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });

  it("scores zero when the tile count does not match the melds", () => {
    const kong: Meld = { type: "kong", tiles: wind("east", 4), isOpen: true };
    const result = calculateFan(plain().slice(0, 8), [kong], chars(2)[0], "east", "east");
    expect(result).toEqual({ totalFan: 0, patterns: [] });
  });

  it("does not mutate the inputs", () => {
    const all = [...wind("east", 3), ...plain()];
    const hand = all.slice(0, -1);
    const before = hand.map((tile) => tile.id);
    calculateFan(hand, [], all[all.length - 1], "east", "south");
    expect(hand.map((tile) => tile.id)).toEqual(before);
  });
});

/* ---------- The HKOS core patterns, with claimed melds in the hand ---------- */

describe("core patterns with open melds", () => {
  const open = (type: "chow" | "pung" | "kong", tiles: Tile[]): Meld => ({ type, tiles, isOpen: true });

  it("Ping Wu: open chows still make a Common Hand", () => {
    const melds = [open("chow", dots(1, 2, 3)), open("chow", chars(4, 5, 6))];
    const hand = [...bamboo(7, 8, 9), ...dots(7, 8, 9), ...chars(2)];
    const result = calculateFan(hand, melds, chars(2)[0], "east", "south");
    expect(result).toEqual({ totalFan: 1, patterns: ["Common Hand"] });
  });

  it("Dui Dui Hu: claimed pungs and a kong count as all pungs", () => {
    const melds = [
      open("pung", dots(2, 2, 2)),
      open("kong", chars(5, 5, 5, 5)),
      open("pung", bamboo(8, 8, 8)),
    ];
    const hand = [...dots(9, 9, 9), ...chars(3)];
    const result = calculateFan(hand, melds, chars(3)[0], "east", "south");
    expect(result).toEqual({ totalFan: 3, patterns: ["All in Triplets"] });
  });

  it("Hun Yi Se: one suit with a claimed honor pung", () => {
    const melds = [open("pung", wind("west", 3))];
    const hand = [...dots(1, 2, 3), ...dots(4, 5, 6), ...dots(7, 8, 9), ...dots(5)];
    const result = calculateFan(hand, melds, dots(5)[0], "east", "south");
    expect(result).toEqual({ totalFan: 3, patterns: ["Mixed One Suit"] });
  });

  it("Qing Yi Se: one suit and nothing else, claimed melds included", () => {
    const melds = [open("pung", chars(1, 1, 1)), open("chow", chars(4, 5, 6))];
    const hand = [...chars(7, 8, 9), ...chars(2, 3, 4), ...chars(9)];
    const result = calculateFan(hand, melds, chars(9)[0], "east", "south");
    expect(result.patterns).toContain("All One Suit");
    expect(result.patterns).not.toContain("Mixed One Suit");
    expect(result.totalFan).toBe(7);
  });

  it("a claimed kong of the seat wind scores the wind", () => {
    const melds = [open("kong", wind("south", 4))];
    const hand = [...dots(1, 2, 3), ...chars(4, 5, 6), ...bamboo(7, 8, 9), ...dots(2)];
    const result = calculateFan(hand, melds, dots(2)[0], "south", "east");
    expect(result).toEqual({ totalFan: 1, patterns: ["Seat Wind"] });
  });
});

/* ---------- Pattern labels ---------- */

describe("PATTERN_FAN and patternLabels", () => {
  it("lists the worth of each core pattern", () => {
    expect(PATTERN_FAN["Common Hand"]).toBe(1);
    expect(PATTERN_FAN["All in Triplets"]).toBe(3);
    expect(PATTERN_FAN["Mixed One Suit"]).toBe(3);
    expect(PATTERN_FAN["All One Suit"]).toBe(7);
    expect(PATTERN_FAN["Red Dragon"]).toBe(1);
    expect(PATTERN_FAN["Seat Wind"]).toBe(1);
    expect(PATTERN_FAN["Prevalent Wind"]).toBe(1);
  });

  it("calculateFan always agrees with the table", () => {
    const hands: Tile[][] = [
      [...plain(), ...dots(4, 5, 6)],
      [...dots(2, 2, 2), ...chars(5, 5, 5), ...bamboo(8, 8, 8), ...dragon("red", 3), ...dots(9, 9)],
      [...dots(1, 1, 1), ...dots(3, 3, 3), ...dots(5, 5, 5), ...wind("east", 3), ...dots(9, 9)],
    ];
    for (const h of hands) {
      const result = fan(h, "east", "south");
      const sum = result.patterns.reduce((n, name) => n + PATTERN_FAN[name as keyof typeof PATTERN_FAN], 0);
      expect(Math.min(sum, LIMIT_FAN)).toBe(result.totalFan);
    }
  });

  it("prints each pattern with its fan", () => {
    const result = fan(
      [...dots(2, 2, 2), ...chars(5, 5, 5), ...bamboo(8, 8, 8), ...dragon("red", 3), ...dots(9, 9)],
    );
    expect(patternLabels(result)).toEqual(["All in Triplets (3)", "Red Dragon (1)"]);
  });

  it("prints nothing for a hand with no patterns", () => {
    expect(patternLabels({ totalFan: 0, patterns: [] })).toEqual([]);
  });
});

/* ---------- The payout table ---------- */

describe("payout table", () => {
  it("doubles with every fan: 1, 2, 4, 8, 16...", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(fanToPoints)).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
  });

  it("stops growing at the cap", () => {
    expect(PAYOUT_FAN_CAP).toBe(8);
    expect(fanToPoints(8)).toBe(256);
    expect(fanToPoints(9)).toBe(256);
    expect(fanToPoints(LIMIT_FAN)).toBe(256);
  });

  it("ignores nonsense fan", () => {
    expect(fanToPoints(-3)).toBe(1);
    expect(fanToPoints(2.9)).toBe(4);
  });

  it("basePoints reads the hand's total fan", () => {
    expect(basePoints({ totalFan: 3, patterns: ["All in Triplets"] })).toBe(8);
    expect(basePoints({ totalFan: 10, patterns: [] })).toBe(256);
    expect(basePoints()).toBe(1);
  });

  it("a discard win is paid by the chucker alone, at the fan payout", () => {
    const result = { totalFan: 3, patterns: ["All in Triplets"] };
    expect(settleWin(4, { winners: [1], selfDrawn: false, chucker: 2, result })).toEqual([
      { from: 2, to: 1, amount: 8 },
    ]);
  });

  it("a self-draw is paid by all three, at the fan payout plus the self-draw bonus", () => {
    const result = { totalFan: 7, patterns: ["All One Suit"] };
    expect(settleWin(4, { winners: [3], selfDrawn: true, result })).toEqual([
      { from: 0, to: 3, amount: 129 },
      { from: 1, to: 3, amount: 129 },
      { from: 2, to: 3, amount: 129 },
    ]);
  });
});

describe("isLimitFan", () => {
  it("is true from 8 fan, where the payout stops growing", () => {
    expect(isLimitFan(7)).toBe(false);
    expect(isLimitFan(8)).toBe(true);
    expect(isLimitFan(13)).toBe(true);
  });
});
