import { describe, expect, it } from "vitest";
import { initializeHKOSGame } from "./game.ts";
import { describeLedgerEntry, ledgerEntryOf, recordHand } from "./ledger.ts";
import { processAction } from "./moves.ts";
import type { GameState, HandEndReason, Payment, SeatIndex } from "./types.ts";

const IDS: [string, string, string, string] = ["p1", "p2", "p3", "p4"];
const NAMES: [string, string, string, string] = ["Player 1", "Bot 1", "Bot 2", "Bot 3"];
const name = (s: SeatIndex) => NAMES[s]!;

function ended(reason: HandEndReason, extra: { winners?: SeatIndex[]; totalFan?: number; payments?: Payment[] } = {}, seed = "ledger-seed"): GameState {
  const base = initializeHKOSGame("ledger", IDS, seed, NAMES);
  return { ...base, phase: { type: "hand-end", reason, ...extra } };
}

describe("player identity", () => {
  it("names ride with the seat", () => {
    const g = initializeHKOSGame("x", IDS, "s", NAMES);
    expect(g.players.map((p) => p.name)).toEqual(NAMES);
    expect(g.players.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
  });
  it("names and seats stay put while the winds rotate", () => {
    let g = ended("win-discard", { winners: [2], totalFan: 3, payments: [{ from: 1, to: 2, amount: 8 }] });
    g = processAction(g, { type: "system", seq: 0, event: "round-advance", payload: { timestamp: 1 } });
    expect(g.round.dealerSeat).toBe(1);
    expect(g.players.map((p) => p.seatWind)).toEqual(["north", "east", "south", "west"]);
    expect(g.players.map((p) => p.name)).toEqual(NAMES);
    expect(g.players.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
  });
  it("a game without names has none", () => {
    expect(initializeHKOSGame("x", IDS, "s").players[0]!.name).toBe(undefined);
  });
});

describe("match ledger", () => {
  it("has nothing to say while a hand is being played", () => {
    expect(ledgerEntryOf(initializeHKOSGame("x", IDS, "s", NAMES))).toBe(null);
  });
  it("records a win off a discard: winner, who dealt in, fan, points, round wind", () => {
    const e = ledgerEntryOf(ended("win-discard", { winners: [0], totalFan: 3, payments: [{ from: 2, to: 0, amount: 8 }] }))!;
    expect(e.outcome).toBe("win");
    expect(e.winner).toBe(0);
    expect(e.loser).toBe(2);
    expect(e.fan).toBe(3);
    expect(e.points).toBe(8);
    expect(e.prevailingWind).toBe("east");
    expect(e.deltas).toEqual([8, 0, -8, 0]);
    expect(describeLedgerEntry(e, name)).toEqual({ label: "East 1", text: "Player 1 won 3 Faan (Bot 2 dealt in).", payouts: ["Player 1: +8", "Bot 2: \u22128"] });
  });
  it("records a self-draw with no loser", () => {
    const pays: Payment[] = [0, 2, 3].map((s) => ({ from: s as SeatIndex, to: 1 as SeatIndex, amount: 9 }));
    const e = ledgerEntryOf(ended("win-self-draw", { winners: [1], totalFan: 4, payments: pays }))!;
    expect(e.outcome).toBe("self-draw");
    expect(e.loser).toBe(null);
    expect(e.points).toBe(27);
    expect(e.deltas).toEqual([-9, 27, -9, -9]);
    expect(describeLedgerEntry(e, name)).toEqual({ label: "East 1", text: "Bot 1 self-drew 4 Faan.", payouts: ["Bot 1: +27", "Others: \u22129"] });
  });
  it("records a drawn hand", () => {
    const e = ledgerEntryOf(ended("exhaustive-draw"))!;
    expect(e.outcome).toBe("draw");
    expect(e.winner).toBe(null);
    expect(describeLedgerEntry(e, name).text).toBe("Drawn hand, no winner.");
    expect(describeLedgerEntry(e, name).payouts).toEqual([]);
  });
  it("adds a hand once, however often it is offered, and keeps hands apart", () => {
    const a = ended("exhaustive-draw", {}, "a");
    const b = ended("exhaustive-draw", {}, "b");
    let ledger = recordHand([], a);
    expect(recordHand(ledger, a)).toBe(ledger);
    ledger = recordHand(ledger, b);
    expect(ledger.length).toBe(2);
    expect(recordHand(ledger, initializeHKOSGame("x", IDS, "c", NAMES))).toBe(ledger);
  });
  it("is plain JSON, so it can cross a socket unchanged", () => {
    const ledger = recordHand([], ended("win-discard", { winners: [3], totalFan: 5, payments: [{ from: 0, to: 3, amount: 16 }] }));
    expect(JSON.parse(JSON.stringify(ledger))).toEqual(ledger);
  });
});
