import { describe, expect, it } from "vitest";
import { initializeHKOSGame, processAction } from "@ourjong/engine";
import type { GameState, Meld, Tile } from "@ourjong/engine";
import { HIDDEN, sanitizeStateForPlayer } from "./sanitize.ts";

const IDS: [string, string, string, string] = ["p0", "p1", "p2", "p3"];
const SEED = "super-secret-seed-123";

/** A started hand: East has drawn its 14th tile. */
const started = (): GameState =>
  processAction(initializeHKOSGame("g", IDS, SEED), { type: "system", seq: 0, event: "hand-start" });

const idsOf = (tiles: readonly Tile[]) => tiles.map((t) => t.id);
const leaks = (json: string, id: number) => new RegExp(`"id":${id}[,}]`).test(json);

describe("sanitizeStateForPlayer", () => {
  it("shows you your own hand and drawn tile", () => {
    const state = started();
    const view = sanitizeStateForPlayer(state, "p0");
    expect(view.players[0]!.hand).toEqual(state.players[0]!.hand);
    expect(view.players[0]!.drawnTile).toEqual(state.players[0]!.drawnTile);
    expect(view.viewer).toEqual({ playerId: "p0", seat: 0 });
  });

  it("replaces every opponent's concealed hand with hidden placeholders of the same length", () => {
    const view = sanitizeStateForPlayer(started(), "p0");
    for (const seat of [1, 2, 3]) {
      const player = view.players[seat]!;
      expect(player.hand).toHaveLength(13);
      expect(player.hand.every((tile) => tile === HIDDEN)).toBe(true);
    }
  });

  it("hides an opponent's drawn tile but still shows that one exists", () => {
    const state = started(); // seat 0 holds a drawn tile
    expect(sanitizeStateForPlayer(state, "p1").players[0]!.drawnTile).toBe(HIDDEN);
    expect(sanitizeStateForPlayer(state, "p1").players[2]!.drawnTile).toBeNull();
  });

  it("replaces the live wall and the dead wall with hidden placeholders (lengths kept)", () => {
    const state = started();
    const view = sanitizeStateForPlayer(state, "p2");
    expect(view.wall.liveTiles).toHaveLength(state.wall.liveTiles.length);
    expect(view.wall.deadWall).toHaveLength(16);
    expect(view.wall.liveTiles.every((tile) => tile === HIDDEN)).toBe(true);
    expect(view.wall.deadWall.every((tile) => tile === HIDDEN)).toBe(true);
  });

  it("puts no hidden tile and no seed anywhere in what is sent over the wire", () => {
    const state = started();
    const json = JSON.stringify(sanitizeStateForPlayer(state, "p1"));

    const secret = [
      ...state.players[0]!.hand,
      ...(state.players[0]!.drawnTile ? [state.players[0]!.drawnTile] : []),
      ...state.players[2]!.hand,
      ...state.players[3]!.hand,
      ...state.wall.liveTiles,
      ...state.wall.deadWall,
    ];
    for (const id of idsOf(secret)) expect(leaks(json, id)).toBe(false);

    expect(json.includes(SEED)).toBe(false);
    expect(json.includes('"seed"')).toBe(false);
    expect("random" in sanitizeStateForPlayer(state, "p1")).toBe(false);
  });

  it("does not leak the drawn tile through the history", () => {
    const state = started();
    const drawn = state.players[0]!.drawnTile!;
    expect(leaks(JSON.stringify(sanitizeStateForPlayer(state, "p1").history), drawn.id)).toBe(false);
    // The drawer still sees their own draw.
    expect(leaks(JSON.stringify(sanitizeStateForPlayer(state, "p0").history), drawn.id)).toBe(true);
  });

  it("only lists the viewer's own claim options (others would name tiles in their hands)", () => {
    const state = started();
    const tile = state.players[0]!.drawnTile!;
    const [a, b] = state.players[1]!.hand;
    const claim: GameState = {
      ...state,
      phase: {
        type: "claim-window",
        discardedBy: 0,
        tile,
        passed: [],
        availableClaims: [
          { seat: 1, kind: "pung", usingTiles: [a!, b!] },
          { seat: 2, kind: "pung", usingTiles: [state.players[2]!.hand[0]!, state.players[2]!.hand[1]!] },
        ],
      },
    };
    const mine = sanitizeStateForPlayer(claim, "p1").phase;
    const other = sanitizeStateForPlayer(claim, "p3").phase;
    if (mine.type !== "claim-window" || other.type !== "claim-window") throw new Error("phase");
    expect(mine.availableClaims.map((c) => c.seat)).toEqual([1]);
    expect(other.availableClaims).toEqual([]);
    expect(leaks(JSON.stringify(sanitizeStateForPlayer(claim, "p3")), state.players[2]!.hand[0]!.id)).toBe(false);
  });

  it("keeps open melds public and hides other players' concealed kongs", () => {
    const state = started();
    const tiles = state.players[1]!.hand.slice(0, 4);
    const open: Meld = { type: "pung", tiles: tiles.slice(0, 3), isOpen: true };
    const concealed: Meld = { type: "kong", tiles, isOpen: false, kongVariant: "concealed" };
    const withMelds: GameState = {
      ...state,
      players: state.players.map((p) => (p.seat === 1 ? { ...p, melds: [open, concealed] } : p)),
    };

    const other = sanitizeStateForPlayer(withMelds, "p2").players[1]!.melds;
    expect(other[0]!.tiles).toEqual(open.tiles);
    expect(other[1]!.tiles).toEqual([HIDDEN, HIDDEN, HIDDEN, HIDDEN]);

    const owner = sanitizeStateForPlayer(withMelds, "p1").players[1]!.melds;
    expect(owner[1]!.tiles).toEqual(tiles);
  });

  it("reveals every hand once the hand has ended", () => {
    const state = started();
    const over: GameState = {
      ...state,
      phase: { type: "hand-end", reason: "exhaustive-draw" },
    };
    const view = sanitizeStateForPlayer(over, "p0");
    expect(view.players[2]!.hand).toEqual(state.players[2]!.hand);
    // The wall stays hidden even then.
    expect(view.wall.liveTiles.every((tile) => tile === HIDDEN)).toBe(true);
  });

  it("gives an unknown id the spectator view: everything hidden", () => {
    const state = started();
    const view = sanitizeStateForPlayer(state, "nobody");
    expect(view.viewer.seat).toBeNull();
    for (const player of view.players) {
      expect(player.hand.every((tile) => tile === HIDDEN)).toBe(true);
    }
  });

  it("never mutates the real state", () => {
    const state = started();
    const snapshot = structuredClone(state);
    sanitizeStateForPlayer(state, "p0");
    sanitizeStateForPlayer(state, "p3");
    expect(state).toEqual(snapshot);
  });
});