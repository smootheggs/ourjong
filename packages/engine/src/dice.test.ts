import { describe, expect, it } from "vitest";
import { initializeHKOSGame } from "./game.ts";
import { WALL_STACKS, generateDiceRoll, resolveDiceRoll } from "./dice.ts";
import type { GameState } from "./types.ts";

const game = (seed: string): GameState => initializeHKOSGame("t", ["a", "b", "c", "d"], seed);

describe("generateDiceRoll", () => {
  it("is the same every time for the same hand", () => {
    const state = game("seed-1");
    expect(generateDiceRoll(state)).toEqual(generateDiceRoll(state));
  });

  it("gives two dice from 1 to 6, as a pair", () => {
    for (let i = 0; i < 300; i++) {
      const { dice, total } = generateDiceRoll(game(`s${i}`));
      expect(dice).toHaveLength(2);
      for (const d of dice) expect(d >= 1 && d <= 6 && Number.isInteger(d)).toEqual(true);
      expect(total).toEqual(dice[0] + dice[1]);
    }
  });

  it("uses every face, and does not leave the dice stuck", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) generateDiceRoll(game(`s${i}`)).dice.forEach((d) => seen.add(d));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("changes from one hand of a match to the next", () => {
    const first = game("same-seed");
    const later = { ...first, round: { ...first.round, handNumber: 2 } };
    const rolls = new Set<string>();
    for (let hand = 1; hand <= 20; hand++) {
      rolls.add(generateDiceRoll({ ...first, round: { ...first.round, handNumber: hand } }).dice.join());
    }
    expect(rolls.size > 3).toEqual(true);
    expect(generateDiceRoll(later).rollerSeat).toEqual(0);
  });
});

describe("resolveDiceRoll", () => {
  it("counts the total from the dealer as 1", () => {
    // Dealer East (seat 0): a total of 1 mod 4 lands on East itself, 2 on South, 3 on West, 0 on North.
    expect(resolveDiceRoll([3, 5], 0).breakerSeat).toEqual(3); // 8 -> North
    expect(resolveDiceRoll([1, 4], 0).breakerSeat).toEqual(0); // 5 -> East
    expect(resolveDiceRoll([6, 6], 0).breakerSeat).toEqual(3); // 12 -> North
    expect(resolveDiceRoll([1, 1], 0).breakerSeat).toEqual(1); // 2 -> South
  });

  it("counts from whoever is dealing", () => {
    expect(resolveDiceRoll([1, 1], 2).breakerSeat).toEqual(3); // dealer West, total 2 -> North
    expect(resolveDiceRoll([2, 2], 3).breakerSeat).toEqual(2); // dealer North, total 4 -> West
  });

  it("puts the break on the ring of 68 stacks", () => {
    const roll = resolveDiceRoll([3, 5], 0);
    expect(roll.breakStack).toEqual(8);
    expect(roll.breakIndex).toEqual(3 * 17 + 7);
    for (let a = 1; a <= 6; a++) {
      for (let b = 1; b <= 6; b++) {
        for (const dealer of [0, 1, 2, 3] as const) {
          const { breakIndex } = resolveDiceRoll([a, b], dealer);
          expect(breakIndex >= 0 && breakIndex < WALL_STACKS).toEqual(true);
        }
      }
    }
  });
});
