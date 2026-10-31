import type {
    DrawAction,
    GameAction,
    GamePhase,
    GameState,
    KongAction,
    Meld,
    Player,
    SeatIndex,
    Tile,
    Wall,
  } from "@ourjong/engine";
  
  /**
   * Anti-cheat: the server owns the real GameState and never sends it to a client as is. Every
   * broadcast goes through `sanitizeStateForPlayer`, which builds a fresh view for ONE player:
   *
   * - your own hand and drawn tile are real tiles;
   * - opponents' concealed hands (and drawn tiles) become "hidden" placeholders, one per tile,
   *   so a client can still draw the right number of backs;
   * - the live wall and dead wall become arrays of "hidden" (length only);
   * - the RNG seed is dropped (it would let a client replay the whole shuffle);
   * - other seats' claim options are dropped (they would name the tiles in their hands);
   * - the history hides tiles other seats drew and concealed kongs they declared;
   * - face-down (concealed) kongs of other seats stay hidden.
   *
   * Once a hand has ended every hand is revealed, so the result can be shown.
   */
  
  export const HIDDEN = "hidden" as const;
  export type HiddenTile = typeof HIDDEN;
  /** What a client sees where the real state has a tile. */
  export type ClientTile = Tile | HiddenTile;
  
  export type SanitizedMeld = Omit<Meld, "tiles"> & { readonly tiles: ClientTile[] };
  
  export type SanitizedPlayer = Omit<Player, "hand" | "drawnTile" | "melds"> & {
    hand: ClientTile[];
    drawnTile: ClientTile | null;
    melds: SanitizedMeld[];
  };
  
  export type SanitizedWall = Omit<Wall, "liveTiles" | "deadWall"> & {
    /** One "hidden" per tile left: only the length is real. */
    liveTiles: HiddenTile[];
    deadWall: HiddenTile[];
  };
  
  type SanitizedDraw = Omit<DrawAction, "tile"> & { readonly tile: ClientTile };
  type SanitizedKong = Omit<KongAction, "tiles"> & { readonly tiles: readonly ClientTile[] };
  export type SanitizedAction =
    | Exclude<GameAction, DrawAction | KongAction>
    | SanitizedDraw
    | SanitizedKong;
  
  export type SanitizedGameState = Omit<
    GameState,
    "players" | "wall" | "history" | "random" | "phase"
  > & {
    /** Who this copy of the state was made for. `seat` is null for a spectator. */
    viewer: { playerId: string; seat: SeatIndex | null };
    phase: GamePhase;
    players: SanitizedPlayer[];
    wall: SanitizedWall;
    history: SanitizedAction[];
  };
  
  const hiddenTiles = (count: number): HiddenTile[] => Array.from({ length: count }, () => HIDDEN);
  
  function sanitizeMeld(meld: Meld, reveal: boolean): SanitizedMeld {
    // Open melds are public. A concealed kong is shown face down to everyone but its owner.
    const visible = reveal || meld.isOpen;
    return { ...meld, tiles: visible ? [...meld.tiles] : hiddenTiles(meld.tiles.length) };
  }
  
  function sanitizePlayer(player: Player, viewerSeat: SeatIndex | null, showdown: boolean): SanitizedPlayer {
    const mine = viewerSeat !== null && player.seat === viewerSeat;
    const reveal = mine || showdown;
    return {
      ...player,
      hand: reveal ? [...player.hand] : hiddenTiles(player.hand.length),
      drawnTile: player.drawnTile === null ? null : reveal ? player.drawnTile : HIDDEN,
      melds: player.melds.map((meld) => sanitizeMeld(meld, reveal)),
      discards: player.discards.map((entry) => ({ ...entry })),
      bonusTiles: [...player.bonusTiles],
    };
  }
  
  function sanitizeAction(action: GameAction, viewerSeat: SeatIndex | null): SanitizedAction {
    if (action.type === "draw" && action.seat !== viewerSeat) {
      return { ...action, tile: HIDDEN };
    }
    if (action.type === "kong" && action.variant === "concealed" && action.seat !== viewerSeat) {
      return { ...action, tiles: hiddenTiles(action.tiles.length) };
    }
    return action;
  }
  
  function sanitizePhase(phase: GamePhase, viewerSeat: SeatIndex | null): GamePhase {
    if (phase.type !== "claim-window") return phase;
    // Other seats' options would name the tiles they hold (a pung lists both tiles used).
    return {
      ...phase,
      availableClaims: phase.availableClaims.filter((claim) => claim.seat === viewerSeat),
    };
  }
  
  /**
   * A copy of `state` that is safe to send to the player with id `playerId`. Never mutates
   * `state`. An unknown id gets the spectator view (everything hidden).
   */
  export function sanitizeStateForPlayer(state: GameState, playerId: string): SanitizedGameState {
    const me = state.players.find((player) => player.id === playerId);
    const viewerSeat = me?.seat ?? null;
    const showdown = state.phase.type === "hand-end" || state.phase.type === "game-end";
  
    return {
      id: state.id,
      rules: state.rules,
      round: state.round,
      currentTurn: state.currentTurn,
      lastDiscard: state.lastDiscard,
      extensions: state.extensions,
      viewer: { playerId, seat: viewerSeat },
      phase: sanitizePhase(state.phase, viewerSeat),
      players: state.players.map((player) => sanitizePlayer(player, viewerSeat, showdown)),
      wall: {
        deadWallSize: state.wall.deadWallSize,
        drawCount: state.wall.drawCount,
        deadDrawCount: state.wall.deadDrawCount,
        ...(state.wall.breakPoint !== undefined ? { breakPoint: state.wall.breakPoint } : {}),
        liveTiles: hiddenTiles(state.wall.liveTiles.length),
        deadWall: hiddenTiles(state.wall.deadWall.length),
      },
      history: state.history.map((action) => sanitizeAction(action, viewerSeat)),
      // `random` (the shuffle seed) is intentionally not part of the client view.
    };
  }