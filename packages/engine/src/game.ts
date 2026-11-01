import type {
  DragonName,
  GameState,
  Player,
  RuleSetConfig,
  SeatIndex,
  SuitName,
  SuitRank,
  Tile,
  TileFace,
  WindName,
} from "./types.ts";

/**
 * Game setup for Hong Kong Old Style: builds the tile set, shuffles the wall with a seeded
 * generator (the same seed always gives the same deal) and deals the opening hands.
 *
 * The result is the state BEFORE play starts: phase "setup", East to act. The first
 * "hand-start" system action then draws the dealer's 14th tile.
 */

/** Hong Kong Old Style: 136 tiles (no flowers), 4 players, 16-tile dead wall, 3 fan to win. */
export const HKOS_RULES: RuleSetConfig = {
  id: "hk-old-style",
  playerCount: 4,
  tileSet: {
    suits: ["bamboo", "characters", "dots"],
    includeWinds: true,
    includeDragons: true,
    includeFlowers: false,
    includeSeasons: false,
    copiesPerFace: 4,
  },
  handSize: 13,
  deadWallSize: 16,
  allowedChows: true,
  chowFrom: "left-only",
  multipleWinsOnDiscard: "head-bump",
  minimumScore: 3,
  scoringSystem: "hk-fan",
  options: {},
};

const SEAT_WINDS: readonly WindName[] = ["east", "south", "west", "north"];
const DRAGONS: readonly DragonName[] = ["red", "green", "white"];
const RANKS: readonly SuitRank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/* ---------- Seeded randomness ---------- */

/** Turns any string into a 32-bit seed (xmur3). */
export function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Small, fast, deterministic generator returning numbers in [0, 1) (mulberry32). */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- The wall ---------- */

/** Every tile of the set, in a fixed order, with stable ids 0..135. */
function buildTileSet(rules: RuleSetConfig): Tile[] {
  const { tileSet } = rules;
  const faces: TileFace[] = [];

  for (const suit of tileSet.suits as readonly SuitName[]) {
    for (const rank of RANKS) faces.push({ kind: "suit", suit, rank });
  }
  if (tileSet.includeWinds) {
    for (const wind of SEAT_WINDS) faces.push({ kind: "wind", wind });
  }
  if (tileSet.includeDragons) {
    for (const dragon of DRAGONS) faces.push({ kind: "dragon", dragon });
  }

  const tiles: Tile[] = [];
  for (const face of faces) {
    for (let copy = 0; copy < tileSet.copiesPerFace; copy++) {
      tiles.push({ id: tiles.length, face, copy });
    }
  }
  return tiles;
}

/** Fisher-Yates shuffle with the given generator; returns a new array. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/* ---------- Dealing the next hand ---------- */

/**
 * The next hand of a match: a fresh shuffled wall and deal for the same four players, with the
 * dealership and scores as `round` says. Names, bot levels and the rules (clocks included) carry
 * over; seat winds are re-cut so the dealer wears East and the seats after them South, West and
 * North. The result is the state BEFORE play starts (phase "setup", the dealer to act).
 */
export function dealNextHand(
  previous: GameState,
  round: GameState["round"],
  seed: string,
): GameState {
  const ids = previous.players.map((p) => p.id) as [string, string, string, string];
  const fresh = initializeHKOSGame(previous.id, ids, seed);

  return {
    ...fresh,
    rules: previous.rules,
    round,
    currentTurn: round.dealerSeat,
    players: fresh.players.map((p, seat) => {
      const old = previous.players[seat] as Player;
      const { difficulty: _dealt, ...rest } = p;
      return {
        ...rest,
        ...(old.name !== undefined ? { name: old.name } : {}),
        ...(old.difficulty !== undefined ? { difficulty: old.difficulty } : {}),
        score: round.scores[seat] ?? 0,
        seatWind: SEAT_WINDS[(seat - round.dealerSeat + 4) % 4] as WindName,
        isDealer: seat === round.dealerSeat,
      };
    }),
  };
}

/* ---------- Public API ---------- */

/**
 * A pristine game: shuffled wall, 13-tile hands dealt to all four seats, a 16-tile dead wall,
 * East as dealer and prevailing wind, and no history. Seat 0 is the dealer and the human
 * player; seats 1-3 are bots.
 *
 * - `id`: the game's identifier.
 * - `playerIds`: one id per seat, in seat order (East, South, West, North).
 * - `seed`: any string; the same seed always produces the same wall and deal.
 */
export function initializeHKOSGame(
  id: string,
  playerIds: readonly [string, string, string, string],
  seed: string,
): GameState {
  const rules = HKOS_RULES;
  const wall = shuffled(buildTileSet(rules), seededRandom(seed));

  const deadWall = wall.slice(0, rules.deadWallSize);
  let next = rules.deadWallSize;

  const players: Player[] = playerIds.map((playerId, index) => {
    const seat = index as SeatIndex;
    const hand = wall.slice(next, next + rules.handSize);
    next += rules.handSize;
    return {
      id: playerId,
      seat,
      ...(seat === 0 ? {} : { difficulty: "medium" as const }),
      hand,
      drawnTile: null,
      discards: [],
      melds: [],
      bonusTiles: [],
      score: 0,
      seatWind: SEAT_WINDS[seat],
      isDealer: seat === 0,
      status: {},
    };
  });

  return {
    id,
    rules,
    round: { prevailingWind: "east", dealerSeat: 0, handNumber: 1, dealerRepeats: 0, scores: [0, 0, 0, 0] },
    phase: { type: "setup" },
    currentTurn: 0,
    players,
    wall: {
      liveTiles: wall.slice(next),
      deadWall,
      deadWallSize: rules.deadWallSize,
      drawCount: 0,
      deadDrawCount: 0,
    },
    lastDiscard: null,
    history: [],
    random: { seed },
    extensions: {},
  };
}
