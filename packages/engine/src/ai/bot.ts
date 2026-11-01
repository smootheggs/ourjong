import { canSelfDrawWin, canWinWithMinimum, processAction } from "../moves.ts";
import type {
  ClaimKind,
  ClaimOption,
  GameAction,
  GameState,
  Player,
  SeatIndex,
} from "../types.ts";
import { assessThreat, tableViewOf } from "./danger.ts";
import {
  CLAIM_PREFERENCE,
  bestDiscard,
  bestDiscardExpert,
  bestDiscardFaan,
  checkFaanClaim,
  chooseKongDeclaration,
  handFaanDistance,
  shantenAfterClaim,
  stanceOf,
} from "./evaluate.ts";
import type { FaanContext } from "./patterns.ts";
import { calcShanten } from "./shanten.ts";

/**
 * How well a bot plays.
 *   1  Novice: shanten only. Discards whatever leaves the hand closest to winning and takes
 *      any chow, pung or kong that gets it closer, with no thought for fan.
 *   2  Faan Hunter: plays for a hand worth the 3-fan minimum (a flush, All Pongs, honor pungs),
 *      throws what does not serve it, and refuses any claim that would spoil it.
 *   3  Expert: Level 2 plus defense. It reads the rivers and open melds for how dangerous
 *      each tile is, and when the wall is low or someone has three open melds it folds:
 *      if it is far from a winning hand it throws the safest tile, breaking its own hand,
 *      and stops claiming.
 *
 * Every level declares its own concealed and added kongs when that does not set it back; Levels
 * 2 and 3 also need the kong to leave their 3-fan plan intact.
 */
export type BotLevel = 1 | 2 | 3;

export interface BotOptions {
  /** Epoch ms stamped on the action (the engine only uses it for turn clocks). */
  readonly timestamp?: number;
}

/**
 * Level 1 takes a claim whose best follow-up leaves the hand at most this much further from
 * winning than it is now. 0 means "never worse": it still claims when it only keeps pace, which
 * is the greedy part. Raise it to make the Novice claim even more recklessly.
 */
export const NOVICE_CLAIM_SLACK = 0;

const faanContextOf = (state: GameState, seat: SeatIndex): FaanContext => ({
  seatWind: state.players[seat].seatWind,
  prevailingWind: state.round.prevailingWind,
  minimumFan: state.rules.minimumScore,
});

function stamp(state: GameState, options: BotOptions) {
  return {
    seq: state.history.length,
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : null),
  };
}

/**
 * Level 2: among the claims on offer, the ones `checkFaanClaim` accepts, nearest to a winning
 * plan first (ties: kong, then pung, then chow). Anything that bricks the hand, or does not
 * bring it nearer a 3+ fan win, is refused, and with nothing left the bot passes.
 */
function chooseFaanClaim(state: GameState, seat: SeatIndex, options: readonly ClaimOption[]): ClaimOption | "pass" {
  const phase = state.phase;
  if (phase.type !== "claim-window") return "pass";
  const player = state.players[seat];
  const ctx = faanContextOf(state, seat);

  let best: { option: ClaimOption; after: number } | null = null;
  for (const option of options) {
    const check = checkFaanClaim(player.hand, player.melds, option, phase.tile, ctx);
    if (!check.accept) continue;
    if (
      best === null ||
      check.after < best.after ||
      (check.after === best.after && CLAIM_PREFERENCE[option.kind] < CLAIM_PREFERENCE[best.option.kind])
    ) {
      best = { option, after: check.after };
    }
  }
  return best ? best.option : "pass";
}

/**
 * Level 3: is this seat folding? A threat is on (the wall is low or someone has three open melds)
 * and the hand is more than FOLD_DISTANCE steps from a 3+ fan plan.
 */
function isFolding(state: GameState, seat: SeatIndex): boolean {
  const threat = assessThreat(state, tableViewOf(state, seat));
  if (!threat.active) return false;
  const player = state.players[seat];
  return stanceOf(handFaanDistance(player.hand, player.melds, faanContextOf(state, seat)), threat) === "fold";
}

/** The pick for one seat in an open claim window, or "pass". */
function chooseClaim(
  state: GameState,
  seat: SeatIndex,
  options: readonly ClaimOption[],
  level: BotLevel,
): ClaimOption | "pass" {
  const phase = state.phase;
  if (phase.type !== "claim-window") return "pass";
  const player = state.players[seat];

  // A bot never turns down a legal win, at any level.
  const win = options.find(
    (o) => o.kind === "win" && canWinWithMinimum(player, phase.tile, state.rules, state.round),
  );
  if (win) return win;

  const melds = options.filter((o) => o.kind !== "win");
  if (melds.length === 0 || phase.isRobbingKong) return "pass";

  if (level === 2) return chooseFaanClaim(state, seat, melds);

  if (level === 3) {
    // Folding: far from a win with the table turning dangerous, so do not open the hand up.
    if (isFolding(state, seat)) return "pass";
    return chooseFaanClaim(state, seat, melds);
  }

  // Level 1: shanten only, no fan.
  const current = calcShanten(player.hand, player.melds.length);
  let best: { option: ClaimOption; after: number } | null = null;
  for (const option of melds) {
    const after = shantenAfterClaim(player.hand, player.melds, option);
    if (after > current + NOVICE_CLAIM_SLACK) continue;
    if (
      best === null ||
      after < best.after ||
      (after === best.after && CLAIM_PREFERENCE[option.kind] < CLAIM_PREFERENCE[best.option.kind])
    ) {
      best = { option, after };
    }
  }
  return best ? best.option : "pass";
}

/**
 * What this seat should do right now, as an action ready for `processAction`; null when it
 * is not this seat's move (or the hand is over).
 *
 *   draw phase   -> draw the top tile
 *   action phase -> win if the drawn tile completes a legal hand, else discard
 *   claim window -> win / claim / pass, for this seat only
 *
 * It only reads the state. A claim window has several seats in it; `nextBotAction` is the one
 * that knows which of them should speak first.
 */
export function getBotAction(
  state: GameState,
  seat: SeatIndex,
  difficulty: BotLevel = 1,
  options: BotOptions = {},
): GameAction | null {
  const phase = state.phase;
  const base = stamp(state, options);

  if (phase.type === "draw") {
    if (phase.seat !== seat) return null;
    const top = state.wall.liveTiles[0];
    if (top === undefined) return null; // the engine ends the hand when the wall is empty
    // The engine ignores this tile and takes the real top of the wall.
    return { type: "draw", ...base, seat, tile: top, fromDeadWall: false };
  }

  if (phase.type === "action") {
    if (phase.seat !== seat) return null;
    const player = state.players[seat];

    if (canSelfDrawWin(state, seat) && player.drawnTile !== null) {
      return { type: "win", ...base, seat, method: "self-draw", winningTile: player.drawnTile };
    }

    const candidates = player.drawnTile ? [...player.hand, player.drawnTile] : [...player.hand];
    if (candidates.length === 0) return null;
    const ctx = faanContextOf(state, seat);

    // Level 3 reads the table once: the same view feeds the fold decision and the discard.
    const view = difficulty === 3 ? tableViewOf(state, seat) : null;
    const threat = view ? assessThreat(state, view) : null;

    // Own kongs (concealed, or a fourth tile for an open pung), when they do not spoil the plan.
    // A Level 3 bot that is folding keeps its tiles and plays safe instead.
    const folding =
      view !== null &&
      threat !== null &&
      stanceOf(handFaanDistance(candidates, player.melds, ctx), threat) === "fold";
    if (!folding) {
      const kong = chooseKongDeclaration(candidates, player.melds, difficulty, ctx);
      if (kong) return { type: "kong", ...base, seat, variant: kong.variant, tiles: kong.tiles };
    }

    const tile =
      view && threat
        ? bestDiscardExpert(candidates, player.melds, ctx, view, threat).tile
        : difficulty === 2
          ? bestDiscardFaan(candidates, player.melds, ctx).tile
          : bestDiscard(candidates, player.melds).tile;
    return { type: "discard", ...base, seat, tile, fromDraw: player.drawnTile?.id === tile.id };
  }

  if (phase.type === "claim-window") {
    if (phase.passed.includes(seat)) return null;
    const mine = phase.availableClaims.filter((c) => c.seat === seat);
    if (mine.length === 0) return null;

    const choice = chooseClaim(state, seat, mine, difficulty);
    return choice === "pass"
      ? { type: "pass", ...base, seat }
      : { type: "claim", ...base, seat, payload: { kind: choice.kind, usingTiles: choice.usingTiles } };
  }

  return null;
}

// Mirrors the engine's claim priority, so a bot never sends a claim that is still blocked.
const CLAIM_PRIORITY: Record<ClaimKind, number> = { chow: 1, pung: 2, kong: 2, win: 3 };

/**
 * The next action any bot should play, or null when it is a human's move (or nobody's).
 * `isBot` says which seats are automated. A claim window is the tricky case: the strongest
 * claim that no one with a higher claim is still deciding goes first, then passes; a bot
 * waits while a human could still outrank it.
 *
 * Does not cover `setup` (the first deal): the host owns that so it can wait for the dice.
 */
export function nextBotAction(
  state: GameState,
  isBot: (seat: SeatIndex) => boolean,
  difficulty: BotLevel | ((player: Player) => BotLevel) = 1,
  options: BotOptions = {},
): GameAction | null {
  const levelOf = (seat: SeatIndex): BotLevel =>
    typeof difficulty === "function" ? difficulty(state.players[seat]) : difficulty;
  const phase = state.phase;

  if (phase.type === "draw" || phase.type === "action") {
    return isBot(phase.seat) ? getBotAction(state, phase.seat, levelOf(phase.seat), options) : null;
  }

  if (phase.type !== "claim-window") return null;

  const seats = [
    ...new Set(
      phase.availableClaims.map((c) => c.seat).filter((s) => isBot(s) && !phase.passed.includes(s)),
    ),
  ];
  const decisions = seats.flatMap((seat) => {
    const action = getBotAction(state, seat, levelOf(seat), options);
    return action ? [action] : [];
  });

  const blocked = (seat: SeatIndex, kind: ClaimKind) =>
    phase.availableClaims.some(
      (c) =>
        c.seat !== seat && !phase.passed.includes(c.seat) && CLAIM_PRIORITY[c.kind] > CLAIM_PRIORITY[kind],
    );

  const claims = decisions
    .flatMap((a) => (a.type === "claim" ? [a] : []))
    .sort((a, b) => CLAIM_PRIORITY[b.payload.kind] - CLAIM_PRIORITY[a.payload.kind])
    .filter((a) => !blocked(a.seat, a.payload.kind));
  if (claims.length > 0) return claims[0];

  return decisions.find((a) => a.type === "pass") ?? null;
}

/**
 * Plays every bot move in a row until a human has to act, the hand ends, or `maxSteps` is
 * reached. Pure: returns the new state. Handy for tests, simulations and a bots-only table.
 */
export function runBots(
  state: GameState,
  isBot: (seat: SeatIndex) => boolean = () => true,
  difficulty: BotLevel | ((player: Player) => BotLevel) = 1,
  maxSteps = 2000,
): { state: GameState; steps: number } {
  let current = state;
  let steps = 0;
  while (steps < maxSteps) {
    const action = nextBotAction(current, isBot, difficulty);
    if (action === null) break;
    current = processAction(current, action);
    steps++;
  }
  return { state: current, steps };
}
