import { describe, expect, it } from "vitest";
import { HKOS_RULES, initializeHKOSGame } from "./game.ts";
import type { Tile } from "./types.ts";

const IDS: [string, string, string, string] = ["p1", "p2", "p3", "p4"];
const fresh = (seed = "seed-a") => initializeHKOSGame("g1", IDS, seed);

const allTiles = (state: ReturnType<typeof fresh>): Tile[] => [
  ...state.players.flatMap((p) => p.hand),
  ...state.wall.liveTiles,
  ...state.wall.deadWall,
];

describe("initializeHKOSGame", () => {
  it("starts in setup with East to act, no history and the supplied ids", () => {
    const state = fresh();
    expect(state.id).toBe("g1");
    expect(state.phase).toEqual({ type: "setup" });
    expect(state.currentTurn).toBe(0);
    expect(state.history).toEqual([]);
    expect(state.lastDiscard).toBeNull();
    expect(state.random.seed).toBe("seed-a");
    expect(state.players.map((p) => p.id)).toEqual(IDS);
  });

  it("uses the Hong Kong Old Style rules with the 3 fan minimum", () => {
    const state = fresh();
    expect(state.rules).toEqual(HKOS_RULES);
    expect(state.rules.minimumScore).toBe(3);
    expect(state.round).toEqual({
      prevailingWind: "east",
      dealerSeat: 0,
      handNumber: 1,
      dealerRepeats: 0,
      scores: [0, 0, 0, 0],
    });
  });

  it("seats East, South, West, North with East as dealer", () => {
    const state = fresh();
    expect(state.players.map((p) => p.seatWind)).toEqual(["east", "south", "west", "north"]);
    expect(state.players.map((p) => p.isDealer)).toEqual([true, false, false, false]);
    expect(state.players.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
  });

  it("deals 13 tiles to every seat, with nothing drawn, melded or discarded", () => {
    for (const p of fresh().players) {
      expect(p.hand).toHaveLength(13);
      expect(p.drawnTile).toBeNull();
      expect(p.melds).toEqual([]);
      expect(p.discards).toEqual([]);
    }
  });

  it("keeps a 16-tile dead wall and 68 live tiles", () => {
    const { wall } = fresh();
    expect(wall.deadWall).toHaveLength(16);
    expect(wall.deadWallSize).toBe(16);
    expect(wall.liveTiles).toHaveLength(68);
    expect(wall.drawCount).toBe(0);
    expect(wall.deadDrawCount).toBe(0);
  });

  it("uses all 136 tiles exactly once: four copies of each of 34 faces", () => {
    const tiles = allTiles(fresh());
    expect(tiles).toHaveLength(136);
    expect(new Set(tiles.map((t) => t.id)).size).toBe(136);

    const perFace = new Map<string, number>();
    for (const t of tiles) {
      const key = JSON.stringify(t.face);
      perFace.set(key, (perFace.get(key) ?? 0) + 1);
    }
    expect(perFace.size).toBe(34);
    expect([...perFace.values()].every((n) => n === 4)).toBe(true);
  });

  it("deals the same game for the same seed and a different one for another seed", () => {
    const ids = (s: ReturnType<typeof fresh>) => s.wall.liveTiles.map((t) => t.id).join(",");
    expect(fresh("same")).toEqual(fresh("same"));
    expect(ids(fresh("one"))).not.toBe(ids(fresh("two")));
  });

  it("shuffles the wall (it is not in tile-set order)", () => {
    const ordered = allTiles(fresh()).map((t) => t.id);
    expect(ordered).not.toEqual([...ordered].sort((a, b) => a - b));
  });
});
