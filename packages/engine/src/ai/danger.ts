import type { GameState, SeatIndex, Tile } from "../types.ts";
import { FACE_COUNT, faceIndexOf } from "./shanten.ts";
import { honorValue, summariseMelds } from "./patterns.ts";
import type { FaanContext, MeldSummary } from "./patterns.ts";

/**
 * How likely a discard is to be the tile an opponent is waiting on, from public information
 * only: the rivers, the open melds, and the tiles in your own hand. It never looks at anyone's
 * concealed tiles. 0 is as safe as a tile gets, 100 is "do not throw this".
 *
 * What it reads:
 *   - a tile an opponent already threw is nearly safe against that opponent;
 *   - a tile with few copies left unseen is safer (fewer ways to wait on it), honors most of all,
 *     since they can only be waited on as a pair or a pung;
 *   - with nothing else known, middle tiles (3-7) are the most dangerous, then 2s and 8s, then
 *     1s and 9s, then honors;
 *   - an opponent's open melds say what they can still win with (a chow of one suit rules out
 *     every other suit but honors; a pung leaves All Pongs open), so tiles they can no longer
 *     use are safe against them;
 *   - an opponent with 2+ open melds in one suit and nothing else is a flush threat: that suit
 *     (and a little the honors) goes up sharply;
 *   - an opponent who has thrown several tiles of a suit is dumping it, so it is safer.
 */

/** An opponent with this many open melds in a single suit is going for a flush. */
export const FLUSH_THREAT_MELDS = 2;
/** The late game: fewer than this many tiles left in the live wall. */
export const LATE_WALL = 20;
/** An opponent with this many open melds is a threat on their own. */
export const THREAT_MELDS = 3;

/** What one opponent has shown the table. */
export interface OpponentView {
  readonly seat: SeatIndex;
  /** How many of each face they have thrown (tiles claimed from them included: they threw them). */
  readonly river: Uint8Array;
  /** Tiles thrown per suit (bamboo, characters, dots). */
  readonly riverSuit: readonly [number, number, number];
  readonly riverTotal: number;
  readonly melds: MeldSummary;
  /** Melds taken from a discard or added to; concealed kongs do not count. */
  readonly openMelds: number;
  /** The suit (0-2) they have 2+ open melds in and nothing else, or -1. */
  readonly flushSuit: number;
  readonly ctx: FaanContext;
}

export interface TableView {
  /** Copies of each face in view of this seat: every river and meld on the table, and its own hand. */
  readonly seen: Uint8Array;
  readonly opponents: readonly OpponentView[];
}

/* ---------- Reading the table ---------- */

export function tableViewOf(state: GameState, seat: SeatIndex): TableView {
  const seen = new Uint8Array(FACE_COUNT);
  const add = (tile: Tile) => {
    const face = faceIndexOf(tile.face);
    if (face >= 0) seen[face]++;
  };

  const opponents: OpponentView[] = [];
  for (const player of state.players) {
    for (const meld of player.melds) meld.tiles.forEach(add);
    // A claimed discard stays in the river list but is already counted in the meld.
    for (const entry of player.discards) if (entry.claimedBy === undefined) add(entry.tile);

    if (player.seat === seat) {
      player.hand.forEach(add);
      if (player.drawnTile) add(player.drawnTile);
      continue;
    }

    const river = new Uint8Array(FACE_COUNT);
    const riverSuit: [number, number, number] = [0, 0, 0];
    for (const entry of player.discards) {
      const face = faceIndexOf(entry.tile.face);
      if (face < 0) continue;
      river[face]++;
      if (face < 27) riverSuit[Math.floor(face / 9)]++;
    }

    const ctx: FaanContext = {
      seatWind: player.seatWind,
      prevailingWind: state.round.prevailingWind,
      minimumFan: state.rules.minimumScore,
    };
    const melds = summariseMelds(player.melds, ctx);

    let flushSuit = -1;
    for (let suit = 0; suit < 3; suit++) {
      const inSuit = player.melds.filter(
        (m) => m.isOpen && m.tiles.length > 0 && faceIndexOf(m.tiles[0].face) >= 0 && Math.floor(faceIndexOf(m.tiles[0].face) / 9) === suit && faceIndexOf(m.tiles[0].face) < 27,
      ).length;
      if (inSuit >= FLUSH_THREAT_MELDS && (melds.suitMask & ~(1 << suit)) === 0) flushSuit = suit;
    }

    opponents.push({
      seat: player.seat,
      river,
      riverSuit,
      riverTotal: river.reduce((n, c) => n + c, 0),
      melds,
      openMelds: player.melds.filter((m) => m.isOpen).length,
      flushSuit,
      ctx,
    });
  }
  return { seen, opponents };
}

/* ---------- The score ---------- */

const SCARCITY = [0.2, 0.55, 0.85, 1.0] as const; // by copies still unseen (0-3)

/** How risky a tile is with nothing else known. */
function rawRisk(face: number): number {
  if (face >= 27) return 22;
  const rank = face % 9;
  if (rank === 0 || rank === 8) return 30;
  if (rank === 1 || rank === 7) return 45;
  return 60;
}

/** A tile an All Pongs hand can wait on is a pair or a pung: any face is about equally likely. */
const PAIR_WAIT_RISK = 35;

function dangerAgainst(face: number, o: OpponentView, seen: Uint8Array): number {
  const suited = face < 27;
  const suit = suited ? Math.floor(face / 9) : -1;
  const base = rawRisk(face);
  // `seen` counts every copy in view, including the one being thrown.
  const unseen = Math.max(0, Math.min(3, 4 - seen[face]));
  const scarcity = SCARCITY[unseen];
  // A pair or a pung is the only way to wait on an honor: with fewer than two left, almost none.
  const honorScarce = !suited && unseen < 2 ? 0.35 : 1;

  let risk: number;
  if (o.melds.count === 0) {
    risk = base; // concealed: nothing known, so everything is possible
  } else {
    // What can this opponent still win with? Their melds decide.
    let flushRel = 0;
    for (let s = 0; s < 3; s++) {
      if ((o.melds.suitMask & ~(1 << s)) !== 0) continue; // a meld of another suit rules this flush out
      if (suited && s === suit) flushRel = 1;
      else if (!suited) flushRel = Math.max(flushRel, 0.6);
    }
    const tripletsRel = o.melds.allPungs ? 0.7 : 0;
    const honorsRel = o.melds.honorFan > 0 && !suited && honorValue(face, o.ctx) > 0 ? 0.5 : 0;

    risk = Math.max(base * flushRel, base * honorsRel, Math.min(base, PAIR_WAIT_RISK) * tripletsRel);
    if (risk === 0) risk = base * 0.08; // inferred, not known: never quite zero
  }

  if (o.flushSuit >= 0) {
    if (suit === o.flushSuit) risk += 35;
    else if (!suited) risk += 15;
  }

  // The third dragon after two dragon pungs, or the fourth wind after three wind pungs: the tile that
  // would complete a big hand.
  if (!suited && o.melds.count > 0) {
    if (face >= 31) {
      let dragons = 0;
      for (let d = 0; d < 3; d++) if ((o.melds.honorMask & (1 << (4 + d))) !== 0) dragons++;
      if (dragons === 2 && (o.melds.honorMask & (1 << (face - 27))) === 0) risk = Math.max(risk, base) + 55;
    } else {
      let winds = 0;
      for (let w = 0; w < 4; w++) if ((o.melds.honorMask & (1 << w)) !== 0) winds++;
      if (winds === 3 && (o.melds.honorMask & (1 << (face - 27))) === 0) risk = Math.max(risk, base) + 55;
    }
  }

  risk *= scarcity * honorScarce;

  // They threw it themselves: they do not need it.
  if (o.river[face] > 0) risk *= 0.1;
  // They keep throwing this suit: they are not collecting it.
  else if (suited && o.riverSuit[suit] >= 3 && o.flushSuit !== suit) risk *= 0.6;

  return risk;
}

/** Danger (0-100) of a face against each opponent in turn, worst first. */
export function dangerBreakdown(face: number, view: TableView): { seat: SeatIndex; danger: number }[] {
  if (face < 0) return view.opponents.map((o) => ({ seat: o.seat, danger: 0 }));
  return view.opponents
    .map((o) => ({ seat: o.seat, danger: Math.round(Math.max(0, Math.min(100, dangerAgainst(face, o, view.seen)))) }))
    .sort((a, b) => b.danger - a.danger);
}

/** Danger (0-100) of throwing a tile of this face, worst case over the opponents. */
export function dangerOfFace(face: number, view: TableView): number {
  if (face < 0) return 0; // flowers and the like are never anyone's tile
  let worst = 0;
  for (const o of view.opponents) worst = Math.max(worst, dangerAgainst(face, o, view.seen));
  return Math.round(Math.max(0, Math.min(100, worst)));
}

/** Danger of every tile in `hand`, in the same order. */
export function dangerScores(hand: readonly Tile[], view: TableView): number[] {
  const cache = new Map<number, number>();
  return hand.map((tile) => {
    const face = faceIndexOf(tile.face);
    let value = cache.get(face);
    if (value === undefined) {
      value = dangerOfFace(face, view);
      cache.set(face, value);
    }
    return value;
  });
}

/* ---------- Is the table dangerous right now? ---------- */

export interface Threat {
  /** Tiles left in the live wall. */
  readonly wallLeft: number;
  /** The wall is nearly gone: everyone who is close to winning is about to be. */
  readonly lateGame: boolean;
  /** Opponents with THREAT_MELDS or more open melds. */
  readonly heavyMelds: readonly SeatIndex[];
  /** Opponents who look like they are going for a flush, and which suit. */
  readonly flushThreats: readonly { readonly seat: SeatIndex; readonly suit: number }[];
  /** Late game, or someone with three open melds: time to think about defense. */
  readonly active: boolean;
}

export function assessThreat(state: GameState, view: TableView): Threat {
  const wallLeft = state.wall.liveTiles.length;
  const lateGame = wallLeft < LATE_WALL;
  const heavyMelds = view.opponents.filter((o) => o.openMelds >= THREAT_MELDS).map((o) => o.seat);
  const flushThreats = view.opponents
    .filter((o) => o.flushSuit >= 0)
    .map((o) => ({ seat: o.seat, suit: o.flushSuit }));
  return { wallLeft, lateGame, heavyMelds, flushThreats, active: lateGame || heavyMelds.length > 0 };
}
