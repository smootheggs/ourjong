import type { GameState, SeatIndex, Tile } from "../types.ts";
import { assessThreat, dangerBreakdown, tableViewOf } from "./danger.ts";
import type { Threat } from "./danger.ts";
import { evaluateDiscardsExpert } from "./evaluate.ts";
import type { Stance } from "./evaluate.ts";
import { faceIndexOf } from "./shanten.ts";

/**
 * The Coach: a second opinion on the discard a person is about to make.
 *
 * It plays the Level 3 evaluator on the human's own hand, reads how dangerous the chosen tile
 * is from the public information (see danger.ts), and says whether to stop and warn. It only
 * reads the state and has no effect on the game.
 */

/** A chosen tile riskier than this is "high risk", whatever else is going on. */
export const WARN_DANGER = 75;
/** Under a threat, a tile this much riskier than the Coach's pick is worth a warning... */
export const WARN_MARGIN = 30;
/** ...as long as it is at least this risky in itself. */
export const WARN_MIN_DANGER = 40;
/** A warning is only useful if there is something safer: the Coach's pick must beat it by this much. */
export const SAFER_BY = 10;

export interface DiscardAdvice {
  /** Danger (0-100) of the tile the player picked. */
  readonly danger: number;
  /** The Coach's own discard: Level 3's choice, or the best safe tile if that choice is risky. */
  readonly best: Tile;
  readonly bestDanger: number;
  readonly stance: Stance;
  readonly threat: Threat;
  /** Stop the game and ask before discarding. */
  readonly warn: boolean;
  /** "High Risk Discard" or "Risky Discard"; empty when `warn` is false. */
  readonly title: string;
  /** Why, in one short sentence ("Mei is threatening a Bamboo Flush."). Never empty when `warn` is true. */
  readonly reason: string;
  /** The picked tile and the Coach's pick, as words ("5 Bamboo", "West Wind"). */
  readonly tileName: string;
  readonly bestName: string;
}

const SUITS = ["Bamboo", "Characters", "Dots"] as const;
const WINDS = ["East", "South", "West", "North"] as const;
const DRAGONS = ["Red", "Green", "White"] as const;

/** A face index as words: "5 Bamboo", "West Wind", "Red Dragon". */
export function faceName(face: number): string {
  if (face < 0) return "Bonus tile";
  if (face < 27) return `${(face % 9) + 1} ${SUITS[Math.floor(face / 9)]}`;
  if (face < 31) return `${WINDS[face - 27]} Wind`;
  return `${DRAGONS[face - 31]} Dragon`;
}

/** The Level 3 ranking of every tile `seat` could discard now, with the table it was read from. */
function rankDiscards(state: GameState, seat: SeatIndex) {
  const player = state.players[seat];
  const held = player.drawnTile ? [...player.hand, player.drawnTile] : [...player.hand];
  const view = tableViewOf(state, seat);
  const threat = assessThreat(state, view);
  const ctx = {
    seatWind: player.seatWind,
    prevailingWind: state.round.prevailingWind,
    minimumFan: state.rules.minimumScore,
  };
  return { view, threat, ranked: evaluateDiscardsExpert(held, player.melds, ctx, view, threat) };
}

/**
 * The Coach's own pick: Level 3's best discard, unless that is itself a risky tile. In that case
 * (a flush threat that is not yet a full "threat state", say) it is the best-ranked tile that is
 * not risky, so the Coach never recommends a tile it would stop you from throwing.
 */
function coachPick<T extends { danger: number }>(ranked: readonly T[]): T {
  if (ranked[0].danger < WARN_MIN_DANGER) return ranked[0];
  return ranked.find((d) => d.danger < WARN_MIN_DANGER) ?? ranked[0];
}

/** The discard the Coach would make for `seat` (what the blue ring points at). */
export function recommendDiscard(state: GameState, seat: SeatIndex): Tile | null {
  const player = state.players[seat];
  if (player.hand.length === 0 && player.drawnTile === null) return null;
  return coachPick(rankDiscards(state, seat).ranked).tile;
}

/**
 * The single most important reason a tile is risky, as one short sentence. Checked in order of
 * how specific it is: a named flush threat, a dragon or wind set about to complete, a player with
 * many open melds, a nearly empty wall, and finally what kind of tile it is.
 */
function explain(
  face: number,
  view: ReturnType<typeof tableViewOf>,
  threat: Threat,
  nameOf: (seat: SeatIndex) => string,
): string {
  const byOpponent = dangerBreakdown(face, view);
  const driver = (seatId: SeatIndex) => (byOpponent.find((b) => b.seat === seatId)?.danger ?? 0) >= 30;
  const suited = face >= 0 && face < 27;
  const suit = suited ? Math.floor(face / 9) : -1;

  for (const o of view.opponents) {
    if (o.flushSuit < 0 || !driver(o.seat)) continue;
    if (suit === o.flushSuit || !suited) return `${nameOf(o.seat)} is threatening a ${SUITS[o.flushSuit]} Flush.`;
  }

  if (face >= 27) {
    for (const o of view.opponents) {
      if (face >= 31) {
        const dragons = [0, 1, 2].filter((d) => (o.melds.honorMask & (1 << (4 + d))) !== 0).length;
        if (dragons === 2 && (o.melds.honorMask & (1 << (face - 27))) === 0) {
          return `${nameOf(o.seat)} is one dragon away from Big Three Dragons.`;
        }
      } else {
        const winds = [0, 1, 2, 3].filter((w) => (o.melds.honorMask & (1 << w)) !== 0).length;
        if (winds === 3 && (o.melds.honorMask & (1 << (face - 27))) === 0) {
          return `${nameOf(o.seat)} is one wind away from Big Four Winds.`;
        }
      }
    }
  }

  if (threat.heavyMelds.length > 0) {
    const o = view.opponents.find((x) => x.seat === threat.heavyMelds[0])!;
    return `${nameOf(o.seat)} has ${o.openMelds} open melds and is close to winning.`;
  }
  if (threat.lateGame) return `Only ${threat.wallLeft} tiles are left, so this tile is a big risk.`;

  if (face >= 27) return "This tile is a high-risk raw honor tile.";
  const rank = (face % 9) + 1;
  if (rank === 1 || rank === 9) return "This tile is a high-risk raw terminal.";
  if (rank >= 3 && rank <= 7) return "This tile is a high-risk raw middle tile.";
  return "This tile is a high-risk raw tile.";
}

/**
 * Should the Coach stop `seat` from discarding `tile`?
 *
 * `nameOf` turns a seat into the word the table uses for them ("Mei", "West"); the Coach never
 * invents names or says where anyone is sitting.
 */
export function adviseDiscard(
  state: GameState,
  seat: SeatIndex,
  tile: Tile,
  nameOf: (seat: SeatIndex) => string = (s) => `Seat ${s + 1}`,
): DiscardAdvice {
  const { view, threat, ranked } = rankDiscards(state, seat);
  const best = coachPick(ranked);
  const picked = ranked.find((d) => d.tile.id === tile.id) ?? best;

  const face = faceIndexOf(picked.tile.face);
  const bestFace = faceIndexOf(best.tile.face);
  const danger = picked.danger;

  const saferBy = danger - best.danger;
  const warn =
    face !== bestFace &&
    saferBy >= SAFER_BY &&
    (danger > WARN_DANGER || (threat.active && danger >= WARN_MIN_DANGER && saferBy >= WARN_MARGIN));

  const reason = warn ? explain(face, view, threat, nameOf) : "";

  return {
    danger,
    best: best.tile,
    bestDanger: best.danger,
    stance: best.stance,
    threat,
    warn,
    title: !warn ? "" : danger > WARN_DANGER ? "High Risk Discard" : "Risky Discard",
    reason,
    tileName: faceName(face),
    bestName: faceName(bestFace),
  };
}
