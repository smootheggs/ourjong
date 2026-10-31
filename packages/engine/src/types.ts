/* ==========================================================================
 * Mahjong core types — headless rules engine
 * Designed to support Hong Kong Old Style first, with room for other variants
 * (Riichi, MCR, Taiwanese, etc.) via RuleSetConfig and extension slots.
 * Types only: no logic, classes, or functions.
 * ========================================================================== */

/* ---------- Tiles ---------- */

export type SuitName = "bamboo" | "characters" | "dots";
export type SuitRank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type WindName = "east" | "south" | "west" | "north";
export type DragonName = "red" | "green" | "white";
export type FlowerNumber = 1 | 2 | 3 | 4;

export interface SuitTileFace {
  readonly kind: "suit";
  readonly suit: SuitName;
  readonly rank: SuitRank;
}

export interface WindTileFace {
  readonly kind: "wind";
  readonly wind: WindName;
}

export interface DragonTileFace {
  readonly kind: "dragon";
  readonly dragon: DragonName;
}

/** Bonus tiles (used in Hong Kong Old Style: 4 flowers + 4 seasons). */
export interface FlowerTileFace {
  readonly kind: "flower";
  readonly number: FlowerNumber;
}

export interface SeasonTileFace {
  readonly kind: "season";
  readonly number: FlowerNumber;
}

/** Variant-specific extra faces (e.g. Joker, red fives, animals). */
export interface CustomTileFace {
  readonly kind: "custom";
  readonly key: string;
}

export type HonorTileFace = WindTileFace | DragonTileFace;
export type BonusTileFace = FlowerTileFace | SeasonTileFace;

/** What a tile *is* (its identity as a face). Two tiles can share a face. */
export type TileFace =
  | SuitTileFace
  | HonorTileFace
  | BonusTileFace
  | CustomTileFace;

export type TileKind = TileFace["kind"];

/** Stable string key for a face, e.g. "suit:bamboo:3", "wind:east". */
export type TileFaceKey = string;

/** A physical tile in a specific game. */
export interface Tile {
  /** Unique per physical tile within a game (stable across history/replay). */
  readonly id: number;
  readonly face: TileFace;
  /** 0-based copy index among identical faces (0–3 in standard sets). */
  readonly copy: number;
  /** Variant modifiers, e.g. { redDora: true } for red fives. */
  readonly attributes?: Readonly<Record<string, boolean | number | string>>;
}

/* ---------- Seats & Players ---------- */

export type SeatIndex = 0 | 1 | 2 | 3;
export type PlayerId = string;

/** Relative position from the viewpoint of a reference seat. */
export type RelativeSeat = "self" | "right" | "across" | "left";

export type MeldType = "chow" | "pung" | "kong";
export type KongVariant = "exposed" | "added" | "concealed";

export interface Meld {
  readonly type: MeldType;
  /** Tiles in the meld, in display order (3 for chow/pung, 4 for kong). */
  readonly tiles: readonly Tile[];
  /** Present when the meld was formed by claiming a discard. */
  readonly claimedTile?: Tile;
  /** Seat the claimed tile came from. */
  readonly claimedFrom?: SeatIndex;
  /** Only for kongs. Concealed kongs are not "open" for scoring in most rules. */
  readonly kongVariant?: KongVariant;
  /** False for concealed kongs and any meld declared without a claim. */
  readonly isOpen: boolean;
  /** Index into history of the action that created this meld. */
  readonly createdAtActionSeq?: number;
}

export interface DiscardEntry {
  readonly tile: Tile;
  /** Order in which this discard was made within the hand (0-based). */
  readonly order: number;
  /** Set if another player claimed it (it then no longer sits in the river). */
  readonly claimedBy?: SeatIndex;
  /** True if discarded immediately after drawing (tsumogiri-style tracking). */
  readonly fromDraw?: boolean;
  /** Variant data, e.g. { riichi: true } for a riichi declaration tile. */
  readonly flags?: Readonly<Record<string, boolean | number | string>>;
}

/** How well a bot plays. Used by the heuristic AI in ai.ts. */
export type BotDifficulty = "easy" | "medium" | "hard";

export interface Player {
  readonly id: PlayerId;
  readonly seat: SeatIndex;
  readonly name?: string;
  /** Set for bot-controlled seats; undefined means the seat is a human player. */
  readonly difficulty?: BotDifficulty;
  /** Concealed tiles currently held (excluding `drawnTile`). */
  hand: Tile[];
  /** Tile just drawn this turn, kept separate until played. */
  drawnTile: Tile | null;
  /** The player's river, in order discarded. */
  discards: DiscardEntry[];
  /** Open and concealed melds / calls. */
  melds: Meld[];
  /** Flowers, seasons, and other tiles set aside. */
  bonusTiles: Tile[];
  score: number;
  /** Seat wind for the current hand. */
  seatWind: WindName;
  isDealer: boolean;
  /** Variant-specific state (riichi status, furiten, declared ready, etc.). */
  status: Readonly<Record<string, boolean | number | string | null>>;
}

/* ---------- Wall ---------- */

export interface Wall {
  /** Tiles still drawable from the front, next draw at index 0. */
  liveTiles: Tile[];
  /** Reserved tiles (kong replacement draws, dora indicators, etc.). */
  deadWall: Tile[];
  /** Number of tiles in the dead wall at hand start (e.g. 14 in riichi, 16 in HK). */
  deadWallSize: number;
  /** Count of tiles drawn from the live wall this hand. */
  drawCount: number;
  /** Count of tiles drawn from the dead wall this hand (kong replacements). */
  deadDrawCount: number;
  /** Where the wall was broken (dice-determined); optional for physical-wall modeling. */
  breakPoint?: number;
}

/* ---------- Rounds & Phases ---------- */

/** One number per seat, East's seat first. */
export type Scores = readonly [number, number, number, number];

/** One transfer of points at the end of a won hand: `from` hands `amount` points to `to`. */
export interface Payment {
  readonly from: SeatIndex;
  readonly to: SeatIndex;
  /** Always a positive whole number. */
  readonly amount: number;
}

/** A seat's place in the final (or current) standings, from `matchStandings`. */
export interface Standing {
  /** 1 = first. Seats on the same score share a rank (1, 2, 2, 4). */
  readonly rank: number;
  readonly seat: SeatIndex;
  readonly playerId: PlayerId;
  readonly name?: string;
  readonly score: number;
}

/**
 * Where the match stands: this is the match state, carried inside every GameState.
 *
 * A match is a number of rounds (`RuleSetConfig.matchRounds`, East and South by default). A round
 * is one trip of the dealership round the table, so it is at least four hands; every time the
 * dealer wins or the hand is drawn the dealer repeats and the round gets longer. Seats never
 * move: when the dealership rotates, the dealer's seat wind (East) and everyone else's change.
 */
export interface RoundInfo {
  /** The round wind ("roundWind"): East for the first round, South for the second, and so on. */
  readonly prevailingWind: WindName;
  /** Seat of the current dealer (the seat that wears East this hand). */
  readonly dealerSeat: SeatIndex;
  /** Hand number within the current round (1-based, repeats included; back to 1 on a new wind). */
  readonly handNumber: number;
  /** How many times in a row this dealer has kept the dealership (0 on a fresh deal). */
  readonly dealerRepeats: number;
  /**
   * Each seat's running score for the whole match, indexed by seat (not by wind). It starts at
   * `[0, 0, 0, 0]`, changes only when a hand is won (see `Payment`), and is the single source of
   * truth: `Player.score` is kept equal to it so a player can be drawn without the round.
   * Points only move between players, so the four numbers always add up to zero.
   */
  readonly scores: Scores;
  /** Variant carry-over (riichi sticks, pots, etc.). */
  readonly carryOver?: Readonly<Record<string, number>>;
}

export type ClaimKind =
  | "chow"
  | "pung"
  | "kong"
  | "win"; // win on discard (ron / "chut chung")

/**
 * Claims a ClaimAction can execute. An exposed kong from another player's discard is
 * claimed here; concealed and added kongs on your own turn use a KongAction.
 */
export type ClaimType = ClaimKind;

/** One concrete way a seat may claim the current discard. */
export interface ClaimOption {
  readonly seat: SeatIndex;
  readonly kind: ClaimKind;
  /** Tiles from the claimer's hand used with the discard (empty for win). */
  readonly usingTiles: readonly Tile[];
}

export type HandEndReason =
  | "win-self-draw"
  | "win-discard"
  /** A win claimed on the tile of an added kong (qiang gang). */
  | "robbing-kong"
  /**
   * The next player had to draw but the live wall was empty (流局). No winner, no scoring; the
   * phase has `winners` undefined. Hands are not scored and the next hand is dealt on request.
   */
  | "exhaustive-draw"
  | "abortive-draw"
  | "custom";

export type GamePhase =
  | { readonly type: "setup" }
  | { readonly type: "dealing" }
  | { readonly type: "bonus-replacement"; readonly seat: SeatIndex }
  | { readonly type: "draw"; readonly seat: SeatIndex }
  | {
      /** Player holds a drawn tile and must act: discard, kong, or win. */
      readonly type: "action";
      readonly seat: SeatIndex;
      /** True when the draw came from the dead wall (kong replacement). */
      readonly afterKong?: boolean;
      /**
       * Epoch ms by which the seat must act. Set only when the rules enable a turn clock
       * (`RuleSetConfig.turnTimeMs`) and the action that opened the turn carried a timestamp.
       * The reducer only records it: a host (the server) enforces it by playing a fallback.
       */
      readonly deadline?: number;
    }
  | {
      /** Others may claim the last discard (or rob an added kong). */
      readonly type: "claim-window";
      readonly discardedBy: SeatIndex;
      readonly tile: Tile;
      /** Every claim currently available, across all eligible seats. */
      readonly availableClaims: readonly ClaimOption[];
      /** Seats that have already passed. */
      readonly passed: readonly SeatIndex[];
      /**
       * True when the window is open because a player declared an added kong. Only "win"
       * claims are offered. `discardedBy` is then the player declaring the kong and `tile`
       * is the tile being added; the tile is still in that player's hand.
       */
      readonly isRobbingKong?: boolean;
      /** The added-kong declaration waiting to complete if every seat passes. */
      readonly pendingKong?: KongAction;
      /**
       * Epoch ms by which every eligible seat must have claimed or passed. Set only when the
       * rules enable a claim clock (`RuleSetConfig.claimTimeMs`) and the action that opened
       * the window carried a timestamp. Passes do not extend it.
       */
      readonly deadline?: number;
    }
  | {
      readonly type: "hand-end";
      readonly reason: HandEndReason;
      readonly winners?: readonly SeatIndex[];
      /**
       * The tile that completed the winning hand. Set for "win-self-draw" and "robbing-kong";
       * the winner's hand includes it.
       */
      readonly winningTile?: Tile;
      /** Fan and patterns of the winning hand. Set for every win. */
      readonly result?: ScoringResult;
      /**
       * Why the hand scored what it did, ready to print: the total fan, and each pattern with its
       * worth, e.g. ["All in Triplets (3)", "Red Dragon (1)"]. Set for every win; the total is
       * capped at the limit, so the parts can add up to more.
       */
      readonly totalFan?: number;
      readonly patterns?: readonly string[];
      /**
       * Who paid whom for this win. Already applied to `round.scores`; kept here so the result
       * card can show it. Empty or absent for a drawn hand.
       */
      readonly payments?: readonly Payment[];
    }
  | { readonly type: "scoring" }
  | { readonly type: "game-end" };

export type GamePhaseType = GamePhase["type"];

/** The phase a hand is in once it is over. */
export type HandEndPhase = Extract<GamePhase, { readonly type: "hand-end" }>;

/* ---------- Actions / History ---------- */

interface ActionBase {
  /** Monotonic sequence number within the game. */
  readonly seq: number;
  readonly seat: SeatIndex;
  /** Wall-clock timestamp (epoch ms); optional for deterministic replays. */
  readonly timestamp?: number;
}

export interface DrawAction extends ActionBase {
  readonly type: "draw";
  readonly tile: Tile;
  readonly fromDeadWall: boolean;
}

export interface DiscardAction extends ActionBase {
  readonly type: "discard";
  readonly tile: Tile;
  readonly fromDraw: boolean;
}

export interface ChowAction extends ActionBase {
  readonly type: "chow";
  readonly claimedTile: Tile;
  readonly claimedFrom: SeatIndex;
  readonly usingTiles: readonly [Tile, Tile];
}

export interface PungAction extends ActionBase {
  readonly type: "pung";
  readonly claimedTile: Tile;
  readonly claimedFrom: SeatIndex;
  readonly usingTiles: readonly [Tile, Tile];
}

/**
 * A kong declared on your own turn, followed by a replacement draw from the dead wall.
 * - "concealed": `tiles` are the four identical tiles from your hand / drawn tile.
 * - "added": `tiles` is the single fourth tile, joined to one of your open pungs.
 * - "exposed" kongs (from a discard) are claimed with a ClaimAction of kind "kong".
 */
export interface KongAction extends ActionBase {
  readonly type: "kong";
  readonly variant: KongVariant;
  readonly tiles: readonly Tile[];
  readonly claimedFrom?: SeatIndex;
}

export interface BonusAction extends ActionBase {
  readonly type: "reveal-bonus";
  readonly tile: Tile;
  readonly replacement?: Tile;
}

/**
 * Declares a win. `method: "self-draw"` is the "zimo" win on the tile you just drew, valid
 * in your own action phase when the hand scores at least the minimum fan. Wins on a discard
 * or a robbed kong are claimed with a ClaimAction instead.
 */
export interface WinAction extends ActionBase {
  readonly type: "win";
  readonly method: "self-draw" | "discard" | "rob-kong";
  readonly winningTile: Tile;
  readonly fromSeat?: SeatIndex;
}

export interface PassAction extends ActionBase {
  readonly type: "pass";
}

/** What a claimer wants to do with the discard in the open claim window. */
export interface ClaimPayload {
  readonly kind: ClaimType;
  /** Tiles from the claimer's hand used with the discard (empty for a win). */
  readonly usingTiles: readonly Tile[];
}

/** A seat claims the discard in the claim window. `seat` is the claimer. */
export interface ClaimAction extends ActionBase {
  readonly type: "claim";
  readonly payload: ClaimPayload;
}

export interface DeclareAction extends ActionBase {
  /** Variant-specific declarations (riichi, etc.). */
  readonly type: "declare";
  readonly declaration: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface SystemAction {
  readonly seq: number;
  readonly type: "system";
  /**
   * "round-advance" (hand-end or game-end phase) deals the next hand, or ends the match; its
   * payload may carry a `seed` for the new wall, else one is derived from the old seed.
   */
  readonly event:
    | "deal"
    | "hand-start"
    | "hand-end"
    | "round-advance"
    | "game-end"
    | "custom";
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Where the match stands, worked out from a state by `matchStatus` in moves.ts. This is what a
 * scoreboard needs; it holds nothing the state does not already say.
 */
export interface MatchStatus {
  readonly prevailingWind: WindName;
  readonly dealerSeat: SeatIndex;
  /** Hand number within the round, repeats included (1-based). */
  readonly handNumber: number;
  readonly dealerRepeats: number;
  /** Rounds in the whole match. */
  readonly totalRounds: number;
  /** Which round this is (1-based): 1 for East, 2 for South. */
  readonly roundNumber: number;
  /** The hand has ended and the next "round-advance" ends the match instead of dealing. */
  readonly matchEndsNext: boolean;
  /** What "round-advance" will do once the hand is over; null while it is being played. */
  readonly next: {
    readonly prevailingWind: WindName;
    readonly dealerSeat: SeatIndex;
    /** The dealer keeps the dealership (won, or the hand was drawn). */
    readonly dealerStays: boolean;
  } | null;
}

export type GameAction =
  | DrawAction
  | DiscardAction
  | ChowAction
  | PungAction
  | KongAction
  | BonusAction
  | WinAction
  | PassAction
  | ClaimAction
  | DeclareAction
  | SystemAction;

export type GameActionType = GameAction["type"];

/* ---------- Rule Configuration ---------- */

export type RuleSetId = "hk-old-style" | "riichi" | "mcr" | "taiwanese" | (string & {});

export interface TileSetConfig {
  readonly suits: readonly SuitName[];
  readonly includeWinds: boolean;
  readonly includeDragons: boolean;
  readonly includeFlowers: boolean;
  readonly includeSeasons: boolean;
  readonly copiesPerFace: number;
  readonly customFaces?: readonly { face: CustomTileFace; copies: number }[];
}

/**
 * Variant-defining parameters. Engine logic reads these instead of hard-coding
 * rules, so adding a variant means supplying a new config + scoring module.
 */
export interface RuleSetConfig {
  readonly id: RuleSetId;
  readonly playerCount: 3 | 4;
  readonly tileSet: TileSetConfig;
  readonly handSize: number; // 13 standard
  readonly deadWallSize: number;
  readonly allowedChows: boolean;
  /** Which seats may claim a discard as a chow. */
  readonly chowFrom: "left-only" | "any";
  /** Whether multiple players may win on one discard. */
  readonly multipleWinsOnDiscard: "none" | "head-bump" | "all";
  /** Minimum scoring threshold to declare a win (fan/han/points). */
  readonly minimumScore: number;
  /**
   * Turn clock in ms. When set (> 0), each "action" phase gets a `deadline` of the opening
   * action's timestamp plus this. Left unset the game has no clock, which keeps the reducer
   * deterministic for replays, tests and local play.
   */
  readonly turnTimeMs?: number;
  /** Claim-window clock in ms; same rules as `turnTimeMs`. */
  readonly claimTimeMs?: number;
  /**
   * How many rounds make a match: 1 = East only, 2 = East and South (the default), up to 4.
   * When the last round's dealership has gone all the way round, the match ends.
   */
  readonly matchRounds?: number;
  /** Scoring system identifier — resolved by a pluggable scoring module. */
  readonly scoringSystem: string;
  /** Free-form variant options (limits, payment rules, special hands). */
  readonly options: Readonly<Record<string, boolean | number | string | readonly string[]>>;
}

/* ---------- Game State ---------- */

export type GameId = string;

export interface RandomState {
  readonly seed: string;
  /** Opaque PRNG state for deterministic replay. */
  readonly state?: unknown;
}

export interface GameState {
  readonly id: GameId;
  readonly rules: RuleSetConfig;
  readonly round: RoundInfo;
  readonly phase: GamePhase;
  /** Seat whose turn it currently is. */
  currentTurn: SeatIndex;
  /** Indexed by seat (length equals rules.playerCount). */
  players: Player[];
  wall: Wall;
  /** Most recent discard that is still claimable, if any. */
  lastDiscard: { readonly tile: Tile; readonly by: SeatIndex } | null;
  /** Complete ordered log of actions for replay and auditing. */
  history: GameAction[];
  random: RandomState;
  /** Variant-specific global state (pots, riichi sticks, etc.). */
  extensions: Readonly<Record<string, unknown>>;
}

/* ---------- Scoring ---------- */

/** Outcome of scoring a winning hand. An invalid hand scores zero with no patterns. */
export interface ScoringResult {
  /** Total fan after summing every pattern and applying the limit. */
  readonly totalFan: number;
  /** Names of every pattern that scored (see `PATTERN_FAN` in scoring.ts), e.g. ["All in Triplets", "Red Dragon", "Seat Wind"]. */
  readonly patterns: string[];
}
