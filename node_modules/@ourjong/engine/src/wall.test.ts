import { describe, expect, it } from "vitest";
import { createStandardDeck } from "./wall.ts";

describe("createStandardDeck", () => {
  const deck = createStandardDeck();

  const countSuit = (suit: string) =>
    deck.filter((t) => t.face.kind === "suit" && t.face.suit === suit).length;

  it("returns exactly 136 tiles", () => {
    expect(deck).toHaveLength(136);
  });

  it("contains 36 bamboo, 36 characters, and 36 dots", () => {
    expect(countSuit("bamboo")).toBe(36);
    expect(countSuit("characters")).toBe(36);
    expect(countSuit("dots")).toBe(36);
  });

  it("contains 16 winds and 12 dragons", () => {
    expect(deck.filter((t) => t.face.kind === "wind")).toHaveLength(16);
    expect(deck.filter((t) => t.face.kind === "dragon")).toHaveLength(12);
  });

  it("contains no flowers, seasons, or custom tiles", () => {
    const others = deck.filter(
      (t) => !["suit", "wind", "dragon"].includes(t.face.kind),
    );
    expect(others).toHaveLength(0);
  });

  it("assigns a unique id to every tile", () => {
    const ids = new Set(deck.map((t) => t.id));
    expect(ids.size).toBe(136);
  });

  it("assigns sequential ids starting at 0", () => {
    expect(deck.map((t) => t.id)).toEqual(Array.from({ length: 136 }, (_, i) => i));
  });

  it("has exactly four copies (0-3) of each of the 34 distinct faces", () => {
    const copiesByFace = new Map<string, number[]>();
    for (const tile of deck) {
      const key = JSON.stringify(tile.face);
      const copies = copiesByFace.get(key) ?? [];
      copies.push(tile.copy);
      copiesByFace.set(key, copies);
    }

    expect(copiesByFace.size).toBe(34);
    for (const copies of copiesByFace.values()) {
      expect([...copies].sort()).toEqual([0, 1, 2, 3]);
    }
  });

  it("returns a fresh array on each call", () => {
    expect(createStandardDeck()).not.toBe(deck);
    expect(createStandardDeck()).toEqual(deck);
  });
});
