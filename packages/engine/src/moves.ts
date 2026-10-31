import {
  canChow,
  canWin,
  getHiddenKongs,
  getPromotedKongs,
  kongTiles,
  pongTiles,
} from "./evaluator.ts";
import { dealNextHand } from "./game.ts";
import { applyPayments, calculateFan, patternLabels, settleWin } from "./scoring.ts";
import type {
  ClaimAction,
  ClaimOption,
  DiscardAction,
  DrawAction,
  GameAction,
  GameState,
  KongAction,
  MatchStatus,
  Meld,
  PassAction,
  Player,
  RoundInfo,
  RuleSetConfig,
  ScoringResult,
  SeatIndex,
  SystemAction,
  Tile,
  Wall,
  WinAction,
  WindName,
} from "./types.ts";

/**
 * Pure reducer: returns a new GameState and never mutates its input.
 * Supports system "hand-start" and "round-advance" (next hand), "draw", "discard", "pass",
 * "claim", "kong" and a self-draw "win";
 * anything else throws. Replacement draws keep the dead wall topped up from the live wall,
 * and an added kong can be robbed by a win before it completes.
 */
export function processAction(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "system":
      if (action.event === "hand-start") return handleHandStart(state, action);
      if (action.event === "round-advance") return handleRoundAdvance(state, action);
      throw new Error(`Unsupported system event: ${action.event}`);
    case "draw":
      return handleDraw(state, action);
    case "discard":
      return handleDiscard(state, action);
    case "pass":
      return handlePass(state, action);
    case "claim":
      return handleClaim(state, action);
    case "kong":
      return handleKong(state, action);
    case "win":
      return handleSelfDrawWin(state, action);
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

const nextSeat = (state: GameState, seat: SeatIndex): SeatIndex =>
  ((seat + 1) % state.rules.playerCount) as SeatIndex;

/**
 * Hands the turn to `seat` for a normal draw, or ends the hand if there is nothing left to draw.
 * Every route into the "draw" phase goes through here: when the live wall is empty the next
 * player cannot draw, so the hand is an exhaustive draw (流局, "huangpai") with no winner.
 * The dead wall is never drawn from for a normal draw, so it does not count.
 */
function startDraw(state: GameState, seat: SeatIndex): GameState {
  const next = { ...state, currentTurn: seat };
  return state.wall.liveTiles.length === 0
    ? { ...next, phase: { type: "hand-end", reason: "exhaustive-draw" } }
    : { ...next, phase: { type: "draw", seat } };
}

/* ---------- Clocks ---------- */

/** Suggested clocks for online play: put them in the rules as `turnTimeMs` / `claimTimeMs`. */
export const TURN_TIME_MS = 15_000;
export const CLAIM_TIME_MS = 7_000;

/**
 * `{ deadline }` for a phase that opens at `at` (the opening action's timestamp) with a clock of
 * `ms`, or nothing when there is no clock or no timestamp. The reducer never reads the real
 * time itself, so it stays deterministic: the host supplies the timestamp and enforces the
 * deadline.
 */
const clockOf = (at: number | undefined, ms: number | undefined): { deadline?: number } =>
  at !== undefined && Number.isFinite(at) && ms !== undefined && ms > 0
    ? { deadline: at + ms }
    : {};

const turnClock = (state: GameState, at: number | undefined) => clockOf(at, state.rules.turnTimeMs);
const claimClock = (state: GameState, at: number | undefined) =>
  clockOf(at, state.rules.claimTimeMs);

/* ---------- The match: dealership and rounds ---------- */

const ROUND_WINDS: readonly WindName[] = ["east", "south", "west", "north"];
const DEFAULT_MATCH_ROUNDS = 2; // East round, then South round

const matchRoundsOf = (rules: RuleSetConfig): number => {
  const rounds = rules.matchRounds;
  return rounds !== undefined && Number.isInteger(rounds) && rounds >= 1 && rounds <= 4
    ? rounds
    : DEFAULT_MATCH_ROUNDS;
};

/**
 * Where the match goes after the hand that just ended, or null if that was the last hand.
 *
 * HKOS dealership:
 * - the dealer wins, or the hand is drawn: the dealer keeps the dealership (repeat);
 * - anyone else wins: the dealership passes to the next seat;
 * - when it passes seat 3 back to seat 0 the round is over and the round wind advances
 *   (East, then South, ...), and after the last round the match is over.
 */
export function nextRoundInfo(state: GameState): RoundInfo | null {
  const phase = state.phase;
  if (phase.type !== "hand-end") {
    throw new Error(`The next round is only known once a hand has ended, not in "${phase.type}"`);
  }
  const round = state.round;

  // A winner who is not the dealer takes the dealership away. No winner (a draw) or a dealer
  // win keeps it. With several winners on one discard, the dealer among them keeps it.
  const dealerStays = !phase.winners?.length || phase.winners.includes(round.dealerSeat);
  if (dealerStays) {
    return { ...round, handNumber: round.handNumber + 1, dealerRepeats: round.dealerRepeats + 1 };
  }

  const dealerSeat = ((round.dealerSeat + 1) % state.rules.playerCount) as SeatIndex;
  if (dealerSeat !== 0) {
    return { ...round, dealerSeat, handNumber: round.handNumber + 1, dealerRepeats: 0 };
  }

  // The dealership has been all the way round: the next round wind, or the end of the match.
  const windIndex = ROUND_WINDS.indexOf(round.prevailingWind) + 1;
  const wind = ROUND_WINDS[windIndex];
  if (wind === undefined || windIndex >= matchRoundsOf(state.rules)) return null;
  return { ...round, prevailingWind: wind, dealerSeat: 0, handNumber: 1, dealerRepeats: 0 };
}

/** The match at a glance, for a scoreboard. Works in every phase. */
export function matchStatus(state: GameState): MatchStatus {
  const { round } = state;
  const next = state.phase.type === "hand-end" ? nextRoundInfo(state) : undefined;
  return {
    prevailingWind: round.prevailingWind,
    dealerSeat: round.dealerSeat,
    handNumber: round.handNumber,
    dealerRepeats: round.dealerRepeats,
    totalRounds: matchRoundsOf(state.rules),
    roundNumber: ROUND_WINDS.indexOf(round.prevailingWind) + 1,
    matchEndsNext: next === null,
    next:
      next === undefined || next === null
        ? null
        : {
            prevailingWind: next.prevailingWind,
            dealerSeat: next.dealerSeat,
            dealerStays: next.dealerSeat === round.dealerSeat,
          },
  };
}

/**
 * "Next Hand". After a hand: deal the next one with the dealership moved as the rules say, or
 * end the match (phase "game-end") if that was the last. After the match: start a new one, East
 * round with seat 0 as dealer and every score back to zero. The new wall comes from `payload.seed` if the
 * caller gives one (a server must: it is secret), else from the old seed so replays still work.
 */
function handleRoundAdvance(state: GameState, action: SystemAction): GameState {
  const phase = state.phase;
  if (phase.type !== "hand-end" && phase.type !== "game-end") {
    throw new Error(`round-advance is only valid once a hand has ended, not in "${phase.type}"`);
  }

  const given = action.payload?.seed;
  const seed = typeof given === "string" && given !== "" ? given : `${state.random.seed}-next`;

  if (phase.type === "game-end") {
    const first: RoundInfo = {
      prevailingWind: "east",
      dealerSeat: 0,
      handNumber: 1,
      dealerRepeats: 0,
      scores: [0, 0, 0, 0],
    };
    return dealNextHand(state, first, seed);
  }

  const next = nextRoundInfo(state);
  if (next === null) {
    return { ...state, phase: { type: "game-end" }, history: [...state.history, action] };
  }
  return dealNextHand(state, next, seed);
}

function handleHandStart(state: GameState, action: SystemAction): GameState {
  if (state.phase.type !== "setup") {
    throw new Error(`hand-start is only valid in the setup phase, not "${state.phase.type}"`);
  }

  const seat = state.currentTurn;
  const [tile, ...liveTiles] = state.wall.liveTiles;
  if (tile === undefined) {
    throw new Error("Cannot draw: live wall is empty");
  }

  // Timestamps are optional and never generated here, so the reducer stays deterministic.
  // A caller may supply one via the system action's payload.
  const ts = action.payload?.timestamp;
  const timestamp = typeof ts === "number" ? ts : undefined;

  const draw: DrawAction = {
    type: "draw",
    seq: state.history.length,
    seat,
    ...(timestamp !== undefined ? { timestamp } : {}),
    tile,
    fromDeadWall: false,
  };

  return {
    ...state,
    phase: { type: "action", seat, ...turnClock(state, timestamp) },
    wall: {
      ...state.wall,
      liveTiles,
      drawCount: state.wall.drawCount + 1,
    },
    players: state.players.map((p) => (p.seat === seat ? { ...p, drawnTile: tile } : p)),
    history: [...state.history, draw],
  };
}

/**
 * Normal draw from the front of the live wall during the "draw" phase.
 * The tile on the incoming action is not trusted: the engine takes the real top tile
 * and records that one in history.
 */
function handleDraw(state: GameState, action: DrawAction): GameState {
  const phase = state.phase;
  if (phase.type !== "draw") {
    throw new Error(`draw is only valid in the draw phase, not "${state.phase.type}"`);
  }

  const seat = state.currentTurn;
  if (phase.seat !== seat) {
    throw new Error(`Draw phase belongs to seat ${phase.seat}, not the current turn (${seat})`);
  }
  if (action.seat !== seat) {
    throw new Error(`Seat ${action.seat} cannot draw on seat ${seat}'s turn`);
  }
  if (action.fromDeadWall) {
    throw new Error("Dead-wall draws only happen as the replacement after a kong");
  }
  if (state.players[seat].drawnTile !== null) {
    throw new Error("Player already holds a drawn tile");
  }

  const [tile, ...liveTiles] = state.wall.liveTiles;
  if (tile === undefined) {
    throw new Error("Cannot draw: live wall is empty");
  }

  const recorded: DrawAction = { ...action, tile, fromDeadWall: false };

  return {
    ...state,
    phase: { type: "action", seat, ...turnClock(state, action.timestamp) },
    wall: {
      ...state.wall,
      liveTiles,
      drawCount: state.wall.drawCount + 1,
    },
    players: state.players.map((p) => (p.seat === seat ? { ...p, drawnTile: tile } : p)),
    history: [...state.history, recorded],
  };
}

/* ---------- The minimum-fan rule ---------- */

/**
 * Fan the seat would score by winning on `tile`, which joins its concealed hand (13 tiles
 * minus three per meld). Zero when the tiles do not form a complete hand.
 */
export function seatFanForWin(player: Player, tile: Tile, round: RoundInfo): number {
  return calculateFan(
    [...player.hand],
    [...player.melds],
    tile,
    player.seatWind,
    round.prevailingWind,
  ).totalFan;
}

/**
 * Hong Kong Old Style's defining rule: a hand may only win with at least
 * `rules.minimumScore` fan (3). A complete hand that scores less is not a win, so no win
 * claim is ever generated for it.
 */
export function canWinWithMinimum(
  player: Player,
  tile: Tile,
  rules: RuleSetConfig,
  round: RoundInfo,
): boolean {
  return canWin(player.hand, tile) && seatFanForWin(player, tile, round) >= rules.minimumScore;
}

/**
 * Can this seat declare a self-drawn win on the tile it just drew? True only when the draw
 * completes the hand AND the hand scores at least the minimum fan. (The reducer has no
 * self-draw win action yet; this is the check it, the UI and the bots should use.)
 */
export function canSelfDrawWin(state: GameState, seat: SeatIndex): boolean {
  const player = state.players[seat];
  return (
    player.drawnTile !== null &&
    canWinWithMinimum(player, player.drawnTile, state.rules, state.round)
  );
}

/** What `seat` scores by winning on `tile`, which has not joined its concealed hand yet. */
function scoreClaimedWin(state: GameState, seat: SeatIndex, tile: Tile): ScoringResult {
  const player = state.players[seat];
  return calculateFan(
    [...player.hand],
    [...player.melds],
    tile,
    player.seatWind,
    state.round.prevailingWind,
  );
}

/**
 * Ends the hand on a win and settles the money: the fan sets the payout. The payments go into the hand-end phase (so the
 * result card can list them) and into `round.scores`, with `Player.score` kept equal to it.
 */
function endHandWithWin(
  state: GameState,
  end: {
    reason: "win-self-draw" | "win-discard" | "robbing-kong";
    winner: SeatIndex;
    /** The seat that pays alone; omitted for a self-draw, where everyone pays. */
    chucker?: SeatIndex;
    winningTile?: Tile;
    /** What the hand scored; it sets the payout. */
    result: ScoringResult;
  },
  players: Player[],
  currentTurn: SeatIndex,
  history: GameAction[],
): GameState {
  const payments = settleWin(state.rules.playerCount, {
    winners: [end.winner],
    selfDrawn: end.reason === "win-self-draw",
    ...(end.chucker !== undefined ? { chucker: end.chucker } : {}),
    result: end.result,
  });
  const scores = applyPayments(state.round.scores, payments);

  return {
    ...state,
    currentTurn,
    round: { ...state.round, scores },
    players: players.map((p) => ({ ...p, score: scores[p.seat] ?? 0 })),
    phase: {
      type: "hand-end",
      reason: end.reason,
      winners: [end.winner],
      ...(end.winningTile !== undefined ? { winningTile: end.winningTile } : {}),
      result: end.result,
      totalFan: end.result.totalFan,
      patterns: patternLabels(end.result),
      payments,
    },
    history,
  };
}

/**
 * A self-drawn win: the active player declares a win on the tile they just drew. The hand
 * must be complete AND score at least the minimum fan. The hand ends as "win-self-draw",
 * recording the winner, the winning tile (now part of their hand) and the Fan result.
 */
function handleSelfDrawWin(state: GameState, action: WinAction): GameState {
  const phase = state.phase;
  if (action.method !== "self-draw") {
    throw new Error(`A ${action.method} win is claimed with a claim action, not a win action`);
  }
  if (phase.type !== "action" || phase.seat !== action.seat) {
    throw new Error("A self-draw win is only valid in the winner's own action phase");
  }

  const seat = action.seat;
  const player = state.players[seat];
  const tile = player.drawnTile;
  if (tile === null) {
    throw new Error("Cannot win by self-draw without a drawn tile");
  }
  if (action.winningTile.id !== tile.id) {
    throw new Error("The winning tile must be the tile just drawn");
  }
  if (!canWin(player.hand, tile)) {
    throw new Error("The hand is not complete");
  }

  const result = calculateFan(
    [...player.hand],
    [...player.melds],
    tile,
    player.seatWind,
    state.round.prevailingWind,
  );
  if (result.totalFan < state.rules.minimumScore) {
    throw new Error(
      `Minimum ${state.rules.minimumScore} fan required to win (this hand scores ${result.totalFan})`,
    );
  }

  return endHandWithWin(
    state,
    { reason: "win-self-draw", winner: seat, winningTile: tile, result },
    state.players.map((p) =>
      p.seat === seat ? { ...p, hand: [...p.hand, tile], drawnTile: null } : p,
    ),
    seat,
    [...state.history, action],
  );
}

/**
 * Every claim the other seats could make on a discard, in seat order after the discarder.
 * Per seat: win, pung, kong, then each chow combination. Chows are only offered to the seat
 * immediately after the discarder when the rules say "left-only".
 */
function findClaims(
  players: readonly Player[],
  discarder: SeatIndex,
  tile: Tile,
  rules: RuleSetConfig,
  round: RoundInfo,
): ClaimOption[] {
  const claims: ClaimOption[] = [];

  for (let offset = 1; offset < rules.playerCount; offset++) {
    const seat = ((discarder + offset) % rules.playerCount) as SeatIndex;
    const hand = players[seat].hand;

    // A complete hand under the minimum fan may not win, so it gets no win option.
    if (canWinWithMinimum(players[seat], tile, rules, round)) {
      claims.push({ seat, kind: "win", usingTiles: [] });
    }

    const pong = pongTiles(hand, tile);
    if (pong.length === 2) {
      claims.push({ seat, kind: "pung", usingTiles: pong });
    }

    const kong = kongTiles(hand, tile);
    if (kong.length === 3) {
      claims.push({ seat, kind: "kong", usingTiles: kong });
    }

    const mayChow = rules.allowedChows && (rules.chowFrom === "any" || offset === 1);
    if (mayChow) {
      for (const combo of canChow(hand, tile)) {
        claims.push({ seat, kind: "chow", usingTiles: combo });
      }
    }
  }

  return claims;
}

function handleDiscard(state: GameState, action: DiscardAction): GameState {
  const seat = state.currentTurn;

  if (state.phase.type !== "action" || state.phase.seat !== seat) {
    throw new Error("Discard is only valid during the active player's action phase");
  }
  if (action.seat !== seat) {
    throw new Error(`Seat ${action.seat} cannot discard on seat ${seat}'s turn`);
  }

  const player = state.players[seat];
  const { hand, fromDraw } = removeTile(player, action.tile);

  // Discard order is counted across the whole hand, not per player.
  const order = state.players.reduce((n, p) => n + p.discards.length, 0);

  const players = state.players.map((p) =>
    p.seat === seat
      ? {
          ...p,
          hand,
          drawnTile: null,
          discards: [...p.discards, { tile: action.tile, order, fromDraw }],
        }
      : p,
  );

  const base = {
    ...state,
    players,
    lastDiscard: { tile: action.tile, by: seat },
    history: [...state.history, action],
  };

  const availableClaims = findClaims(players, seat, action.tile, state.rules, state.round);

  // Nobody can claim: skip the claim window and go straight to the next player's draw.
  if (availableClaims.length === 0) {
    return startDraw(base, nextSeat(state, seat));
  }

  return {
    ...base,
    phase: {
      type: "claim-window",
      discardedBy: seat,
      tile: action.tile,
      availableClaims,
      passed: [],
      ...claimClock(state, action.timestamp),
    },
  };
}

/**
 * A seat passes on the open claim window.
 * - With no claim options (a hand-built window), one pass from any seat other than the
 *   discarder closes it.
 * - Otherwise every seat that has an available claim must pass before it closes.
 * Closing the window advances the turn to the seat after the discarder and enters "draw".
 */
function handlePass(state: GameState, action: PassAction): GameState {
  const phase = state.phase;
  if (phase.type !== "claim-window") {
    throw new Error(`pass is only valid in a claim window, not "${state.phase.type}"`);
  }
  const last = state.lastDiscard;
  if (!phase.isRobbingKong && last === null) {
    throw new Error("Claim window is open but there is no last discard");
  }

  const passer = action.seat;
  const eligible = Array.from(new Set(phase.availableClaims.map((c) => c.seat)));

  if (eligible.length === 0) {
    if (passer === phase.discardedBy) {
      throw new Error("The discarding seat cannot pass on its own discard");
    }
  } else if (!eligible.includes(passer)) {
    throw new Error(`Seat ${passer} has no claim to pass on`);
  }
  if (phase.passed.includes(passer)) {
    throw new Error(`Seat ${passer} has already passed`);
  }

  const passed = [...phase.passed, passer];
  const history = [...state.history, action];
  const everyonePassed = eligible.every((seat) => passed.includes(seat));

  if (!everyonePassed) {
    return { ...state, phase: { ...phase, passed }, history };
  }

  // Nobody robbed the kong: it completes and the declarer draws their replacement.
  if (phase.isRobbingKong) {
    if (phase.pendingKong === undefined) {
      throw new Error("Robbing-kong window has no pending kong");
    }
    return finishKong(
      state,
      phase.pendingKong,
      planKong(state, phase.pendingKong),
      history,
      action.timestamp,
    );
  }

  return startDraw({ ...state, history }, nextSeat(state, (last as NonNullable<typeof last>).by));
}

/** Higher beats lower: a win outranks a pung or kong, which outrank a chow. */
const CLAIM_PRIORITY = { chow: 1, pung: 2, kong: 2, win: 3 } as const;

const sameTiles = (a: readonly Tile[], b: readonly Tile[]): boolean => {
  if (a.length !== b.length) return false;
  const ids = (tiles: readonly Tile[]) => tiles.map((t) => t.id).sort((x, y) => x - y);
  const [ia, ib] = [ids(a), ids(b)];
  return ia.every((id, i) => id === ib[i]);
};

const rankOf = (tile: Tile): number => (tile.face.kind === "suit" ? tile.face.rank : 0);

/**
 * Replacement draw after a kong: the last tile of the dead wall (the back of the wall),
 * and `deadDrawCount` goes up.
 *
 * Dead wall balancing: the dead wall is always the final `deadWallSize` tiles of the wall,
 * so after a draw the last tile of the live wall joins its front, keeping it at exactly
 * `deadWallSize` tiles (replacements keep coming from the back). When the live wall is
 * already empty there is nothing to move and the dead wall simply shrinks.
 */
function takeDeadWallTile(wall: Wall): { tile: Tile; wall: Wall } {
  const tile = wall.deadWall[wall.deadWall.length - 1];
  if (tile === undefined) {
    throw new Error("Cannot draw a replacement tile: the dead wall is empty");
  }

  const remainingDead = wall.deadWall.slice(0, -1);
  const lastLive = wall.liveTiles[wall.liveTiles.length - 1];
  const balanced = lastLive !== undefined;

  return {
    tile,
    wall: {
      ...wall,
      liveTiles: balanced ? wall.liveTiles.slice(0, -1) : wall.liveTiles,
      deadWall: balanced ? [lastLive, ...remainingDead] : remainingDead,
      deadDrawCount: wall.deadDrawCount + 1,
    },
  };
}

/** The history entry for a dead-wall replacement draw. */
function replacementDrawOf(
  seq: number,
  seat: SeatIndex,
  tile: Tile,
  timestamp: number | undefined,
): DrawAction {
  return {
    type: "draw",
    seq,
    seat,
    ...(timestamp !== undefined ? { timestamp } : {}),
    tile,
    fromDeadWall: true,
  };
}

/**
 * A seat claims the discard. The claim must be one of the phase's available claims, the
 * seat must not have passed, and no higher-priority claim from a seat that has yet to pass
 * may be outstanding.
 * - chow / pung: the claimer melds the discard with `usingTiles`, takes the turn and must
 *   discard next (no draw).
 * - kong: same, then the claimer draws a replacement from the dead wall before discarding.
 * - win: the discard joins the winner's hand and the hand ends.
 */
function handleClaim(state: GameState, action: ClaimAction): GameState {
  const phase = state.phase;
  if (phase.type !== "claim-window") {
    throw new Error(`claim is only valid in a claim window, not "${state.phase.type}"`);
  }

  const seat = action.seat;
  const { kind, usingTiles } = action.payload;

  if (phase.isRobbingKong && kind !== "win") {
    throw new Error("Only a win can be claimed against an added kong");
  }
  if (phase.passed.includes(seat)) {
    throw new Error(`Seat ${seat} has already passed`);
  }

  const available = phase.availableClaims.some(
    (c) => c.seat === seat && c.kind === kind && sameTiles(c.usingTiles, usingTiles),
  );
  if (!available) {
    throw new Error(`Seat ${seat} has no matching ${kind} claim on this discard`);
  }

  const blocked = phase.availableClaims.some(
    (c) =>
      c.seat !== seat &&
      !phase.passed.includes(c.seat) &&
      CLAIM_PRIORITY[c.kind] > CLAIM_PRIORITY[kind],
  );
  if (blocked) {
    throw new Error("A higher-priority claim is still pending");
  }

  const tile = phase.tile;
  const history = [...state.history, action];

  // Robbing the kong: the winner takes the tile being added, and the kong never happens.
  if (phase.isRobbingKong) {
    const declarer = phase.discardedBy;
    return endHandWithWin(
      state,
      {
        reason: "robbing-kong",
        winner: seat,
        chucker: declarer,
        winningTile: tile,
        result: scoreClaimedWin(state, seat, tile),
      },
      state.players.map((p) => {
        if (p.seat === seat) return { ...p, hand: [...p.hand, tile] };
        if (p.seat !== declarer) return p;
        return p.drawnTile?.id === tile.id
          ? { ...p, drawnTile: null }
          : { ...p, hand: p.hand.filter((t) => t.id !== tile.id) };
      }),
      seat,
      history,
    );
  }

  // The discard leaves the river whichever way it is claimed.
  const markClaimed = (p: Player): Player =>
    p.seat === phase.discardedBy
      ? {
          ...p,
          discards: p.discards.map((d) => (d.tile.id === tile.id ? { ...d, claimedBy: seat } : d)),
        }
      : p;

  if (kind === "win") {
    const ended = endHandWithWin(
      state,
      {
        reason: "win-discard",
        winner: seat,
        chucker: phase.discardedBy,
        result: scoreClaimedWin(state, seat, tile),
      },
      state.players.map((p) =>
        p.seat === seat ? { ...p, hand: [...p.hand, tile] } : markClaimed(p),
      ),
      seat,
      history,
    );
    return { ...ended, lastDiscard: null };
  }

  const used = new Set(usingTiles.map((t) => t.id));
  const meldTiles =
    kind === "chow"
      ? [...usingTiles, tile].sort((a, b) => rankOf(a) - rankOf(b))
      : [...usingTiles, tile];

  const meld: Meld = {
    type: kind,
    tiles: meldTiles,
    claimedTile: tile,
    claimedFrom: phase.discardedBy,
    ...(kind === "kong" ? { kongVariant: "exposed" as const } : {}),
    isOpen: true,
    createdAtActionSeq: action.seq,
  };

  const players = state.players.map((p) =>
    p.seat === seat
      ? { ...p, hand: p.hand.filter((t) => !used.has(t.id)), melds: [...p.melds, meld] }
      : markClaimed(p),
  );

  if (kind !== "kong") {
    return {
      ...state,
      currentTurn: seat,
      lastDiscard: null,
      players,
      phase: { type: "action", seat, ...turnClock(state, action.timestamp) },
      history,
    };
  }

  // Exposed kong: replacement draw from the back of the wall, then back to the action phase.
  const replacement = takeDeadWallTile(state.wall);
  return {
    ...state,
    currentTurn: seat,
    lastDiscard: null,
    wall: replacement.wall,
    players: players.map((p) => (p.seat === seat ? { ...p, drawnTile: replacement.tile } : p)),
    phase: { type: "action", seat, afterKong: true, ...turnClock(state, action.timestamp) },
    history: [
      ...history,
      replacementDrawOf(history.length, seat, replacement.tile, action.timestamp),
    ],
  };
}

/** What a kong declaration does to the declarer's tiles, worked out before anything changes. */
interface KongPlan {
  /** Concealed tiles after the kong (any unused drawn tile is concealed hand again). */
  readonly remaining: Tile[];
  readonly melds: Meld[];
  /** The tile added to an open pung (added kongs only); this is what can be robbed. */
  readonly addedTile: Tile | null;
}

/** Validates a concealed or added kong for the current seat and computes its effect. */
function planKong(state: GameState, action: KongAction): KongPlan {
  const seat = state.currentTurn;
  if (action.variant === "exposed") {
    throw new Error("An exposed kong is claimed from a discard with a claim action");
  }

  const player = state.players[seat];
  // Hand plus drawn tile: a kong may use either.
  const held = player.drawnTile !== null ? [...player.hand, player.drawnTile] : player.hand;

  let used: readonly Tile[];
  let melds: Meld[];
  let addedTile: Tile | null = null;

  if (action.variant === "concealed") {
    const group = getHiddenKongs(held).find((g) => sameTiles(g, action.tiles));
    if (group === undefined) {
      throw new Error("Those tiles are not four identical tiles in the player's hand");
    }
    used = group;
    melds = [
      ...player.melds,
      {
        type: "kong",
        tiles: group,
        isOpen: false,
        kongVariant: "concealed",
        createdAtActionSeq: action.seq,
      },
    ];
  } else {
    if (action.tiles.length !== 1) {
      throw new Error("An added kong takes exactly one tile");
    }
    const option = getPromotedKongs(held, player.melds).find(
      (o) => o.tile.id === action.tiles[0].id,
    );
    if (option === undefined) {
      throw new Error("That tile does not match any of the player's open pungs");
    }
    used = [option.tile];
    addedTile = option.tile;
    const promoted: Meld = {
      ...option.meld,
      type: "kong",
      tiles: [...option.meld.tiles, option.tile],
      kongVariant: "added",
      createdAtActionSeq: action.seq,
    };
    melds = player.melds.map((m) => (m === option.meld ? promoted : m));
  }

  const usedIds = new Set(used.map((t) => t.id));
  return { remaining: held.filter((t) => !usedIds.has(t.id)), melds, addedTile };
}

/**
 * Completes a kong: applies the plan, draws the replacement from the dead wall (balancing
 * it from the live wall) and puts the declarer back in the action phase. `history` already
 * holds the kong declaration (and any passes); the replacement draw is appended to it.
 */
function finishKong(
  state: GameState,
  action: KongAction,
  plan: KongPlan,
  history: GameAction[],
  // When the replacement is drawn: the kong's own timestamp, or the last pass that let it through.
  at: number | undefined = action.timestamp,
): GameState {
  const seat = state.currentTurn;
  const replacement = takeDeadWallTile(state.wall);

  return {
    ...state,
    wall: replacement.wall,
    players: state.players.map((p) =>
      p.seat === seat
        ? { ...p, hand: plan.remaining, drawnTile: replacement.tile, melds: plan.melds }
        : p,
    ),
    phase: { type: "action", seat, afterKong: true, ...turnClock(state, at) },
    history: [...history, replacementDrawOf(history.length, seat, replacement.tile, at)],
  };
}

/** Seats that could win on the tile being added to a kong (win is the only claim allowed). */
function findKongRobbers(
  players: readonly Player[],
  declarer: SeatIndex,
  tile: Tile,
  rules: RuleSetConfig,
  round: RoundInfo,
): ClaimOption[] {
  const claims: ClaimOption[] = [];
  for (let offset = 1; offset < rules.playerCount; offset++) {
    const seat = ((declarer + offset) % rules.playerCount) as SeatIndex;
    if (canWinWithMinimum(players[seat], tile, rules, round)) {
      claims.push({ seat, kind: "win", usingTiles: [] });
    }
  }
  return claims;
}

/**
 * A concealed or added kong on the active player's own turn.
 * - concealed: `tiles` must be four identical tiles from the hand / drawn tile.
 * - added: `tiles` must be the single fourth tile for one of the player's open pungs.
 *
 * A concealed kong completes at once. An added kong can be robbed: if any opponent could
 * win on the added tile, a claim window opens (`isRobbingKong`, wins only) and the kong
 * waits in `pendingKong`.
 * - a win ends the hand as "robbing-kong" and the kong never happens;
 * - if every seat passes, the kong completes (see handlePass).
 * When nobody could win the window is skipped and the kong completes immediately.
 *
 * Completing a kong draws a replacement from the dead wall, leaving the player in the
 * action phase (`afterKong`). Exposed kongs come from a discard and are claimed with a
 * ClaimAction instead.
 */
function handleKong(state: GameState, action: KongAction): GameState {
  const phase = state.phase;
  if (phase.type !== "action") {
    throw new Error(`kong is only valid in the action phase, not "${state.phase.type}"`);
  }

  const seat = state.currentTurn;
  if (phase.seat !== seat || action.seat !== seat) {
    throw new Error(`Seat ${action.seat} cannot declare a kong on seat ${seat}'s turn`);
  }

  const plan = planKong(state, action);
  const history = [...state.history, action];

  if (plan.addedTile !== null) {
    const robbers = findKongRobbers(state.players, seat, plan.addedTile, state.rules, state.round);
    if (robbers.length > 0) {
      return {
        ...state,
        phase: {
          type: "claim-window",
          discardedBy: seat,
          tile: plan.addedTile,
          availableClaims: robbers,
          passed: [],
          isRobbingKong: true,
          pendingKong: action,
          ...claimClock(state, action.timestamp),
        },
        history,
      };
    }
  }

  return finishKong(state, action, plan, history);
}

/**
 * Removes the tile (matched by unique id) from the drawn tile or the hand.
 * If a hand tile is discarded, the drawn tile (if any) joins the hand.
 */
function removeTile(player: Player, tile: Tile): { hand: Tile[]; fromDraw: boolean } {
  if (player.drawnTile !== null && player.drawnTile.id === tile.id) {
    return { hand: [...player.hand], fromDraw: true };
  }

  if (!player.hand.some((t) => t.id === tile.id)) {
    throw new Error(`Tile ${tile.id} is not in the player's hand or drawn tile`);
  }

  const hand = player.hand.filter((t) => t.id !== tile.id);
  if (player.drawnTile !== null) hand.push(player.drawnTile);
  return { hand, fromDraw: false };
}
