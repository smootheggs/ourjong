import type { GameState, SeatIndex, WindName } from "./types.ts";

/**
 * The match ledger: one plain, serializable line per finished hand.
 *
 * Identity is the seat number (0-3). Seats never move during a match; only the seat *winds*
 * rotate with the dealership. So a ledger entry stores who won and who dealt in as seat numbers,
 * and names are looked up when the ledger is shown. Renaming a player, or sending the ledger over
 * a socket, never needs the entries rewritten.
 *
 * Nothing here stores anything: `ledgerEntryOf` reads a finished hand, `recordHand` returns the
 * ledger with that hand added. Whether to record at all is the caller's choice (the app only
 * records when the player has switched the ledger on).
 */

export type LedgerOutcome = "win" | "self-draw" | "draw";

export interface LedgerEntry {
  /** Unique per hand, so recording the same finished hand twice adds it once. */
  readonly key: string;
  /** The round wind the hand was played in. */
  readonly prevailingWind: WindName;
  /** Hand number within that round (dealer repeats count as hands). */
  readonly handNumber: number;
  /** Who dealt this hand (the seat wearing East). */
  readonly dealerSeat: SeatIndex;
  readonly dealerRepeats: number;
  readonly outcome: LedgerOutcome;
  /** The seat that won; null for a drawn hand. */
  readonly winner: SeatIndex | null;
  /** The seat whose discard the winner took; null for a self-draw or a drawn hand. */
  readonly loser: SeatIndex | null;
  /** Fan of the winning hand (0 for a drawn hand). */
  readonly fan: number;
  /** Points the winner took in total. */
  readonly points: number;
  /** What each seat gained or lost this hand, indexed by seat. */
  readonly deltas: readonly [number, number, number, number];
  /** The scoring patterns, e.g. "All in Triplets (3)". */
  readonly patterns: readonly string[];
}

export type Ledger = readonly LedgerEntry[];

/** The ledger line for a hand that has just ended; null while a hand is still being played. */
export function ledgerEntryOf(state: GameState): LedgerEntry | null {
  const phase = state.phase;
  if (phase.type !== "hand-end") return null;

  const { prevailingWind, handNumber, dealerSeat, dealerRepeats } = state.round;
  const base = {
    key: `${state.random.seed}:${prevailingWind}:${handNumber}:${dealerSeat}:${dealerRepeats}`,
    prevailingWind,
    handNumber,
    dealerSeat,
    dealerRepeats,
  };

  const winner = phase.winners?.[0] ?? null;
  if (winner === null) {
    return { ...base, outcome: "draw", winner: null, loser: null, fan: 0, points: 0, deltas: [0, 0, 0, 0], patterns: [] };
  }

  const deltas: [number, number, number, number] = [0, 0, 0, 0];
  let points = 0;
  for (const { from, to, amount } of phase.payments ?? []) {
    deltas[from] -= amount;
    deltas[to] += amount;
    if (to === winner) points += amount;
  }

  const selfDrawn = phase.reason === "win-self-draw";
  const payer = selfDrawn ? undefined : phase.payments?.find((p) => p.to === winner)?.from;
  return {
    ...base,
    outcome: selfDrawn ? "self-draw" : "win",
    winner,
    loser: payer ?? null,
    fan: phase.totalFan ?? 0,
    points,
    deltas,
    patterns: phase.patterns ?? [],
  };
}

/**
 * The ledger with the hand that just ended added. The same ledger comes back (same array) when the
 * hand is not over yet, or is already in it, so it is safe to call on every render.
 */
export function recordHand(ledger: Ledger, state: GameState): Ledger {
  const entry = ledgerEntryOf(state);
  if (entry === null || ledger.some((e) => e.key === entry.key)) return ledger;
  return [...ledger, entry];
}

const WIND_WORDS: Record<WindName, string> = { east: "East", south: "South", west: "West", north: "North" };

const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `\u2212${-n}` : "0");

/**
 * The words for one entry, for any screen.
 * - `label`: "East 1", the round wind and hand.
 * - `text`: what happened, e.g. "Player 1 won 3 Faan (Bot 2 dealt in)." or "Player 1 self-drew 3 Faan."
 * - `payouts`: who gained and who lost, short enough to sit on one wrapping line, e.g.
 *   ["Player 1: +15", "Bot 2: \u221215"] or ["Player 1: +24", "Others: \u22128"].
 */
export function describeLedgerEntry(
  entry: LedgerEntry,
  nameOf: (seat: SeatIndex) => string,
): { readonly label: string; readonly text: string; readonly payouts: readonly string[] } {
  const label = `${WIND_WORDS[entry.prevailingWind]} ${entry.handNumber}`;
  if (entry.winner === null) return { label, text: "Drawn hand, no winner.", payouts: [] };

  const fan = `${entry.fan} Faan`;
  const winner = nameOf(entry.winner);
  const paid = ([0, 1, 2, 3] as const).filter((seat) => entry.deltas[seat]! < 0);
  const gain = `${winner}: ${signed(entry.deltas[entry.winner]!)}`;

  if (entry.outcome === "self-draw" || entry.loser === null) {
    // Everyone pays the same in a self-draw, so one "Others" figure says it all.
    const same = paid.length > 0 && paid.every((seat) => entry.deltas[seat] === entry.deltas[paid[0]!]);
    const losses = same
      ? [`Others: ${signed(entry.deltas[paid[0]!]!)}`]
      : paid.map((seat) => `${nameOf(seat)}: ${signed(entry.deltas[seat]!)}`);
    return { label, text: `${winner} self-drew ${fan}.`, payouts: [gain, ...losses] };
  }

  const loser = nameOf(entry.loser);
  return {
    label,
    text: `${winner} won ${fan} (${loser} dealt in).`,
    payouts: [gain, `${loser}: ${signed(entry.deltas[entry.loser]!)}`],
  };
}
