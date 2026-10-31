import { describe, expect, it } from "vitest";
import { initializeHKOSGame } from "./game.ts";
import { processAction } from "./moves.ts";
import type { GameState, SeatIndex, SuitRank, Tile } from "./types.ts";

const IDS: [string, string, string, string] = ["p1", "p2", "p3", "p4"];
const T0 = 1_700_000_000_000;

let nextId = 9000;
const mk = (face: Tile["face"]): Tile => ({ id: nextId++, face, copy: 0 });
const bam = (rank: SuitRank) => mk({ kind: "suit", suit: "bamboo", rank });
/** A lone red dragon: nobody holds a pair of it, so it can never be claimed. */
const dragon = () => mk({ kind: "dragon", dragon: "red" });
/** Characters and dots only: nobody holding these can claim a dragon or a bamboo 5. */
const filler = (n: number): Tile[] =>
  Array.from({ length: n }, (_, i) =>
    mk({ kind: "suit", suit: i % 2 === 0 ? "characters" : "dots", rank: ((i * 2) % 9 + 1) as SuitRank }),
  );

/**
 * A started hand: East (seat 0) holds `drawn` and must act, everyone else holds unclaimable
 * filler, and exactly `wallSize` tiles are left in the live wall.
 */
function table(drawn: Tile, wallSize: number): GameState {
  const started = processAction(initializeHKOSGame("g", IDS, "huangpai"), {
    type: "system",
    seq: 0,
    event: "hand-start",
    payload: { timestamp: T0 },
  });
  return {
    ...started,
    wall: { ...started.wall, liveTiles: started.wall.liveTiles.slice(0, wallSize) },
    players: started.players.map((p) =>
      p.seat === 0 ? { ...p, drawnTile: drawn } : { ...p, hand: filler(13) },
    ),
  };
}

const discard = (state: GameState, seat: SeatIndex, tile: Tile) =>
  processAction(state, {
    type: "discard",
    seq: state.history.length,
    seat,
    timestamp: T0 + 1000,
    tile,
    fromDraw: state.players[seat].drawnTile?.id === tile.id,
  });

const pass = (state: GameState, seat: SeatIndex) =>
  processAction(state, { type: "pass", seq: state.history.length, seat, timestamp: T0 + 2000 });

const draw = (state: GameState) =>
  processAction(state, {
    type: "draw",
    seq: state.history.length,
    seat: state.currentTurn,
    timestamp: T0 + 3000,
    tile: state.wall.liveTiles[0]!,
    fromDeadWall: false,
  });

/** Gives `seat` this tile as their drawn tile (so the test controls what they throw). */
const holding = (state: GameState, seat: SeatIndex, tile: Tile): GameState => ({
  ...state,
  players: state.players.map((p) => (p.seat === seat ? { ...p, drawnTile: tile } : p)),
});

describe("exhaustive draw (流局)", () => {
  it("ends the hand when an unclaimed discard leaves the next player nothing to draw", () => {
    const tile = dragon();
    const ended = discard(table(tile, 0), 0, tile);

    expect(ended.phase).toEqual({ type: "hand-end", reason: "exhaustive-draw" });
    expect(ended.phase).not.toHaveProperty("winners");
    // The discard itself still happened and is on the record.
    expect(ended.players[0].discards.map((d) => d.tile.id)).toEqual([tile.id]);
    expect(ended.history[ended.history.length - 1]).toMatchObject({ type: "discard", seat: 0 });
    expect(ended.wall.liveTiles).toHaveLength(0);
  });

  it("does not end the hand while a tile is still left to draw", () => {
    const tile = dragon();
    const next = discard(table(tile, 1), 0, tile);
    expect(next.phase).toEqual({ type: "draw", seat: 1 });
    expect(next.currentTurn).toBe(1);
  });

  it("ends the hand after the very last tile is drawn and thrown", () => {
    const first = dragon();
    let state = discard(table(first, 1), 0, first);
    expect(state.phase).toEqual({ type: "draw", seat: 1 });

    // South takes the last tile of the wall, then throws something nobody can claim.
    state = draw(state);
    expect(state.wall.liveTiles).toHaveLength(0);
    expect(state.phase).toMatchObject({ type: "action", seat: 1 });

    const last = dragon();
    state = discard(holding(state, 1, last), 1, last);
    expect(state.phase).toEqual({ type: "hand-end", reason: "exhaustive-draw" });
  });

  it("still opens a claim window on the last discard, and ends the hand once everyone passes", () => {
    const five = bam(5);
    let state = table(five, 0);
    state = {
      ...state,
      players: state.players.map((p) =>
        p.seat === 1 || p.seat === 2 ? { ...p, hand: [bam(5), bam(5), ...filler(11)] } : p,
      ),
    };

    state = discard(state, 0, five);
    expect(state.phase.type).toBe("claim-window");

    state = pass(state, 1);
    expect(state.phase.type).toBe("claim-window"); // seat 2 has not answered yet

    state = pass(state, 2);
    expect(state.phase).toEqual({ type: "hand-end", reason: "exhaustive-draw" });
  });

  it("lets a claim on the last discard play out, then ends the hand on the next unclaimed discard", () => {
    const five = bam(5);
    let state = table(five, 0);
    state = {
      ...state,
      players: state.players.map((p) => (p.seat === 1 ? { ...p, hand: [bam(5), bam(5), ...filler(11)] } : p)),
    };

    state = discard(state, 0, five);
    const pung = (state.phase as Extract<typeof state.phase, { type: "claim-window" }>).availableClaims.find(
      (c) => c.seat === 1 && c.kind === "pung",
    )!;
    state = processAction(state, {
      type: "claim",
      seq: state.history.length,
      seat: 1,
      timestamp: T0 + 4000,
      payload: { kind: "pung", usingTiles: pung.usingTiles },
    });
    // The pung is allowed even though the wall is empty: South now has to discard.
    expect(state.phase).toMatchObject({ type: "action", seat: 1 });

    const last = dragon();
    state = {
      ...state,
      players: state.players.map((p) => (p.seat === 1 ? { ...p, hand: [...filler(10), last] } : p)),
    };
    state = discard(state, 1, last);
    expect(state.phase).toEqual({ type: "hand-end", reason: "exhaustive-draw" });
  });

  it("accepts no more moves once the hand has ended in a draw", () => {
    const tile = dragon();
    const ended = discard(table(tile, 0), 0, tile);

    expect(() => draw({ ...ended, wall: { ...ended.wall, liveTiles: filler(1) } })).toThrow();
    expect(() => discard(ended, 1, ended.players[1].hand[0]!)).toThrow();
    expect(() => pass(ended, 1)).toThrow();
  });

  it("does not change the state it was given", () => {
    const tile = dragon();
    const before = table(tile, 0);
    const snapshot = structuredClone(before);
    discard(before, 0, tile);
    expect(before).toEqual(snapshot);
  });
});
