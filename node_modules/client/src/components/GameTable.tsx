import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  CLAIM_TIME_MS,
  TURN_TIME_MS,
  calculateFan,
  canSelfDrawWin,
  canWin,
  fanForWin,
  getBestClaim,
  getBestDiscard,
  getHiddenKongs,
  getPromotedKongs,
  LIMIT_HANDS,
  PAYOUT_FAN_CAP,
  SELF_DRAW_BONUS,
  fanToPoints,
  isLimitFan,
  matchStandings,
  matchStatus,
  patternLabels,
  shanten,
  shouldDeclareSelfDrawWin,
} from "@ourjong/engine";
import type {
  BotDifficulty,
  ClaimKind,
  ClaimOption,
  DragonName,
  Player,
  GameAction,
  GameState,
  MatchStatus,
  Meld,
  Payment,
  ScoringResult,
  SeatIndex,
  SuitName,
  Tile,
  WindName,
  WinContext,
} from "@ourjong/engine";
import { playSound } from "../audio";
import { DiceRoll, rollDice } from "./Dice";
import type { DiceRollState } from "./Dice";
import { TileView } from "./TileView";

export interface GameTableProps {
  /** The game to draw. Local play: the real state. Online: the server's sanitized view. */
  gameState: GameState;
  /** Every move the player makes goes through here (a reducer dispatch, or a socket send). */
  onPlayerAction: (action: GameAction) => void;
  /**
   * Online play: the server owns the game, so the local AI (bots, auto-claims), the coach and
   * the peek button are all switched off.
   */
  isMultiplayer?: boolean;
  /** The seat this screen sits in (0 = East). Local play is always seat 0. */
  mySeat?: SeatIndex;
  /** The coach's suggestions (local play only; the switch lives in the app's top bar). */
  coachOn?: boolean;
  /** Turn the opponents' concealed tiles face up (local play only; switch in the top bar). */
  peek?: boolean;
  /**
   * Pass-and-play: every seat listed here is a person and is never automated. Everyone else is a
   * bot. Defaults to just `mySeat` (one person against three bots).
   */
  humanSeats?: readonly SeatIndex[];
  /**
   * Pass-and-play: draw your own hand face down and ignore taps on it. Used while bots play
   * between two people, so the hand on screen is not on show to whoever is looking.
   */
  concealMine?: boolean;
  /** Quick-chat emoji floating over each seat, keyed by absolute seat. Change `id` to resend. */
  emojis?: Partial<Record<number, { id: number; emoji: string }>>;
  /** Called with the seat when its emoji's animation ends, so the app can clear it. */
  onEmojiDone?: (seat: number) => void;
  /** A short message to show under the status line, e.g. a rejected action. */
  notice?: string | null;
  /**
   * How far the server's clock is ahead of this device's (server time minus local time, ms).
   * Deadlines are server times, so the countdown adds this to stay right on a skewed clock.
   */
  clockOffsetMs?: number;
}

/**
 * Tiles the server hides arrive as placeholders with a negative id (see useMultiplayer).
 * Real tiles always have ids >= 0, so this is how the table knows to draw a back.
 */
const isHiddenTile = (tile: Tile): boolean => tile.id < 0;

const BOT_DELAY_MS = 700; // pace of the AI seats
const HUMAN_DRAW_DELAY_MS = 350; // your own draw is automatic, with a beat so the tile reads
const PASS_DELAY_MS = 350;
const TOAST_MS = 1500;
const SLIDE_MS = 200;

// Bots without an explicit `difficulty` on their Player play at this level.
const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "medium";
const COACH_DIFFICULTY: BotDifficulty = "medium";

const difficultyOf = (player: Player): BotDifficulty =>
  player.difficulty ?? DEFAULT_BOT_DIFFICULTY;

// Mirrors the engine's claim priority so a bot never sends a claim that is still blocked.
const CLAIM_PRIORITY: Record<ClaimKind, number> = { chow: 1, pung: 2, kong: 2, win: 3 };

/* ---------- Audio ---------- */

// Game sounds go through playSound (../audio); the fidget's tick below is synthesized.

/**
 * A very soft ceramic "tick": a few milliseconds of band-passed noise with a fast decay,
 * made with Web Audio so there is no file to load. `strength` (0-1) scales the loudness
 * and pitch a little. Browsers only allow audio after a gesture, so the context is created
 * (or resumed) from `primeTickAudio` on the first pointer-down and a blocked one is ignored.
 */
let tickContext: AudioContext | null = null;
let tickNoise: AudioBuffer | null = null;

function primeTickAudio(): void {
  try {
    if (tickContext === null) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      tickContext = new Ctor();
    }
    if (tickContext.state === "suspended") void tickContext.resume().catch(() => undefined);
  } catch {
    tickContext = null;
  }
}

function playCeramicTick(strength = 0.5): void {
  try {
    const ctx = tickContext;
    if (!ctx || ctx.state !== "running") return;
    if (tickNoise === null) {
      const length = Math.floor(ctx.sampleRate * 0.03);
      tickNoise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = tickNoise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = tickNoise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2600 + strength * 1600;
    filter.Q.value = 3;
    const gain = ctx.createGain();
    const peak = 0.03 + strength * 0.07; // always quiet
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(now);
    source.stop(now + 0.03);
  } catch {
    // Audio is a nicety; the fidget works without it.
  }
}

/** A 5 ms buzz on phones that have a vibration motor; everywhere else this does nothing. */
function microHaptic(): void {
  try {
    navigator.vibrate?.(5);
  } catch {
    // Unsupported or blocked.
  }
}

/* ---------- Pull-and-snap tile fidget ---------- */

/** How far (in tile heights) a pulled tile can ever travel: the spring's soft limit. */
const FIDGET_REACH = 3.4;
/**
 * Ticks and buzzes mark only these moments, so idle micro-drags stay silent. Each is a
 * threshold crossed while pulling (in tile heights of travel, or of sideways drift); one has
 * to fall back below 85% of its value before it can fire again.
 */
const FIDGET_MARKS = {
  /** Neighbours visibly part. */
  parted: { offset: 0.5 },
  /** The tile has tipped over noticeably (about 11 degrees). */
  tilted: { offset: 1.0 },
  /** The sideways drift has twisted it. */
  twisted: { sway: 0.5 },
  /** Pulled well out toward the middle of the table. */
  far: { offset: 2.2 },
} as const;
type FidgetMark = keyof typeof FIDGET_MARKS;
const FIDGET_SNAP = "transform 520ms cubic-bezier(0.3, 1.75, 0.45, 1)";

/**
 * Lets you pull on your tiles while you cannot discard (other players' turns and claim
 * windows). Dragging a tile toward the middle of the table meets spring resistance, tilts it
 * toward you in 3D and parts its neighbours; letting go snaps everything back with a
 * little overshoot. `cancel()` snaps it all home at once and blocks the click that would
 * follow, and it runs the moment the game gives you a turn so discarding is never delayed.
 * Everything is done on the DOM nodes directly, so a drag never re-renders the table.
 */
function useTileFidget(enabled: boolean) {
  const handRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    index: number;
    startY: number;
    height: number;
    startX: number;
    offset: number;
    sway: number;
    /** Marks currently crossed, and whether any was ever crossed during this drag. */
    marks: Set<FidgetMark>;
    meaningful: boolean;
  } | null>(null);
  const suppressClickUntil = useRef(0);

  const tilesOf = (): HTMLElement[] =>
    Array.from(handRef.current?.querySelectorAll<HTMLElement>("[data-fidget]") ?? []);

  const snapHome = () => {
    for (const el of tilesOf()) {
      if (!el.style.transform) continue;
      el.style.transition = FIDGET_SNAP;
      el.style.transform = "";
      el.style.zIndex = "";
      window.setTimeout(() => {
        el.style.transition = "";
      }, 560);
    }
  };

  const apply = (index: number, offset: number, sway: number) => {
    const tiles = tilesOf();
    const lead = tiles[index];
    if (!lead) return;
    const height = lead.offsetHeight || 1;
    const rowTop = lead.offsetTop;
    tiles.forEach((el, i) => {
      if (i === index) {
        el.style.transition = "none";
        el.style.zIndex = "3";
        // Move in the table plane first, then give the tile its own perspective and rotate it
        // about its own centre. Perspective belongs to the tile (not the hand), it is never
        // pushed toward the viewer and never scaled, so it turns as a rigid slab: the same
        // width and height at every angle.
        const reach = offset / height; // tile heights travelled
        el.style.transform =
          `translate3d(${sway * 0.55}px, ${-offset}px, 0) perspective(900px) ` +
          `rotateX(${Math.min(reach * 11, 26)}deg) ` +
          `rotateY(${Math.max(-1, Math.min(1, sway / height)) * 28}deg) ` +
          `rotateZ(${Math.max(-1, Math.min(1, sway / height)) * 9}deg)`;
        return;
      }
      const gap = i - index;
      const near = Math.abs(gap) <= 3 && el.offsetTop === rowTop;
      el.style.transition = "transform 90ms ease-out";
      el.style.transform = near
        ? `translate3d(${(Math.sign(gap) * Math.min(offset * 0.2, height * 0.55)) / Math.abs(gap)}px, ${-offset * 0.05}px, 0)`
        : "";
    });
  };

  const release = (loud: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (current && handRef.current?.hasPointerCapture?.(current.pointerId)) {
      try {
        handRef.current.releasePointerCapture(current.pointerId);
      } catch {
        // Already released.
      }
    }
    snapHome();
    // The snap-back only rings if the pull did something worth marking.
    if (loud && current && current.meaningful) {
      playCeramicTick(0.8);
      microHaptic();
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-fidget]");
    if (!el || drag.current) return;
    const index = tilesOf().indexOf(el);
    if (index < 0) return;
    primeTickAudio();
    drag.current = {
      pointerId: event.pointerId,
      index,
      startY: event.clientY,
      startX: event.clientX,
      height: el.offsetHeight || 1,
      offset: 0,
      sway: 0,
      marks: new Set<FidgetMark>(),
      meaningful: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!enabled) {
      release(false);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const pull = Math.max(0, current.startY - event.clientY);
    const reach = current.height * FIDGET_REACH;
    // Light and weightless at first (the tile tracks your finger one-to-one), then a long,
    // gentle roll-off toward the limit: no wall, just a slowly rising tension.
    const offset = pull / (1 + pull / reach);
    // Sideways drift is eased the same way, so a diagonal pull swings the tile around.
    const sideways = event.clientX - current.startX;
    const sway = sideways / (1 + Math.abs(sideways) / (current.height * 1.6));
    current.offset = offset;
    current.sway = sway;
    apply(current.index, offset, sway);
    // Which marks are crossed now? Entering one rings once; leaving it (with a little slack)
    // re-arms it. Nothing rings while you are only wiggling a tile.
    const travel = offset / current.height;
    const drift = Math.abs(sway) / current.height;
    let entered = 0;
    for (const key of Object.keys(FIDGET_MARKS) as FidgetMark[]) {
      const mark: { offset?: number; sway?: number } = FIDGET_MARKS[key];
      const value = mark.offset !== undefined ? travel : drift;
      const limit = (mark.offset ?? mark.sway) as number;
      if (value >= limit) {
        if (!current.marks.has(key)) {
          current.marks.add(key);
          entered++;
        }
      } else if (value < limit * 0.85) {
        current.marks.delete(key);
      }
    }
    if (entered > 0) {
      current.meaningful = true;
      playCeramicTick(0.3 + Math.min(current.marks.size, 4) * 0.12);
      microHaptic();
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current && drag.current.pointerId === event.pointerId) release(true);
  };

  /** Snap everything home right now, quietly, and swallow the click that may follow. */
  const cancel = () => {
    if (drag.current) suppressClickUntil.current = performance.now() + 450;
    release(false);
  };

  return {
    handRef,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
    cancel,
    suppressClickUntil,
  };
}

/* ---------- Seats and winds ---------- */

const WIND_GLYPHS: Record<WindName, string> = { east: "東", south: "南", west: "西", north: "北" };
const WIND_NAMES: Record<WindName, string> = {
  east: "East",
  south: "South",
  west: "West",
  north: "North",
};

/** "East (東)" */
const windTag = (wind: WindName): string => `${WIND_NAMES[wind]} (${WIND_GLYPHS[wind]})`;

// Position relative to the viewer: seats run counter-clockwise, so the next seat is on your right.
const RELATIVE_LABELS: readonly string[] = ["You", "Right", "Across", "Left"];
const seatLabel = (seat: SeatIndex, mySeat: SeatIndex): string =>
  RELATIVE_LABELS[(seat - mySeat + 4) % 4] ?? "";

/**
 * How a player is called on screen: "You", their name, or (unnamed) their seat wind. Where they
 * sit is never spelled out; the layout already says it.
 */
const playerTag = (player: Player, mySeat: SeatIndex): string =>
  player.seat === mySeat ? "You" : (player.name ?? WIND_NAMES[player.seatWind]);

/* ---------- The match: round wind, hand number, dealer ---------- */

/** "East Round, Hand 1": the round wind, and the hand within it (dealer repeats count as hands). */
const matchTitle = (status: MatchStatus): string =>
  `${WIND_NAMES[status.prevailingWind]} Round, Hand ${status.handNumber}`;

/** A seat's name from this viewer's side of the table: "You", their name, or where they sit. */
const seatName = (state: GameState, seat: SeatIndex, mySeat: SeatIndex): string =>
  playerTag(state.players[seat], mySeat);

/** What Next Hand will do, in a line for the result cards. */
function nextHandNote(state: GameState, status: MatchStatus, mySeat: SeatIndex): string {
  if (state.phase.type === "game-end") return "Every round has been played.";
  if (status.next === null) return "That was the last hand of the match.";
  const dealer = seatName(state, status.next.dealerSeat, mySeat);
  const verb = dealer === "You" ? "are" : "is";
  if (status.next.dealerStays) {
    return `${dealer} ${verb} still the dealer (${WIND_NAMES[status.next.prevailingWind]} round, repeat ${status.dealerRepeats + 1}).`;
  }
  const windMoves = status.next.prevailingWind !== status.prevailingWind;
  return windMoves
    ? `The dealership passes to ${dealer}, and the ${WIND_NAMES[status.next.prevailingWind]} round begins.`
    : `The dealership passes to ${dealer}.`;
}

/** +6, −2 or 0. A real minus sign, so the sign carries the meaning and colour is only a hint. */
const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `\u2212${-n}` : "0");

/** Who paid whom when the hand was won, one line per transfer. */
function PaymentList({
  payments,
  state,
  mySeat,
}: {
  payments: readonly Payment[];
  state: GameState;
  mySeat: SeatIndex;
}) {
  if (payments.length === 0) return <p style={styles.cardMuted}>No points change hands.</p>;
  return (
    <ul style={styles.paymentList} aria-label="Payments">
      {payments.map((pay, i) => {
        const from = seatName(state, pay.from, mySeat);
        const to = seatName(state, pay.to, mySeat);
        return (
          <li key={i} style={styles.paymentRow}>
            <span>
              <strong>{from}</strong> {from === "You" ? "pay" : "pays"} <strong>{to}</strong>
            </span>
            <span style={styles.paymentAmount}>{pay.amount} pt{pay.amount === 1 ? "" : "s"}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Hover text for each pattern: its Chinese name. */
const PATTERN_ZH: Record<string, string> = {
  "Common Hand": "平胡",
  "All in Triplets": "對對胡",
  "Mixed One Suit": "混一色",
  "All One Suit": "清一色",
  "Small Three Dragons": "小三元",
  "Small Four Winds": "小四喜",
  "All Honors": "字一色",
  "Thirteen Orphans": "十三么",
  "Red Dragon": "紅中",
  "Green Dragon": "發財",
  "White Dragon": "白板",
  "Seat Wind": "門風",
  "Prevalent Wind": "圈風",
};

/** "All in Triplets (3)" -> { name: "All in Triplets", fan: 3 }. A label with no number keeps its name. */
function parsePatternLabel(label: string): { name: string; fan: number | null } {
  const match = /^(.*) \((\d+)\)$/.exec(label);
  return match ? { name: match[1] as string, fan: Number(match[2]) } : { name: label, fan: null };
}

/** One pattern as a pill: [Mixed One Suit • 3 Fan]. Limit hands are gold. */
function PatternPill({ label }: { label: string }) {
  const { name, fan } = parsePatternLabel(label);
  const limit = (LIMIT_HANDS as readonly string[]).includes(name);
  return (
    <li
      style={{ ...styles.patternPill, ...(limit ? styles.patternPillLimit : null) }}
      title={PATTERN_ZH[name]}
    >
      <span>{name}</span>
      {fan !== null && (
        <>
          <span aria-hidden="true" style={styles.pillDot}>
            •
          </span>
          <span style={limit ? styles.pillFanLimit : styles.pillFan}>
            {fan} Fan
          </span>
        </>
      )}
    </li>
  );
}

/**
 * The hand's worth at a glance: its patterns as pills, and a box with the total fan and how the
 * doubling table turns it into points (2 to the power of the fan, stopping at the cap).
 */
function FanSummary({
  totalFan,
  patterns,
  selfDrawn,
}: {
  totalFan: number;
  patterns: readonly string[];
  selfDrawn: boolean;
}) {
  const limit = isLimitFan(totalFan);
  const exponent = Math.min(totalFan, PAYOUT_FAN_CAP);
  const points = fanToPoints(totalFan);
  return (
    <div style={styles.fanBlock} aria-label="Scoring">
      {patterns.length > 0 ? (
        <ul style={styles.patternPills} aria-label="Patterns">
          {patterns.map((label, i) => (
            <PatternPill key={`${label}-${i}`} label={label} />
          ))}
        </ul>
      ) : (
        <p style={styles.cardMuted}>No scoring patterns.</p>
      )}

      <div
        className={limit ? "ourjong-limit" : undefined}
        style={{ ...styles.totalBox, ...(limit ? styles.totalBoxLimit : null) }}
      >
        <div style={styles.totalTop}>
          <span style={styles.totalLabel}>Total</span>
          <span style={styles.totalFan}>{totalFan} Fan</span>
          {limit && <span style={styles.limitTag}>Limit</span>}
        </div>
        <div style={styles.totalMath}>
          {limit && totalFan > PAYOUT_FAN_CAP ? `Capped at ${PAYOUT_FAN_CAP} fan: ` : ""}2
          <sup>{exponent}</sup> = <strong style={styles.totalPoints}>{points}</strong> point
          {points === 1 ? "" : "s"}
        </div>
        {selfDrawn && (
          <div style={styles.totalNote}>
            Self-draw: +{SELF_DRAW_BONUS}, so {points + SELF_DRAW_BONUS} from each opponent
          </div>
        )}
      </div>
    </div>
  );
}

const ORDINALS = ["1st", "2nd", "3rd", "4th"];

/** The final table: best score first, ties sharing a place. */
function Leaderboard({ state, mySeat }: { state: GameState; mySeat: SeatIndex }) {
  const standings = matchStandings(state);
  return (
    <ol style={styles.leaderboard} aria-label="Final standings">
      {standings.map((s) => (
        <li
          key={s.seat}
          style={{ ...styles.leaderRow, ...(s.rank === 1 ? styles.leaderFirst : null) }}
        >
          <span style={styles.leaderRank}>{ORDINALS[s.rank - 1] ?? `${s.rank}th`}</span>
          <span style={styles.leaderName}>
            {seatName(state, s.seat, mySeat)}
          </span>
          <span style={styles.leaderScore}>{signed(s.score)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The gold 莊 chip that marks whoever is dealing (always sitting as East this hand). */
const rankOf = (tile: Tile): number => (tile.face.kind === "suit" ? tile.face.rank : 0);

/** Seat wind, round wind and the minimum fan, as the scoring and the bots need them. */
const winContextOf = (state: GameState, seat: SeatIndex): WinContext => ({
  seatWind: state.players[seat].seatWind,
  prevailingWind: state.round.prevailingWind,
  minimumFan: state.rules.minimumScore,
});


interface WinSummary {
  seat: SeatIndex;
  /** The discard that completed the hand. */
  tile: Tile;
  /** Concealed tiles without the winning tile. */
  hand: Tile[];
  melds: Meld[];
  result: ScoringResult;
  /** True when the winner drew the tile themselves. */
  selfDrawn: boolean;
}

/** Scores the hand when it ended on a win (claimed or self-drawn); null in every other phase. */
function scoreWin(state: GameState): WinSummary | null {
  const phase = state.phase;
  if (
    phase.type !== "hand-end" ||
    (phase.reason !== "win-discard" &&
      phase.reason !== "robbing-kong" &&
      phase.reason !== "win-self-draw") ||
    !phase.winners?.length
  ) {
    return null;
  }

  const seat = phase.winners[0];
  const winner = state.players[seat];

  // The winning tile is the claimed discard, the tile robbed from an added kong, or the
  // self-drawn tile. The engine also put it into the winner's hand.
  const tile =
    phase.winningTile ??
    state.players.flatMap((p) => p.discards).find((d) => d.claimedBy === seat)?.tile;
  if (tile === undefined) return null;

  const hand = winner.hand.filter((t) => t.id !== tile.id);
  const result = calculateFan(
    hand,
    winner.melds,
    tile,
    winner.seatWind,
    state.round.prevailingWind,
  );
  return {
    seat,
    tile,
    hand,
    melds: winner.melds,
    result,
    selfDrawn: phase.reason === "win-self-draw",
  };
}

function claimLabel(claim: ClaimOption, discard: Tile): string {
  switch (claim.kind) {
    case "win":
      return "Hu";
    case "pung":
      return "Pung";
    case "kong":
      return "Kong";
    case "chow": {
      const ranks = [...claim.usingTiles, discard].map(rankOf).sort((a, b) => a - b);
      return `Chow ${ranks.join("-")}`;
    }
    default:
      return claim.kind;
  }
}

const BUTTON_VARIANT: Record<ClaimKind, "win" | "pong" | "chow" | "kong"> = {
  win: "win",
  pung: "pong",
  chow: "chow",
  kong: "kong",
};

const CLAIM_NAMES: Record<ClaimKind, string> = {
  chow: "CHOW",
  pung: "PONG",
  kong: "KONG",
  win: "WIN",
};

interface ToastContent {
  /** The big Traditional Chinese call, e.g. "碰". */
  glyph: string;
  /** The English call under it, e.g. "PONG!". */
  title: string;
  /** Who did it, e.g. "South (南) · Right". */
  subtitle: string;
  tone: ClaimKind;
}

const CLAIM_GLYPHS: Record<ClaimKind, string> = { chow: "吃", pung: "碰", kong: "槓", win: "胡" };

/** The cut-in for a claim or kong that was just played; null for every other action. */
function toastContent(action: GameAction, state: GameState, mySeat: SeatIndex): ToastContent | null {
  if (action.type !== "claim" && action.type !== "kong") return null;

  const who = `${windTag(state.players[action.seat].seatWind)} · ${playerTag(state.players[action.seat], mySeat)}`;

  if (action.type === "kong") {
    return { glyph: "槓", title: "KONG!", subtitle: `${who} · ${action.variant}`, tone: "kong" };
  }

  const { kind } = action.payload;
  if (kind === "win" && state.phase.type === "hand-end" && state.phase.reason === "robbing-kong") {
    return { glyph: "搶槓", title: "ROB KONG!", subtitle: who, tone: "win" };
  }
  return { glyph: CLAIM_GLYPHS[kind], title: `${CLAIM_NAMES[kind]}!`, subtitle: who, tone: kind };
}

// Colours of the cut-in text: [fill, glow].
const TONE_COLORS: Record<ClaimKind, readonly [string, string]> = {
  chow: ["#7dd3fc", "rgba(56,189,248,0.85)"],
  pung: ["#fdba74", "rgba(249,115,22,0.85)"],
  kong: ["#d8b4fe", "rgba(168,85,247,0.85)"],
  win: ["#fde047", "rgba(239,68,68,0.9)"],
};

const toastShadow = (tone: ClaimKind): string =>
  `0 0 28px ${TONE_COLORS[tone][1]}, 0 5px 0 rgba(0,0,0,0.55), 0 0 3px #000`;

/* ---------- Hand sorting ---------- */

const SUIT_ORDER: Record<SuitName, number> = { bamboo: 0, characters: 1, dots: 2 };
const WIND_ORDER: Record<WindName, number> = { east: 0, south: 1, west: 2, north: 3 };
const DRAGON_ORDER: Record<DragonName, number> = { red: 0, green: 1, white: 2 };

/** Suits (bamboo, characters, dots by rank), then winds, dragons, and anything else. */
function sortKey(tile: Tile): number {
  const face = tile.face;
  switch (face.kind) {
    case "suit":
      return SUIT_ORDER[face.suit] * 10 + face.rank;
    case "wind":
      return 100 + WIND_ORDER[face.wind];
    case "dragon":
      return 110 + DRAGON_ORDER[face.dragon];
    case "flower":
      return 200 + face.number;
    case "season":
      return 210 + face.number;
    default:
      return 300;
  }
}

const compareTiles = (a: Tile, b: Tile): number => sortKey(a) - sortKey(b) || a.id - b.id;

/**
 * A player's concealed tiles in display order: the sorted hand, then the freshly drawn tile.
 * The drawn tile stays in the same list once it joins the hand, so it slides into place.
 */
function handEntries(player: Player): { tile: Tile; drawn: boolean }[] {
  const entries = [...player.hand].sort(compareTiles).map((tile) => ({ tile, drawn: false }));
  if (player.drawnTile) entries.push({ tile: player.drawnTile, drawn: true });
  return entries;
}

function phaseMessage(state: GameState, hasClaims: boolean, mySeat: SeatIndex): string {
  const phase = state.phase;
  const who = (seat: SeatIndex) => playerTag(state.players[seat], mySeat);
  switch (phase.type) {
    case "setup":
      return state.currentTurn === mySeat
        ? "Ready to start: you deal, so you draw the first tile."
        : `Ready to start: ${who(state.currentTurn)} deals and draws first.`;
    case "draw":
      if (state.wall.liveTiles.length === 0) return "The wall is empty.";
      return phase.seat === mySeat ? "Your turn: draw a tile." : `${who(phase.seat)} is drawing…`;
    case "action":
      if (phase.seat === mySeat) {
        return phase.afterKong
          ? "Replacement tile drawn from the dead wall. Tap a tile to discard."
          : "Your turn: tap a tile to discard it.";
      }
      return `${who(phase.seat)} is thinking…`;
    case "claim-window":
      if (phase.isRobbingKong) {
        return phase.discardedBy === mySeat
          ? "You are adding to a pung. Waiting to see if anyone robs the kong…"
          : hasClaims
            ? `${who(phase.discardedBy)} is adding a kong. Win to rob it, or pass.`
            : `${who(phase.discardedBy)} is adding a kong…`;
      }
      return hasClaims
        ? `${who(phase.discardedBy)} discarded. Claim it or pass.`
        : `${who(phase.discardedBy)} discarded.`;
    case "hand-end":
      if (phase.reason === "exhaustive-draw") return "Draw game: no tiles remaining.";
      return phase.winners?.includes(mySeat)
        ? "You won the hand!"
        : phase.winners?.length
          ? `${who(phase.winners[0])} won the hand.`
          : "The hand is over.";
    case "game-end":
      return "Match complete.";
    default:
      return `Phase: ${phase.type}`;
  }
}

/* ---------- The turn clock ---------- */

/** Seconds left at which the bar turns red and starts to pulse. */
const URGENT_MS = 5000;

interface TimerConfig {
  deadline: number;
  totalMs: number;
  label: string;
  /** It is YOUR move: the bar sits above your hand and is bigger. */
  mine: boolean;
}

/**
 * A shrinking bar and a seconds counter for whoever is on the clock. The deadline is a server
 * time; `offsetMs` converts this device's clock to it. The bar only reads the clock, it never
 * acts: when it hits zero the server plays the fallback move and the next state replaces it.
 */
function TurnTimer({
  deadline,
  totalMs,
  label,
  mine,
  offsetMs,
  compact = false,
}: TimerConfig & {
  offsetMs: number;
  /** Small form for the middle of the compass: just the seconds and the bar. */
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline]);

  const remaining = Math.max(0, deadline - (now + offsetMs));
  const fraction = Math.min(1, remaining / Math.max(1, totalMs));
  const urgent = remaining <= Math.min(URGENT_MS, totalMs / 2);
  const color = urgent ? "#f87171" : fraction < 0.5 ? "#f2b134" : "#4ade80";
  const seconds = Math.ceil(remaining / 1000);

  if (compact) {
    return (
      <div
        role="timer"
        aria-label={`${label}: ${seconds} seconds left`}
        className={urgent ? "ourjong-timer ourjong-timer-urgent" : "ourjong-timer"}
        style={styles.timerCompass}
      >
        <span style={{ ...styles.timerSeconds, color }}>{remaining > 0 ? `${seconds}s` : "…"}</span>
        <div style={styles.timerTrack}>
          <div
            className="ourjong-timer-fill"
            style={{ ...styles.timerFill, background: color, transform: `scaleX(${fraction})` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      role="timer"
      aria-label={`${label}: ${seconds} seconds left`}
      className={urgent ? "ourjong-timer ourjong-timer-urgent" : "ourjong-timer"}
      style={mine ? styles.timerMine : styles.timer}
    >
      <div style={styles.timerText}>
        <span>{label}</span>
        <span style={{ color }}>{remaining > 0 ? `${seconds}s` : "…"}</span>
      </div>
      <div style={styles.timerTrack}>
        <div
          className="ourjong-timer-fill"
          style={{ ...styles.timerFill, background: color, transform: `scaleX(${fraction})` }}
        />
      </div>
    </div>
  );
}

/**
 * Wrapper for a tile in the player's hand: lifts and gains a deeper shadow on hover (see
 * .ourjong-hand-tile), and wears the pulsing blue ring when the coach recommends it.
 */
function HandTile({
  active,
  drawn = false,
  elRef,
  children,
}: {
  active: boolean;
  /** The freshly drawn tile sits slightly apart from the rest of the hand. */
  drawn?: boolean;
  elRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={elRef}
      data-fidget=""
      className={active ? "ourjong-hand-tile ourjong-coach" : "ourjong-hand-tile"}
      style={{
        ...(active ? styles.coachRing : styles.coachSlot),
        ...(drawn ? styles.drawnGap : null),
      }}
    >
      {children}
    </div>
  );
}

/* ---------- Rivers: each seat's discards, in order ---------- */

/** Discards per row. A river starts with three rows (18 tiles) and grows a row at a time. */
const RIVER_COLS = 6;
const RIVER_MIN_ROWS = 3;
/**
 * When the space for the rivers is much wider than tall, the top and bottom rivers run longer
 * and flatter (nine to a row); when it is much taller than wide, the left and right rivers do.
 * Either way the cross gets slimmer across its short side, so the tiles can grow.
 */
const RIVER_COLS_LONG = 9;
const RIVER_MIN_ROWS_LONG = 2;
const STRETCH_RATIO = 1.35;
type CrossShape = "even" | "wide" | "tall";

/** Where on the table a river sits, from the viewer's side: "me" is the bottom edge. */
type RiverSide = "me" | "top" | "left" | "right";

/** How far the tiles are turned so they read upright from their owner's seat. */
const RIVER_TURN: Record<RiverSide, number> = { me: 0, top: 180, left: 90, right: -90 };

/** Each river hugs the side of its cell nearest the compass. */
const RIVER_ALIGN: Record<RiverSide, CSSProperties> = {
  me: { alignItems: "flex-start", justifyContent: "center" },
  top: { alignItems: "flex-end", justifyContent: "center" },
  left: { alignItems: "center", justifyContent: "flex-end" },
  right: { alignItems: "center", justifyContent: "flex-start" },
};

/**
 * Which cell of the on-screen grid the n-th discard goes in. A river is laid out as its owner
 * sees it: left to right in rows of six, first row nearest the middle of the table and each new
 * row toward the owner. Turning that picture a quarter turn for each side of the table gives
 * these mappings (r = row, c = column in the owner's view).
 */
function riverCell(
  index: number,
  side: RiverSide,
  rows: number,
  cols: number,
): { column: number; row: number } {
  const r = Math.floor(index / cols);
  const c = index % cols;
  switch (side) {
    case "me":
      return { column: c + 1, row: r + 1 };
    case "top":
      return { column: cols - c, row: rows - r };
    case "right":
      return { column: r + 1, row: cols - c };
    case "left":
      return { column: rows - r, row: c + 1 };
  }
}

/**
 * One seat's river: a fixed grid of slots in front of the player, filled in the order the tiles
 * were thrown. A tile another player claimed leaves the river, so the ones after it close up.
 * Empty slots stay drawn as faint pockets so the shape of the river never jumps around.
 */
function River({
  player,
  side,
  rows,
  cols,
  lastTileId,
  mySeat,
}: {
  player: Player;
  side: RiverSide;
  rows: number;
  /** Tiles per row (the long side of the grid). */
  cols: number;
  lastTileId: number | undefined;
  mySeat: SeatIndex;
}) {
  const tiles = player.discards.filter((d) => d.claimedBy === undefined).map((d) => d.tile);
  const sideways = side === "left" || side === "right";
  const slots = Math.max(rows * cols, tiles.length);
  const box = sideways ? styles.riverCellSide : styles.riverCell;

  return (
    <div
      role="list"
      aria-label={`${seatLabel(player.seat, mySeat)}'s discards`}
      style={{
        ...styles.river,
        gridTemplateColumns: `repeat(${sideways ? rows : cols}, auto)`,
        gridTemplateRows: `repeat(${sideways ? cols : rows}, auto)`,
      }}
    >
      {Array.from({ length: slots }, (_, i) => {
        const place = riverCell(i, side, rows, cols);
        const position = { gridColumn: place.column, gridRow: place.row };
        const tile = tiles[i];
        if (tile === undefined) {
          return <div key={`empty-${i}`} aria-hidden="true" style={{ ...box, ...styles.riverEmpty, ...position }} />;
        }
        return (
          <div
            key={tile.id}
            role="listitem"
            // The newest discard drops in and pulses red/gold so the eye lands on it.
            className={tile.id === lastTileId ? "ourjong-last-discard" : undefined}
            style={{ ...box, ...position }}
          >
            <div style={{ ...styles.riverTile, transform: `translate(var(--ex, -50%), -50%) rotate(${RIVER_TURN[side]}deg)` }}>
              <TileView tile={tile} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- The compass in the middle of the table ---------- */

/** Where each seat's wind sits around the compass, from the viewer's side. */
const COMPASS_EDGES: readonly { offset: number; style: CSSProperties; score: CSSProperties }[] = [
  // Top and bottom seats show the score beside the wind; left and right show it below.
  {
    offset: 0,
    style: { bottom: "2%", left: "50%", transform: "translateX(-50%)" },
    score: { bottom: "calc(2% + var(--r) * 0.32)", left: "calc(50% + var(--r) * 0.72)" },
  },
  {
    offset: 1,
    style: { right: "2%", top: "50%", transform: "translateY(-50%)" },
    score: { right: "2%", top: "calc(50% + var(--r) * 0.62)", width: "calc(var(--r) * 1.1)", justifyContent: "center" },
  },
  {
    offset: 2,
    style: { top: "2%", left: "50%", transform: "translateX(-50%)" },
    score: { top: "calc(2% + var(--r) * 0.32)", left: "calc(50% + var(--r) * 0.72)" },
  },
  {
    offset: 3,
    style: { left: "2%", top: "50%", transform: "translateY(-50%)" },
    score: { left: "2%", top: "calc(50% + var(--r) * 0.62)", width: "calc(var(--r) * 1.1)", justifyContent: "center" },
  },
];

/**
 * The hub of the table. It shows the round wind and hand, the wall, and the clock when there is
 * one. Round the edge are the four seat winds, each on the side its player sits: the seat on
 * turn lights up gold, and a seat that still has a claim to make rings blue.
 */
function Compass({
  state,
  mySeat,
  activeSeat,
  timer,
  clockOffsetMs,
  roll,
  onRollDone,
}: {
  state: GameState;
  mySeat: SeatIndex;
  activeSeat: SeatIndex | undefined;
  timer: TimerConfig | null;
  clockOffsetMs: number;
  roll: DiceRollState | null;
  onRollDone: () => void;
}) {
  const status = matchStatus(state);
  const phase = state.phase;
  const deciding =
    phase.type === "claim-window"
      ? new Set(phase.availableClaims.map((c) => c.seat).filter((seat) => !phase.passed.includes(seat)))
      : new Set<SeatIndex>();

  return (
    <div style={styles.compass} role="group" aria-label="Table compass">
      {COMPASS_EDGES.map(({ offset, style, score: scoreStyle }) => {
        const seat = ((mySeat + offset) % 4) as SeatIndex;
        const player = state.players[seat];
        const on = seat === activeSeat;
        const waiting = deciding.has(seat);
        return (
          <Fragment key={seat}>
          <span
            className={on ? "ourjong-turn" : undefined}
            style={{
              ...styles.compassEdge,
              ...style,
              ...(waiting ? styles.compassEdgeWaiting : null),
              ...(on ? styles.compassEdgeOn : null),
            }}
            title={`${windTag(player.seatWind)} · ${playerTag(player, mySeat)}${on ? " · on turn" : waiting ? " · deciding" : ""}`}
          >
            {WIND_GLYPHS[player.seatWind]}
            {player.isDealer && (
              <span style={styles.compassDealer} title="Dealer" role="img" aria-label="Dealer">
                莊
              </span>
            )}
          </span>
          <span
            style={{
              ...styles.compassScore,
              ...scoreStyle,
              color: player.score > 0 ? "#bbf7d0" : player.score < 0 ? "#fecaca" : "rgba(244,239,224,0.6)",
            }}
            aria-label={`${playerTag(player, mySeat)} score ${signed(player.score)}`}
          >
            {signed(player.score)}
          </span>
          </Fragment>
        );
      })}

      <div style={styles.compassCore}>
        <div style={styles.compassGlyph} aria-hidden="true">
          {WIND_GLYPHS[status.prevailingWind]}
        </div>
        <div style={styles.compassRound}>{WIND_NAMES[status.prevailingWind]} Round</div>
        <div style={styles.compassHand}>
          Hand {status.handNumber}
          {status.dealerRepeats > 0 ? ` ×${status.dealerRepeats + 1}` : ""} · Wall {state.wall.liveTiles.length}
        </div>
        {timer && <TurnTimer key={timer.deadline} {...timer} offsetMs={clockOffsetMs} compact />}
      </div>

      {roll && <DiceRoll roll={roll} onDone={onRollDone} />}
    </div>
  );
}

/* ---------- Opponent seats around the table ---------- */

type Side = "top" | "left" | "right";

interface SeatEntry {
  key: string | number;
  /** null renders a face-down tile. */
  tile: Tile | null;
  drawn: boolean;
}

/**
 * What to draw for an opponent's concealed tiles. Normally anonymous backs (one per tile held,
 * plus the drawn tile); in "peek" mode the real, sorted tiles so the AI's hand can be watched.
 */
function seatEntries(player: Player, peek: boolean): SeatEntry[] {
  if (peek) {
    return handEntries(player).map(({ tile, drawn }) => ({ key: tile.id, tile, drawn }));
  }
  const entries: SeatEntry[] = player.hand.map((_, i) => ({
    key: `back-${i}`,
    tile: null,
    drawn: false,
  }));
  if (player.drawnTile) entries.push({ key: "back-drawn", tile: null, drawn: true });
  return entries;
}

/**
 * One tile in an opponent's hand or melds, turned to face the seat's owner. Each tile is
 * turned inside its own box (never the whole block) so the sliding animation still moves in
 * screen directions. The top seat turns tiles 180 degrees; left and right tiles lie on their
 * side, so their box has the width and height swapped and the tile is turned 90 degrees.
 */
function SeatSlot({
  side,
  drawn = false,
  elRef,
  children,
}: {
  side: Side;
  drawn?: boolean;
  elRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  if (side === "top") {
    return (
      <div ref={elRef} style={{ ...styles.oppSlot, ...(drawn ? styles.oppDrawnGap : null) }}>
        <div style={{ display: "flex", transform: "rotate(180deg)" }}>{children}</div>
      </div>
    );
  }

  const degrees = side === "left" ? 90 : -90;
  // The drawn tile sits a little apart from the hand, at its far end.
  const gap = drawn ? (side === "left" ? { marginTop: "calc(var(--o) * 0.25)" } : { marginBottom: "calc(var(--o) * 0.25)" }) : null;
  return (
    <div ref={elRef} style={{ ...styles.sideSlot, ...gap }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: `translate(var(--ex, -50%), -50%) rotate(${degrees}deg)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Exposed melds are always face up, turned to match the seat they belong to. */
function SeatMelds({ player, side, mySeat }: { player: Player; side: Side; mySeat: SeatIndex }) {
  if (player.melds.length === 0) return null;

  // Reading order from the owner's point of view: left to right becomes right to left across
  // the top, top to bottom down the left edge and bottom to top up the right edge.
  const direction = side === "top" ? "row-reverse" : side === "right" ? "column-reverse" : "column";
  return (
    <div
      style={{ ...styles.sideMelds, flexDirection: direction }}
      aria-label={`${seatLabel(player.seat, mySeat)}'s melds`}
    >
      {player.melds.map((meld, i) => (
        <div key={i} style={{ ...styles.sideMeld, flexDirection: direction }}>
          {meld.tiles.map((tile) => (
            <SeatSlot key={tile.id} side={side}>
              {/* An opponent's concealed kong stays face down online. */}
              {isHiddenTile(tile) ? <TileView faceDown /> : <TileView tile={tile} />}
            </SeatSlot>
          ))}
        </div>
      ))}
    </div>
  );
}

function OpponentSeat({
  player,
  side,
  peek,
  mySeat,
  setTileEl,
}: {
  player: Player;
  side: Side;
  peek: boolean;
  mySeat: SeatIndex;
  setTileEl: (id: number) => (el: HTMLDivElement | null) => void;
}) {
  const slots = seatEntries(player, peek).map((entry) => (
    <SeatSlot
      key={entry.key}
      side={side}
      drawn={entry.drawn}
      elRef={entry.tile ? setTileEl(entry.tile.id) : undefined}
    >
      {entry.tile ? (
        <TileView tile={entry.tile} isDrawn={entry.drawn} />
      ) : (
        <TileView faceDown isDrawn={entry.drawn} />
      )}
    </SeatSlot>
  ));

  const hand = (
    <div
      style={
        side === "top"
          ? { ...styles.oppHandRow, flexDirection: "row-reverse" }
          : { ...styles.oppHandColumn, flexDirection: side === "right" ? "column-reverse" : "column" }
      }
      aria-label={`${seatLabel(player.seat, mySeat)}'s concealed hand`}
    >
      {slots}
    </div>
  );

  const cell = styles.seatCell;

  // Every seat owns a meld track of fixed size that is there whether or not any meld is, so
  // exposing one never changes how much room the seat takes, and the table around it (the
  // rivers and compass) never moves.
  if (side === "top") {
    // The hand, and a row for melds under it (toward the middle of the table).
    return (
      <div style={cell}>
        {hand}
        <div style={styles.topMeldTrack}>
          <SeatMelds player={player} side={side} mySeat={mySeat} />
        </div>
      </div>
    );
  }

  // Left and right: the hand, and a column for melds beside it (toward the middle).
  return (
    <div style={cell}>
      <div style={{ ...styles.sideBlock, flexDirection: side === "left" ? "row" : "row-reverse" }}>
        {hand}
        <div style={styles.sideMeldTrack}>
          <SeatMelds player={player} side={side} mySeat={mySeat} />
        </div>
      </div>
    </div>
  );
}

export function GameTable({
  gameState: state,
  onPlayerAction: dispatch,
  isMultiplayer = false,
  mySeat = 0,
  notice = null,
  clockOffsetMs = 0,
  coachOn: coachRequested = false,
  peek: peekRequested = false,
  emojis = {},
  onEmojiDone,
  humanSeats,
  concealMine = false,
}: GameTableProps) {
  // Seats that are people. Everyone else is run by the AI below.
  const humans: readonly SeatIndex[] = humanSeats ?? [mySeat];
  const humansKey = humans.join(",");
  const isBotSeat = (seat: SeatIndex) => !humans.includes(seat);
  // Online there is no coach (it would be an unfair aid) and no peek (the tiles are not here).
  // With several people on one device either would give their hands away.
  const shared = humans.length > 1;
  const coachOn = coachRequested && !isMultiplayer && !shared;
  const peek = peekRequested && !isMultiplayer && !shared;

  // The dice roll when a hand begins: when the table opens on a fresh deal, and each time the
  // next hand is dealt. Reopening the table in the middle of a hand does not roll them again.
  const rollKey = `${state.id}|${state.random?.seed ?? ""}|${state.round.handNumber}|${state.round.dealerRepeats}`;
  const lastRollKey = useRef(rollKey);
  const [roll, setRoll] = useState<DiceRollState | null>(() =>
    state.phase.type === "setup" ? rollDice(rollKey) : null,
  );
  useEffect(() => {
    if (lastRollKey.current === rollKey) return;
    lastRollKey.current = rollKey;
    setRoll(rollDice(rollKey));
  }, [rollKey]);
  const [toast, setToast] = useState<(ToastContent & { id: number }) | null>(null);
  const seenActions = useRef(state.history.length);
  const me = state.players[mySeat];
  const phase = state.phase;
  const wallEmpty = state.wall.liveTiles.length === 0;

  const canDiscard =
    !concealMine && state.currentTurn === mySeat && phase.type === "action" && phase.seat === mySeat;

  // Pulling on your tiles is for when you cannot discard; the instant it is your turn it ends.
  const fidget = useTileFidget(!canDiscard);
  useLayoutEffect(() => {
    if (canDiscard) fidget.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDiscard]);
  useEffect(() => () => fidget.cancel(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Seat 0 draws via the button: "hand-start" at the very beginning, a normal draw afterwards.
  const canStart = phase.type === "setup" && state.currentTurn === mySeat;
  const canDraw =
    phase.type === "draw" && phase.seat === mySeat && state.currentTurn === mySeat && !wallEmpty;

  // Score the hand once it has ended on a win.
  const win = useMemo(() => scoreWin(state), [state]);
  // The wall ran out with nobody winning: no hand to show, just the result and Next Hand.
  const drawGame = phase.type === "hand-end" && phase.reason === "exhaustive-draw";

  // Every hand (yours and the bots') is shown sorted; tiles slide when it changes.
  const tileEls = useRef(new Map<number, HTMLDivElement>());
  const tileSpots = useRef(new Map<number, { x: number; y: number }>());
  const setTileEl = (id: number) => (el: HTMLDivElement | null) => {
    if (el) tileEls.current.set(id, el);
    else tileEls.current.delete(id);
  };

  // FLIP: after every render, compare each tile's position inside the hand with where it was
  // last time and play a short slide from the old spot. Offsets are relative to the hand
  // container and ignore transforms, so layout shifts elsewhere and hover lifts don't count.
  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<number, { x: number; y: number }>();
    tileEls.current.forEach((el, id) => {
      const spot = { x: el.offsetLeft, y: el.offsetTop };
      next.set(id, spot);
      const before = tileSpots.current.get(id);
      if (
        before &&
        !reduceMotion &&
        typeof el.animate === "function" &&
        (before.x !== spot.x || before.y !== spot.y)
      ) {
        el.animate(
          [
            { transform: `translate(${before.x - spot.x}px, ${before.y - spot.y}px)` },
            { transform: "translate(0, 0)" },
          ],
          { duration: SLIDE_MS, easing: "ease-in-out" },
        );
      }
    });
    tileSpots.current = next;
  });

  // A resize reflows the hand without a render: re-record positions so it doesn't animate.
  useEffect(() => {
    const record = () => {
      tileSpots.current = new Map(
        [...tileEls.current].map(([id, el]) => [id, { x: el.offsetLeft, y: el.offsetTop }]),
      );
    };
    window.addEventListener("resize", record);
    return () => window.removeEventListener("resize", record);
  }, []);

  // Claims the human can still make on the open discard.
  const myClaims: readonly ClaimOption[] =
    phase.type === "claim-window" && !phase.passed.includes(mySeat)
      ? phase.availableClaims.filter((c) => c.seat === mySeat)
      : [];

  // Kongs the human can declare on their own turn (hand plus the drawn tile).
  const heldTiles = me.drawnTile ? [...me.hand, me.drawnTile] : me.hand;
  const hiddenKongs = canDiscard ? getHiddenKongs(heldTiles) : [];
  const promotedKongs = canDiscard ? getPromotedKongs(heldTiles, me.melds) : [];

  // You drew the tile that completes a hand worth at least the minimum fan.
  const canWinNow = canDiscard && canSelfDrawWin(state, mySeat);

  /* ---------- 3 fan minimum: tell the player why they can't win ---------- */
  const myContext = winContextOf(state, mySeat);

  // Your own 14 tiles are a complete hand, but worth under the minimum.
  const heldWinTile = me.drawnTile ?? heldTiles[heldTiles.length - 1];
  const heldComplete =
    canDiscard && heldTiles.length > 0 && shanten(heldTiles, me.melds.length) === -1;
  const heldTooCheap =
    heldComplete &&
    fanForWin(
      heldTiles.filter((t) => t.id !== heldWinTile.id),
      me.melds,
      heldWinTile,
      myContext,
    ) < myContext.minimumFan;

  // A discard that would have completed your hand, but the engine offered no win for it
  // (under the minimum). The claim window is skipped when nothing else can be claimed, so
  // this is checked on the discard itself and shown for a few seconds.
  const offeredTile =
    phase.type === "claim-window"
      ? phase.tile
      : phase.type === "draw" && state.lastDiscard && state.lastDiscard.by !== mySeat
        ? state.lastDiscard.tile
        : undefined;
  const cheapDiscardId =
    offeredTile !== undefined &&
    !myClaims.some((c) => c.kind === "win") &&
    canWin(me.hand, offeredTile) &&
    fanForWin(me.hand, me.melds, offeredTile, myContext) < myContext.minimumFan
      ? offeredTile.id
      : undefined;
  const [cheapNoteId, setCheapNoteId] = useState<number | null>(null);
  useEffect(() => {
    if (cheapDiscardId !== undefined) setCheapNoteId(cheapDiscardId);
  }, [cheapDiscardId]);
  useEffect(() => {
    if (cheapNoteId === null) return undefined;
    const id = setTimeout(() => setCheapNoteId(null), 4000);
    return () => clearTimeout(id);
  }, [cheapNoteId]);
  const showMinimumNote = heldTooCheap || cheapNoteId !== null;

  /* ---------- Action toast: announce claims and kongs ---------- */
  useEffect(() => {
    const seen = seenActions.current;
    seenActions.current = state.history.length;
    if (state.history.length <= seen) return; // nothing new, or a fresh game replaced the log

    // The sound for your own discards and claims plays the instant you tap (see the handlers
    // below), so here only other players' moves, and your own automatic draws, make a sound.
    const bySomeoneElse = (a: GameState["history"][number]) =>
      !("seat" in a) || a.seat !== mySeat || a.type === "draw";
    let announced = false;
    let announcedByOther = false;
    for (let i = state.history.length - 1; i >= seen; i--) {
      const content = toastContent(state.history[i], state, mySeat);
      if (content !== null) {
        setToast({ id: i, ...content });
        announced = true;
        announcedByOther = bySomeoneElse(state.history[i]);
        break;
      }
    }

    // One sound per batch: the claim sting with the cut-in, otherwise a clack for any
    // draw or discard.
    const fresh = state.history.slice(seen).filter(bySomeoneElse);
    if (announced) {
      if (announcedByOther) playSound("claim");
    } else if (fresh.some((a) => a.type === "discard")) {
      playSound("discard");
    } else if (fresh.some((a) => a.type === "draw")) {
      playSound("draw");
    }
  }, [state]);

  useEffect(() => {
    if (toast === null) return undefined;
    const id = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast]);

  /* ---------- Coach: what the medium AI would do for you ---------- */
  const coachDiscardId =
    coachOn && canDiscard && heldTiles.length > 0
      ? getBestDiscard(heldTiles, me.melds, COACH_DIFFICULTY).id
      : undefined;

  const coachClaim: ClaimOption | "pass" | undefined =
    coachOn && phase.type === "claim-window" && myClaims.length > 0
      ? getBestClaim(
        me.hand,
        me.melds,
        phase.tile,
        myClaims,
        COACH_DIFFICULTY,
        Math.random,
        winContextOf(state, mySeat),
      )
      : undefined;

  /* ---------- Automation: bots claim or pass, then play their turns ---------- */
  useEffect(() => {
    // Online, every seat is a person: the server runs the game and nothing is automated here.
    if (isMultiplayer) return undefined;

    const seq = state.history.length;

    // 0. A new hand has been dealt and the dealer is a bot: it deals itself in. (When the dealer
    // is you, the auto-draw effect below does this.)
    if (phase.type === "setup" && isBotSeat(state.currentTurn)) {
      const id = setTimeout(
        () => dispatch({ type: "system", seq, event: "hand-start", payload: { timestamp: Date.now() } }),
        BOT_DELAY_MS,
      );
      return () => clearTimeout(id);
    }

    // 1. Claim window: each bot with a claim asks the AI whether to take it.
    if (phase.type === "claim-window") {
      const decisions = [
        ...new Set(
          phase.availableClaims
            .map((c) => c.seat)
            .filter((s) => isBotSeat(s) && !phase.passed.includes(s)),
        ),
      ].map((seat) => {
        const bot = state.players[seat];
        const choice = getBestClaim(
          bot.hand,
          bot.melds,
          phase.tile,
          phase.availableClaims.filter((c) => c.seat === seat),
          difficultyOf(bot),
          Math.random,
          winContextOf(state, seat),
        );
        return { seat, choice };
      });

      // A claim is only accepted once no higher-priority seat is still undecided
      // (the human's buttons included), so send the strongest unblocked one first.
      const isBlocked = (seat: SeatIndex, kind: ClaimKind) =>
        phase.availableClaims.some(
          (c) =>
            c.seat !== seat &&
            !phase.passed.includes(c.seat) &&
            CLAIM_PRIORITY[c.kind] > CLAIM_PRIORITY[kind],
        );

      const claimNow = decisions
        .flatMap((d) => (d.choice === "pass" ? [] : [{ seat: d.seat, option: d.choice }]))
        .sort((a, b) => CLAIM_PRIORITY[b.option.kind] - CLAIM_PRIORITY[a.option.kind])
        .find((c) => !isBlocked(c.seat, c.option.kind));
      const passNow = decisions.find((d) => d.choice === "pass");

      const action: GameAction | undefined = claimNow
        ? {
            type: "claim",
            seq,
            seat: claimNow.seat,
            timestamp: Date.now(),
            payload: { kind: claimNow.option.kind, usingTiles: claimNow.option.usingTiles },
          }
        : passNow
          ? { type: "pass", seq, seat: passNow.seat, timestamp: Date.now() }
          : undefined;

      if (action === undefined) return undefined; // waiting on the human
      const id = setTimeout(() => dispatch(action), PASS_DELAY_MS);
      return () => clearTimeout(id);
    }

    // 2. Bot turns (seats 1-3): draw, then discard whatever the AI rates least useful.
    if ((phase.type === "draw" || phase.type === "action") && isBotSeat(phase.seat)) {
      const seat = phase.seat;

      if (phase.type === "draw") {
        const top = state.wall.liveTiles[0];
        if (top === undefined) return undefined; // wall exhausted: nothing to do yet
        // The engine ignores this tile and takes the real top of the wall.
        const id = setTimeout(
          () =>
            dispatch({
              type: "draw",
              seq,
              seat,
              timestamp: Date.now(),
              tile: top,
              fromDeadWall: false,
            }),
          BOT_DELAY_MS,
        );
        return () => clearTimeout(id);
      }

      const player = state.players[seat];

      // A bot never passes up a legal win: a drawn tile that completes a 3+ fan hand ends it.
      if (
        player.drawnTile !== null &&
        shouldDeclareSelfDrawWin(
          player.hand,
          player.melds,
          player.drawnTile,
          winContextOf(state, seat),
        )
      ) {
        const winningTile = player.drawnTile;
        const id = setTimeout(
          () =>
            dispatch({
              type: "win",
              seq,
              seat,
              timestamp: Date.now(),
              method: "self-draw",
              winningTile,
            }),
          BOT_DELAY_MS,
        );
        return () => clearTimeout(id);
      }

      const candidates = player.drawnTile ? [...player.hand, player.drawnTile] : player.hand;
      if (candidates.length === 0) return undefined;
      const tile = getBestDiscard(candidates, player.melds, difficultyOf(player));
      const id = setTimeout(
        () =>
          dispatch({
            type: "discard",
            seq,
            seat,
            timestamp: Date.now(),
            tile,
            fromDraw: player.drawnTile?.id === tile.id,
          }),
        BOT_DELAY_MS,
      );
      return () => clearTimeout(id);
    }

    return undefined;
  }, [state, phase, dispatch, isMultiplayer, humansKey]);

  /* ---------- Auto-draw: your own draw (and the opening deal) happens by itself ---------- */
  useEffect(() => {
    if (!canStart && !canDraw) return undefined;
    const id = setTimeout(drawTile, HUMAN_DRAW_DELAY_MS);
    return () => clearTimeout(id);
    // drawTile is rebuilt every render from the same state, so [state] is the real dependency.
  }, [state, canStart, canDraw]);

  /* ---------- Human actions ---------- */
  const drawTile = () => {
    const seq = state.history.length;
    if (canStart) {
      dispatch({
        type: "system",
        seq,
        event: "hand-start",
        payload: { timestamp: Date.now() },
      });
    } else if (canDraw) {
      dispatch({
        type: "draw",
        seq,
        seat: mySeat,
        timestamp: Date.now(),
        tile: state.wall.liveTiles[0],
        fromDeadWall: false,
      });
    }
  };

  const discardTile = (tile: Tile) => {
    if (!canDiscard) return;
    playSound("discard");
    dispatch({
      type: "discard",
      seq: state.history.length,
      seat: mySeat,
      timestamp: Date.now(),
      tile,
      fromDraw: me.drawnTile?.id === tile.id,
    });
  };

  const claim = (option: ClaimOption) => {
    playSound(option.kind === "win" ? "win" : "claim");
    dispatch({
      type: "claim",
      seq: state.history.length,
      seat: mySeat,
      timestamp: Date.now(),
      payload: { kind: option.kind, usingTiles: option.usingTiles },
    });
  };

  // "Next Hand": the engine keeps or passes the dealership (and the round wind) and deals again.
  // After the last hand it ends the match instead; from the match-complete card it starts a new one.
  // The seed for the new shuffle is chosen by whoever runs the game (App locally, the server online).
  const nextHand = () =>
    dispatch({ type: "system", seq: state.history.length, event: "round-advance" });
  const match = matchStatus(state);
  const matchOver = phase.type === "game-end";
  const payments = phase.type === "hand-end" ? (phase.payments ?? []) : [];
  // Why the hand scored what it did. The engine records it on the hand-end phase (so the server's
  // word is final); the client's own scoring is only a fallback for older states.
  const totalFan =
    (phase.type === "hand-end" ? phase.totalFan : undefined) ?? win?.result.totalFan ?? 0;
  const patternLines =
    (phase.type === "hand-end" ? phase.patterns : undefined) ??
    (win ? patternLabels(win.result) : []);
  const nextHandLabel = match.matchEndsNext ? "Finish Match" : "Next Hand";

  // Concealed kong: all four tiles. Added kong: the single fourth tile for an open pung.
  const declareConcealedKong = (tiles: Tile[]) => {
    playSound("claim");
    dispatch({
      type: "kong",
      seq: state.history.length,
      seat: mySeat,
      timestamp: Date.now(),
      variant: "concealed",
      tiles,
    });
  };

  const declareAddedKong = (tile: Tile) => {
    playSound("claim");
    dispatch({
      type: "kong",
      seq: state.history.length,
      seat: mySeat,
      timestamp: Date.now(),
      variant: "added",
      tiles: [tile],
    });
  };

  const declareSelfDrawWin = () => {
    if (!canWinNow || me.drawnTile === null) return;
    playSound("win");
    dispatch({
      type: "win",
      seq: state.history.length,
      seat: mySeat,
      timestamp: Date.now(),
      method: "self-draw",
      winningTile: me.drawnTile,
    });
  };

  const passClaim = () => {
    playSound("pass");
    dispatch({ type: "pass", seq: state.history.length, seat: mySeat, timestamp: Date.now() });
  };

  // Tap-to-pass: while claim buttons are showing, tapping the empty table (not a button) passes.
  const claimPending = phase.type === "claim-window" && myClaims.length > 0;

  // Online only: who is on the clock and for how long. Local play has no clock to enforce.
  const timer: TimerConfig | null =
    isMultiplayer && (phase.type === "action" || phase.type === "claim-window") && phase.deadline !== undefined
      ? phase.type === "action"
        ? {
            deadline: phase.deadline,
            totalMs: state.rules.turnTimeMs ?? TURN_TIME_MS,
            mine: phase.seat === mySeat,
            label: phase.seat === mySeat ? "Your turn" : `${playerTag(state.players[phase.seat], mySeat)} to play`,
          }
        : {
            deadline: phase.deadline,
            totalMs: state.rules.claimTimeMs ?? CLAIM_TIME_MS,
            mine: claimPending,
            label: claimPending ? "Claim or pass" : "Waiting for claims",
          }
      : null;
  const tapTable = (event: { target: EventTarget | null }) => {
    if (!claimPending) return;
    if ((event.target as HTMLElement | null)?.closest?.("button")) return;
    passClaim();
  };

  // River shape. Normally every river is six wide and as many rows deep as the longest needs
  // (three to start). On a wide, short table the top and bottom rivers run nine wide instead,
  // which makes the whole cross shorter, so the tiles can grow to fill the height.
  const crossBoxRef = useRef<HTMLDivElement | null>(null);
  const [crossShape, setCrossShape] = useState<CrossShape>("even");
  useLayoutEffect(() => {
    const el = crossBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const watch = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      setCrossShape(
        width / height >= STRETCH_RATIO ? "wide" : height / width >= STRETCH_RATIO ? "tall" : "even",
      );
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const discardCount = (offset: number): number =>
    state.players[((mySeat + offset) % 4) as SeatIndex].discards.filter((d) => d.claimedBy === undefined).length;
  const sideTiles = Math.max(discardCount(1), discardCount(3));
  const endTiles = Math.max(discardCount(0), discardCount(2));
  const rowsFor = (tiles: number, cols: number, min: number): number => Math.max(min, Math.ceil(tiles / cols));
  const evenRows = rowsFor(Math.max(sideTiles, endTiles), RIVER_COLS, RIVER_MIN_ROWS);
  // "Cols" is how many tiles run along a river; "rows" is how many deep it is.
  const sideCols = crossShape === "tall" ? RIVER_COLS_LONG : RIVER_COLS;
  const endCols = crossShape === "wide" ? RIVER_COLS_LONG : RIVER_COLS;
  const sideRows =
    crossShape === "tall" ? rowsFor(sideTiles, sideCols, RIVER_MIN_ROWS_LONG)
    : crossShape === "wide" ? rowsFor(sideTiles, sideCols, RIVER_MIN_ROWS)
    : evenRows;
  const endRows =
    crossShape === "wide" ? rowsFor(endTiles, endCols, RIVER_MIN_ROWS_LONG)
    : crossShape === "tall" ? rowsFor(endTiles, endCols, RIVER_MIN_ROWS)
    : evenRows;

  const lastDiscardId = state.lastDiscard?.tile.id;
  const activeSeat =
    phase.type === "draw" || phase.type === "action" ? phase.seat : undefined;

  return (
    <div className="ourjong-table" style={styles.table}>
      <style>{TABLE_CSS}</style>
      {toast && (
        <div key={toast.id} className="ourjong-cutin" style={styles.cutin} role="status">
          <div className="ourjong-cutin-band" style={styles.cutinBand}>
            <div className="ourjong-cutin-title" style={styles.cutinCall}>
              <div
                style={{
                  ...styles.cutinGlyph,
                  color: TONE_COLORS[toast.tone][0],
                  textShadow: toastShadow(toast.tone),
                }}
              >
                {toast.glyph}
              </div>
              <div
                style={{
                  ...styles.cutinTitle,
                  color: TONE_COLORS[toast.tone][0],
                  textShadow: toastShadow(toast.tone),
                }}
              >
                {toast.title}
              </div>
            </div>
            <div style={styles.cutinSubtitle}>{toast.subtitle}</div>
          </div>
        </div>
      )}
      <div className="ourjong-stage">

        <div className="ourjong-board" style={styles.board}>
          {/* Opponents are face down; "Peek" turns their concealed tiles over. */}
          {(
            [
              [2, "top", "top"],
              [3, "left", "left"],
              [1, "right", "right"],
            ] as const
          ).map(([offset, side, area]) => {
            // Offsets are relative to you, so every player sees themselves at the bottom.
            const seat = ((mySeat + offset) % 4) as SeatIndex;
            return (
              <div
                key={seat}
                className={side === "top" ? undefined : "ourjong-seat-side"}
                style={{ ...styles.seatArea, gridArea: area }}
              >
                {/* Their quick-chat emoji: beside the hand on the sides, under it at the top. */}
                {emojis[seat] && (
                  <span
                    key={emojis[seat]!.id}
                    className="ourjong-emoji-float"
                    style={{ ...styles.emojiFloat, ...EMOJI_ANCHOR[side] }}
                    onAnimationEnd={() => onEmojiDone?.(seat)}
                    aria-hidden="true"
                  >
                    {emojis[seat]!.emoji}
                  </span>
                )}
                <OpponentSeat
                  player={state.players[seat]}
                  side={side}
                  peek={peek}
                  mySeat={mySeat}
                  setTileEl={setTileEl}
                />
              </div>
            );
          })}

          <section
            onClick={tapTable}
            title={claimPending ? "Tap the table to pass" : undefined}
            style={{ ...styles.center, ...(claimPending ? styles.centerTappable : null), gridArea: "center" }}
            aria-label="Table centre"
          >
            {/* No instructional text on the board: the compass shows whose turn it is. The
                words stay for screen readers only, and a rejected move still gets its alert. */}
            <p style={styles.srOnly} role="status" aria-live="polite">
              {phaseMessage(state, myClaims.length > 0, mySeat)}
            </p>
            {notice && (
              <p style={{ ...styles.minimumNote, ...styles.noticeFloat }} role="alert">
                {notice}
              </p>
            )}

            {/* The cross: a river in front of each seat around a compass in the middle. */}
            <div ref={crossBoxRef} className="ourjong-cross-box" style={styles.crossBox}>
              <div
                className="ourjong-cross"
                style={{
                  ...styles.cross,
                  ["--rows" as string]: sideRows,
                  ["--rowsv" as string]: endRows,
                  ["--mid" as string]: sideCols,
                }}
              >
                {(
                  [
                    ["top", 2, "top"],
                    ["left", 3, "left"],
                    ["right", 1, "right"],
                    ["me", 0, "me"],
                  ] as const
                ).map(([side, offset, area]) => {
                  const seat = ((mySeat + offset) % 4) as SeatIndex;
                  return (
                    <div key={side} style={{ ...styles.riverArea, ...RIVER_ALIGN[side], gridArea: area }}>
                      <River
                        player={state.players[seat]}
                        side={side}
                        rows={side === "left" || side === "right" ? sideRows : endRows}
                        cols={side === "left" || side === "right" ? sideCols : endCols}
                        lastTileId={lastDiscardId}
                        mySeat={mySeat}
                      />
                    </div>
                  );
                })}
                <div style={{ ...styles.compassArea, gridArea: "compass" }}>
                  <Compass
                    state={state}
                    mySeat={mySeat}
                    activeSeat={activeSeat}
                    timer={timer}
                    clockOffsetMs={clockOffsetMs}
                    roll={roll}
                    onRollDone={() => setRoll(null)}
                  />
                </div>
              </div>
            </div>
          </section>

          <footer className="ourjong-footer" style={{ ...styles.handArea, gridArea: "me" }}>
            {/* Quick chat: rises from just above your hand, fades out, then clears itself. */}
            {emojis[mySeat] && (
              <span
                key={emojis[mySeat]!.id}
                className="ourjong-emoji-float"
                style={styles.emojiFloat}
                onAnimationEnd={() => onEmojiDone?.(mySeat)}
                aria-hidden="true"
              >
                {emojis[mySeat]!.emoji}
              </span>
            )}
            {/* Floating action bar: right-aligned, directly above your hand. */}
            <div style={styles.floatZone}>
              {showMinimumNote && (
                <p style={styles.minimumNote} role="status">
                  Minimum {myContext.minimumFan} Fan required to win
                </p>
              )}
              {(claimPending || canWinNow || hiddenKongs.length > 0 || promotedKongs.length > 0) && (
              <div style={styles.actionBar} aria-label="Actions">
                {canWinNow && (
                  <button
                    type="button"
                    onClick={declareSelfDrawWin}
                    className="ourjong-btn ourjong-btn-win"
                  >
                    Hu
                  </button>
                )}
                {phase.type === "claim-window" &&
                  myClaims.map((option, i) => {
                    const recommended = coachClaim === option;
                    return (
                      <button
                        key={`claim-${i}`}
                        type="button"
                        onClick={() => claim(option)}
                        className={`ourjong-btn ourjong-btn-${BUTTON_VARIANT[option.kind]}${recommended ? " ourjong-coach" : ""}`}
                        style={recommended ? styles.coachRing : undefined}
                      >
                        {claimLabel(option, phase.tile)}
                      </button>
                    );
                  })}
                {hiddenKongs.map((tiles, i) => (
                  <button
                    key={`hidden-${i}`}
                    type="button"
                    onClick={() => declareConcealedKong(tiles)}
                    className="ourjong-btn ourjong-btn-kong"
                  >
                    Kong
                  </button>
                ))}
                {promotedKongs.map((option) => (
                  <button
                    key={`added-${option.tile.id}`}
                    type="button"
                    onClick={() => declareAddedKong(option.tile)}
                    className="ourjong-btn ourjong-btn-kong"
                  >
                    Kong
                  </button>
                ))}
                {claimPending && (
                  <button
                    type="button"
                    onClick={passClaim}
                    className={`ourjong-btn ourjong-btn-pass${coachClaim === "pass" ? " ourjong-coach" : ""}`}
                    style={coachClaim === "pass" ? styles.coachRing : undefined}
                  >
                    Skip
                  </button>
                )}
              </div>
              )}
            </div>

            {/* Plate and exposed melds share one slim row above your hand. */}
            <div className="ourjong-seatrow" style={styles.seatRow}>
              {/* Your meld track is always there, at a fixed size, even while empty. */}
              <div
                className="ourjong-melds"
                style={me.melds.length > 0 ? styles.melds : { ...styles.melds, ...styles.meldsEmpty }}
                aria-label="Your melds"
              >
                {me.melds.map((meld, i) => (
                  <div key={i} style={styles.meld}>
                    {meld.tiles.map((tile) => (
                      <TileView key={tile.id} tile={tile} />
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div
              ref={fidget.handRef}
              className="ourjong-hand"
              style={{
                ...styles.hand,
                ...(canDiscard ? null : { touchAction: "none" }),
              }}
              aria-label="Your hand"
              {...fidget.handlers}
            >
              {handEntries(me).map(({ tile, drawn }) => (
                <HandTile
                  key={tile.id}
                  active={tile.id === coachDiscardId}
                  drawn={drawn}
                  elRef={setTileEl(tile.id)}
                >
                  <TileView
                    tile={tile}
                    isDrawn={drawn}
                    faceDown={concealMine}
                    onClick={
                      canDiscard
                        ? () => {
                            // A fidget that was cut off by your turn must not discard by accident.
                            if (performance.now() < fidget.suppressClickUntil.current) return;
                            discardTile(tile);
                          }
                        : undefined
                    }
                  />
                </HandTile>
              ))}
            </div>
          </footer>
        </div>

      </div>

      {drawGame && (
        <div style={styles.overlay} role="dialog" aria-modal="true" aria-label="Hand result">
          <div style={styles.scoreCard}>
            <div style={styles.drawGlyph} aria-hidden="true">
              流局
            </div>
            <h2 style={styles.scoreTitle}>Draw Game - No Tiles Remaining</h2>
            <p style={styles.cardMuted}>Nobody won this hand. No points change hands.</p>
            <p style={styles.cardNote}>
              {matchTitle(match)} · {nextHandNote(state, match, mySeat)}
            </p>
            <button type="button" onClick={nextHand} style={styles.actionButton}>
              {nextHandLabel}
            </button>
          </div>
        </div>
      )}

      {matchOver && (
        <div style={styles.overlay} role="dialog" aria-modal="true" aria-label="Match result">
          <div style={styles.scoreCard}>
            <div style={styles.drawGlyph} aria-hidden="true">
              終局
            </div>
            <h2 style={styles.scoreTitle}>Match Complete</h2>
            <p style={styles.cardMuted}>
              {match.totalRounds === 1
                ? "The East round is finished."
                : `All ${match.totalRounds} rounds are finished.`}
            </p>
            <Leaderboard state={state} mySeat={mySeat} />
            <button type="button" onClick={nextHand} style={styles.actionButton}>
              New Match
            </button>
          </div>
        </div>
      )}

      {win && (
        <div style={styles.overlay} role="dialog" aria-modal="true" aria-label="Hand result">
          <div style={styles.scoreCard}>
            <h2 style={styles.scoreTitle}>
              {win.seat === mySeat
                ? "You win!"
                : `${playerTag(state.players[win.seat], mySeat)} wins`}
            </h2>
            <p style={styles.muted}>
              {windTag(state.players[win.seat].seatWind)}
              {win.selfDrawn ? " · self-drawn" : ""}
            </p>
            <div style={styles.scoreHand} aria-label="Winning hand">
              {win.melds.map((meld, i) => (
                <div key={`meld-${i}`} style={styles.meld}>
                  {meld.tiles.map((tile) => (
                    <TileView key={tile.id} tile={tile} />
                  ))}
                </div>
              ))}
              <div style={styles.meld}>
                {win.hand.map((tile) => (
                  <TileView key={tile.id} tile={tile} />
                ))}
                <TileView tile={win.tile} isDrawn />
              </div>
            </div>

            <FanSummary totalFan={totalFan} patterns={patternLines} selfDrawn={win.selfDrawn} />

            <PaymentList payments={payments} state={state} mySeat={mySeat} />

            <p style={styles.cardNote}>
              {matchTitle(match)} · {nextHandNote(state, match, mySeat)}
            </p>
            <button type="button" onClick={nextHand} style={styles.actionButton}>
              {nextHandLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Inline styles cannot hold keyframes or :hover, so the motion lives in a <style> tag. The
// rules mirror Tailwind utilities (transition-all duration-200 ease-in-out, hover:-translate-y-2,
// hover:drop-shadow-xl, tracking-widest, ring-4) so they can be swapped for classes later.
const TABLE_CSS = `
/* ---- Layout: the table is a full-screen canvas. .ourjong-table fills whatever is left under
   the nav and is a size container, so everything sizes itself in container units (cqw / cqh)
   with no hard-coded reserves.
     --tm  YOUR tile width       --o  opponents' tile width
     --t   UI unit (buttons, text, spacing) ---- */
.ourjong-table {
  container-type: size;
  position: relative;
  overflow: hidden;
}
.ourjong-stage {
  /* Portrait: a tall column. Width is what limits the tiles. */
  --t: max(18px, min(calc(100cqw / 16.5), calc(100cqh / 18.5)));
  --tm: var(--t);
  --o: calc(var(--t) * 0.9);
  width: 100cqw;
  height: 100cqh;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}
.ourjong-emoji-float { animation: ourjong-emoji-rise 2.6s ease-out both; }
@keyframes ourjong-emoji-rise {
  0%   { opacity: 0; transform: translate(var(--ex, -50%), 10px) scale(0.6); }
  14%  { opacity: 1; transform: translate(var(--ex, -50%), 0) scale(1.12); }
  26%  { transform: translate(var(--ex, -50%), -6px) scale(1); }
  72%  { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--ex, -50%), -50px) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .ourjong-emoji-float { animation-name: ourjong-emoji-fade; }
  @keyframes ourjong-emoji-fade { 0%, 80% { opacity: 1; transform: translate(var(--ex, -50%), 0); } 100% { opacity: 0; transform: translate(var(--ex, -50%), 0); } }
}
.ourjong-turn { animation: ourjong-turn-pulse 1.4s ease-in-out infinite; }
@keyframes ourjong-turn-pulse { 50% { transform-origin: center; filter: brightness(1.25); } }
.ourjong-board { grid-area: 1 / 1; min-width: 0; min-height: 0; }

/* Landscape: left and right players get their own columns, the middle column holds Across,
   the river and the buttons, and YOUR hand docks in a full-width bottom bar. Your tiles are
   sized by the screen width; the opponents' by the height left above your bar. */
/* Wide tables (landscape, ultra-wide, an unfolded foldable): sized by the height, since the
   width is plentiful. The container's own shape decides, not the device's orientation, so a
   near-square foldable screen gets whichever layout fits it better. */
@container (min-aspect-ratio: 5/4) {
  .ourjong-stage {
    --tm: max(20px, min(calc(100cqw / 22), calc(100cqh / 11)));
    --t: calc(var(--tm) * 0.75);
    /* Opponent tiles: the side hands run the full height beside the table, so fourteen of them
       plus the bottom row have to fit it. The rivers take whatever height is left over. */
    --o: max(11px, min(calc(var(--tm) * 0.9), calc((100cqh - var(--oj-corner, 0px) - var(--tm) * 1.9) / 16.2)));
  }
  /* The menu coin floats over the top-left corner; both side columns start below it. */
  .ourjong-seat-side { padding-top: var(--oj-corner, 0px); box-sizing: border-box; }
  .ourjong-board {
    grid-template-areas: "left top right" "left center right" "me me me" !important;
  }
  /* The hand owns the middle of the screen. The melds sit in the column to its right, and the
     column to its left is an equal empty one, so the hand is centred on the screen itself. */
  .ourjong-footer {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: end !important;
    justify-items: center;
    column-gap: calc(var(--tm) * 0.4);
  }
  .ourjong-seatrow { display: contents !important; }
  .ourjong-hand    { grid-column: 2; grid-row: 1; }
  /* A fixed box beside the hand, two meld rows high, so the footer is the same height with or
     without melds. It never grows past its column; meld tiles shrink to fit. */
  .ourjong-melds {
    --meld-tile: calc(var(--tm) * 0.42);
    grid-column: 3;
    grid-row: 1;
    justify-self: start;
    flex-wrap: wrap !important;
    align-content: center;
    width: min(100%, calc(var(--tm) * 4.4));
    height: calc(var(--tm) * 1.4) !important;
  }
  .ourjong-hand { flex-wrap: nowrap !important; }
}

/* Action buttons: glossy, tactile pills (Mahjong Soul style). */
.ourjong-btn {
  position: relative;
  /* Strict centring: the label is a flex item of a flex box, so it sits dead centre both ways. */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  box-sizing: border-box;
  min-height: max(44px, calc(var(--t, 44px) * 1.1));
  min-width: max(80px, calc(var(--t, 44px) * 2.4));
  padding: 0 calc(var(--t, 44px) * 0.7);
  border: 1.5px solid rgba(255,255,255,0.6);
  border-radius: max(14px, calc(var(--t, 44px) * 0.42));
  font-family: "Inter", "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, system-ui, sans-serif;
  font-size: max(0.92rem, calc(var(--t, 44px) * 0.36));
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  white-space: nowrap;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  overflow: hidden;
  animation: ourjong-btn-in 220ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
  transition: transform 120ms ease, filter 120ms ease, box-shadow 120ms ease;
}
/* Glossy top highlight. */
.ourjong-btn::before {
  content: "";
  position: absolute;
  inset: 0 0 50% 0;
  border-radius: inherit;
  background: linear-gradient(180deg, rgba(255,255,255,0.38), rgba(255,255,255,0));
  pointer-events: none;
}
@media (hover: hover) {
  .ourjong-btn:hover { transform: translateY(-2px); filter: brightness(1.08) saturate(1.05); }
}
.ourjong-btn:active { transform: translateY(3px) scale(0.97); filter: brightness(0.94); transition-duration: 60ms; }
.ourjong-btn:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }

.ourjong-btn-win {
  background: linear-gradient(180deg, #ffe680 0%, #ffb02e 45%, #f0561a 100%);
  border-color: #fff3c4;
  color: #4a1700;
  text-shadow: 0 1px 0 rgba(255,255,255,0.55);
  box-shadow: 0 5px 0 #a8360b, 0 0 22px 4px rgba(255,140,30,0.75), 0 10px 18px rgba(0,0,0,0.4);
  animation: ourjong-btn-in 220ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both, ourjong-btn-glow 1.4s ease-in-out 220ms infinite;
}
.ourjong-btn-pong {
  background: linear-gradient(180deg, #8fd0ff 0%, #2f86f0 50%, #1747b8 100%);
  box-shadow: 0 5px 0 #0f2f7d, 0 0 18px 3px rgba(59,130,246,0.6), 0 10px 18px rgba(0,0,0,0.4);
}
.ourjong-btn-chow {
  background: linear-gradient(180deg, #8af0b4 0%, #22b865 50%, #0e7a3f 100%);
  box-shadow: 0 5px 0 #09562c, 0 0 18px 3px rgba(34,197,94,0.6), 0 10px 18px rgba(0,0,0,0.4);
}
.ourjong-btn-kong {
  background: linear-gradient(180deg, #8ff0f0 0%, #17b3c4 50%, #0b6b9a 100%);
  box-shadow: 0 5px 0 #084a6c, 0 0 18px 3px rgba(34,211,238,0.55), 0 10px 18px rgba(0,0,0,0.4);
}
.ourjong-btn-pass {
  background: linear-gradient(180deg, rgba(90,98,112,0.78), rgba(28,32,42,0.85));
  border-color: rgba(255,255,255,0.3);
  color: #e5e7eb;
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 0 rgba(0,0,0,0.5), 0 0 12px 1px rgba(148,163,184,0.25), 0 10px 18px rgba(0,0,0,0.35);
}
.ourjong-btn:active { box-shadow: 0 1px 0 rgba(0,0,0,0.5), 0 0 10px rgba(255,255,255,0.25); }

@keyframes ourjong-btn-in {
  from { opacity: 0; transform: translateX(24px) scale(0.85); }
  to   { opacity: 1; transform: none; }
}
@keyframes ourjong-btn-glow {
  0%, 100% { filter: brightness(1); }
  50%      { filter: brightness(1.18); }
}
@media (prefers-reduced-motion: reduce) {
  .ourjong-btn, .ourjong-btn-win { animation: none; }
}

/* Hand tiles: lift and a deeper shadow on hover, smooth transitions. */
.ourjong-hand-tile {
  position: relative;
  transition: all ${SLIDE_MS}ms ease-in-out;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,0.3));
}
@media (hover: hover) {
  .ourjong-hand-tile:hover {
    transform: translateY(-0.5rem);
    z-index: 2;
    filter: drop-shadow(0 14px 8px rgba(0,0,0,0.55));
  }
}
.ourjong-hand-tile:focus-within {
  transform: translateY(-0.5rem);
  z-index: 2;
  filter: drop-shadow(0 14px 8px rgba(0,0,0,0.55));
}

/* Turn clock: the bar shrinks smoothly between ticks and pulses red when time is short. */
.ourjong-timer-fill { transition: transform 260ms linear, background-color 300ms ease; }
@keyframes ourjong-timer-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.ourjong-timer-urgent .ourjong-timer-fill { animation: ourjong-timer-pulse 0.7s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .ourjong-timer-fill { transition: none; }
  .ourjong-timer-urgent .ourjong-timer-fill { animation: none; }
}

/* Coach: pulsing blue ring (ring-4 ring-blue-500). */
@keyframes ourjong-coach-pulse {
  0%, 100% { box-shadow: 0 0 0 4px #3b82f6, 0 0 6px 4px rgba(59,130,246,0.35); }
  50%      { box-shadow: 0 0 0 4px #60a5fa, 0 0 18px 8px rgba(59,130,246,0.8); }
}
.ourjong-coach { animation: ourjong-coach-pulse 1.1s ease-in-out infinite; }

/* River: the newest discard drops in, then pulses red and gold. */
@keyframes ourjong-drop-in {
  0%   { opacity: 0; transform: translateY(-34px) scale(1.6); }
  70%  { opacity: 1; transform: translateY(2px) scale(0.97); }
  100% { opacity: 1; transform: none; }
}
@keyframes ourjong-last-pulse {
  0%, 100% { box-shadow: 0 0 0 2px #fbbf24, 0 0 8px 2px rgba(239,68,68,0.45); }
  50%      { box-shadow: 0 0 0 3px #ef4444, 0 0 18px 6px rgba(239,68,68,0.85); }
}
.ourjong-last-discard {
  position: relative;
  z-index: 1;
  background: rgba(251,191,36,0.28);
  box-shadow: 0 0 0 2px #fbbf24, 0 0 10px 3px rgba(239,68,68,0.55);
  animation:
    ourjong-drop-in 320ms cubic-bezier(0.2, 1.3, 0.4, 1) both,
    ourjong-last-pulse 1.2s ease-in-out 320ms infinite;
}

/* Cut-in: a dark band across the table, the word slams in, then everything fades. */
@keyframes ourjong-cutin-fade {
  0%   { opacity: 0; }
  10%  { opacity: 1; }
  78%  { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes ourjong-cutin-band {
  0%   { transform: scaleY(0.15); }
  14%  { transform: scaleY(1); }
  100% { transform: scaleY(1); }
}
@keyframes ourjong-cutin-pop {
  0%   { transform: scale(0.35); }
  16%  { transform: scale(1.18); }
  28%  { transform: scale(1); }
  100% { transform: scale(1.08); }
}
.ourjong-cutin { animation: ourjong-cutin-fade ${TOAST_MS}ms ease-out forwards; }
.ourjong-cutin-band { animation: ourjong-cutin-band ${TOAST_MS}ms ease-out forwards; }
.ourjong-cutin-title { animation: ourjong-cutin-pop ${TOAST_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1) forwards; }

@keyframes ourjong-limit-glow {
  0%, 100% { box-shadow: 0 0 8px 1px rgba(242,177,52,0.55); }
  50%      { box-shadow: 0 0 20px 6px rgba(255,214,102,0.95); }
}
.ourjong-limit { animation: ourjong-limit-glow 1.8s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  .ourjong-hand-tile { transition: none; }
  .ourjong-limit,
  .ourjong-coach,
  .ourjong-last-discard,
  .ourjong-cutin,
  .ourjong-cutin-band,
  .ourjong-cutin-title { animation: none; }
}
`;

/** Where each opponent's emoji starts, relative to their seat area. */
const EMOJI_ANCHOR: Record<"top" | "left" | "right", CSSProperties> = {
  top: { left: "50%", top: "100%", bottom: "auto", ["--ex" as string]: "-50%" },
  left: { left: "100%", top: "50%", bottom: "auto", ["--ex" as string]: "0%" },
  right: { right: "100%", left: "auto", top: "50%", bottom: "auto", ["--ex" as string]: "0%" },
};

const styles: Record<string, CSSProperties> = {
  // Fills <main> under the nav; the .ourjong-table class makes it a size container.
  table: {
    flex: "1 1 0",
    minWidth: 0,
    minHeight: 0,
    width: "100%",
    boxSizing: "border-box",
    background: "radial-gradient(ellipse at center, #1c5a46 0%, #12382d 100%)",
    color: "#f4efe0",
    fontFamily: "system-ui, sans-serif",
  },
  // The four-sided table: across on top, left and right at the edges, you at the bottom.
  board: {
    boxSizing: "border-box",
    height: "100%",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    gridTemplateAreas: '". top ." "left center right" "me me me"',
    gap: "calc(var(--t) * 0.15)",
    padding:
      "max(calc(var(--t) * 0.1), env(safe-area-inset-top)) max(calc(var(--t) * 0.2), env(safe-area-inset-right)) max(calc(var(--t) * 0.2), env(safe-area-inset-bottom)) max(calc(var(--t) * 0.2), env(safe-area-inset-left))",
  },
  seatArea: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0, minHeight: 0 },
  seatCell: {
    ["--tile-width" as string]: "var(--o)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--o) * 0.2)",
    padding: "calc(var(--o) * 0.2)",
    borderRadius: 12,
    boxShadow: "0 0 0 2px transparent",
    transition: "box-shadow 150ms ease",
  },
  seatRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--t) * 0.15) calc(var(--t) * 0.6)",
  },
  sideBlock: { display: "flex", alignItems: "flex-start", gap: "calc(var(--o) * 0.2)" },
  oppHandRow: { position: "relative", display: "flex", gap: "calc(var(--o) * 0.04)" },
  oppHandColumn: { position: "relative", display: "flex", gap: "calc(var(--o) * 0.04)" },
  sideSlot: {
    position: "relative",
    width: "calc(var(--tile-width) * 1.3334)",
    height: "var(--tile-width)",
    flex: "none",
  },
  // Melds are drawn a little smaller than the concealed tiles (0.8 x) so that four kongs still
  // fit the track: along the hand's length for the sides, along its width for the top.
  topMeldTrack: {
    ["--tile-width" as string]: "calc(var(--o) * 0.8)",
    height: "calc(var(--o) * 0.8 * 1.3334)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
  },
  sideMeldTrack: {
    ["--tile-width" as string]: "calc(var(--o) * 0.8)",
    width: "calc(var(--o) * 0.8 * 1.3334)",
    flex: "none",
  },
  sideMelds: {
    display: "flex",
    flexWrap: "nowrap",
    gap: "calc(var(--o) * 0.25)",
  },
  sideMeld: { display: "flex", gap: "calc(var(--o) * 0.04)" },
  oppSlot: { position: "relative", display: "flex" },
  oppDrawnGap: { marginRight: "calc(var(--o) * 0.25)" },
  muted: { opacity: 0.7, fontSize: "max(0.72rem, calc(var(--t) * 0.27))", margin: 0 },
  // On the cream result cards the table's light text would vanish, so these are dark.
  cardMuted: { margin: 0, color: "#4b5563", fontSize: "0.95rem" },
  cardNote: { margin: 0, color: "#374151", fontSize: "0.9rem", fontWeight: 600 },
  // Result cards are cream, so these are dark. Amounts are right-aligned in a column.
  paymentList: { listStyle: "none", margin: 0, padding: 0, width: "100%", display: "flex", flexDirection: "column", gap: 4 },
  paymentRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "6px 12px",
    borderRadius: 9999,
    background: "rgba(31,36,48,0.07)",
    color: "#1f2430",
    fontSize: "0.95rem",
  },
  paymentAmount: { fontWeight: 800, color: "#15803d", fontVariantNumeric: "tabular-nums" },
  leaderboard: { listStyle: "none", margin: 0, padding: 0, width: "100%", display: "flex", flexDirection: "column", gap: 6 },
  leaderRow: {
    display: "grid",
    gridTemplateColumns: "3.2em 1fr auto",
    alignItems: "center",
    gap: 10,
    padding: "8px 14px",
    borderRadius: 9999,
    background: "rgba(31,36,48,0.07)",
    color: "#1f2430",
    textAlign: "left",
  },
  leaderFirst: { background: "#f2b134", fontWeight: 800 },
  leaderRank: { fontWeight: 800 },
  leaderName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  leaderScore: { fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  // Dealer: a gold wind disc and a small 莊 chip.
  matchBanner: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--t) * 0.1) calc(var(--t) * 0.4)",
    padding: "calc(var(--t) * 0.08) calc(var(--t) * 0.45)",
    borderRadius: 9999,
    background: "rgba(0,0,0,0.38)",
    border: "1px solid rgba(242,177,52,0.5)",
  },
  matchTitle: { color: "#f2b134", fontSize: "max(0.85rem, calc(var(--t) * 0.34))", letterSpacing: "0.04em" },
  matchMeta: {
    display: "inline-flex",
    alignItems: "center",
    gap: "calc(var(--t) * 0.15)",
    fontSize: "max(0.72rem, calc(var(--t) * 0.27))",
    opacity: 0.85,
  },
  center: {
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--t) * 0.15)",
    textAlign: "center",
    overflow: "hidden",
  },
  // Words for screen readers only; they take no room on the board.
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  // A rejected move's message floats over the table instead of pushing the rivers down.
  noticeFloat: { position: "absolute", top: "calc(var(--t) * 0.3)", left: "50%", transform: "translateX(-50%)", zIndex: 8, margin: 0 },
  centerTappable: { cursor: "pointer" },
  // Floats just above the hand, flush right: the warning note over the buttons.
  emojiFloat: {
    position: "absolute",
    left: "50%",
    bottom: "calc(100% + 4px)",
    zIndex: 20,
    fontSize: "3rem",
    lineHeight: 1,
    pointerEvents: "none",
    userSelect: "none",
    filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.45))",
    willChange: "transform, opacity",
  },
  floatZone: {
    position: "absolute",
    right: "calc(var(--tm, var(--t)) * 0.3)",
    bottom: "100%",
    zIndex: 5,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "calc(var(--t) * 0.15)",
    maxWidth: "100%",
    paddingBottom: "calc(var(--t) * 0.15)",
    pointerEvents: "none",
  },
  actionBar: {
    display: "flex",
    flexWrap: "wrap-reverse",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: "calc(var(--t) * 0.3)",
    pointerEvents: "auto",
  },
  minimumNote: {
    margin: 0,
    padding: "calc(var(--t) * 0.1) calc(var(--t) * 0.35)",
    borderRadius: 9999,
    background: "rgba(0,0,0,0.4)",
    color: "#fde68a",
    fontSize: "max(0.75rem, calc(var(--t) * 0.27))",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
  },
  timer: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--t) * 0.08)",
    width: "min(100%, calc(var(--t) * 8))",
    padding: "calc(var(--t) * 0.12) calc(var(--t) * 0.3)",
    borderRadius: 9999,
    background: "rgba(0,0,0,0.4)",
    boxSizing: "border-box",
  },
  // Your own clock sits above your hand: wider, with a gold edge so it reads as "you".
  timerMine: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--t) * 0.08)",
    width: "min(100%, calc(var(--t) * 10))",
    padding: "calc(var(--t) * 0.15) calc(var(--t) * 0.4)",
    borderRadius: 9999,
    background: "rgba(0,0,0,0.55)",
    border: "2px solid rgba(242,177,52,0.7)",
    boxSizing: "border-box",
  },
  timerText: {
    display: "flex",
    justifyContent: "space-between",
    gap: "calc(var(--t) * 0.3)",
    fontSize: "max(0.72rem, calc(var(--t) * 0.27))",
    fontWeight: 700,
    letterSpacing: "0.04em",
    fontVariantNumeric: "tabular-nums",
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
  },
  timerTrack: {
    width: "100%",
    height: "max(4px, calc(var(--t) * 0.14))",
    borderRadius: 9999,
    background: "rgba(255,255,255,0.15)",
    overflow: "hidden",
  },
  timerFill: {
    height: "100%",
    width: "100%",
    borderRadius: 9999,
    transformOrigin: "left center",
  },
  // Side seats share the pill shape; only the name is allowed less room so the edge stays slim.

  // ---- Rivers and the compass ----
  crossBox: {
    flex: "1 1 0",
    minHeight: 0,
    width: "100%",
    containerType: "size",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  cross: {
    // r = width of one river tile. Across, the cross is the 6 r hub plus a side river on each
    // side (--rows deep); down, it is the hub plus the top and bottom rivers (--rowsv deep).
    // The tile size is whichever of the two the space allows, so it always fills the box.
    ["--r" as string]:
      "max(8px, min(calc(100cqw / (6.4 + var(--rows, 3) * 2.6668)), calc(100cqh / (var(--mid, 6) + 0.4 + var(--rowsv, 3) * 2.6668))))",
    ["--depth" as string]: "calc(var(--r) * 1.3334 * var(--rows, 3))",
    ["--depthv" as string]: "calc(var(--r) * 1.3334 * var(--rowsv, 3))",
    display: "grid",
    gridTemplateColumns: "var(--depth) calc(var(--r) * 6) var(--depth)",
    gridTemplateRows: "var(--depthv) calc(var(--r) * max(6, var(--mid, 6))) var(--depthv)",
    gridTemplateAreas: '"top top top" "left compass right" "me me me"',
    gap: "calc(var(--r) * 0.1)",
    flex: "none",
  },
  riverArea: { display: "flex", minWidth: 0, minHeight: 0 },
  river: { display: "grid", gap: 0 },
  riverCell: {
    position: "relative",
    width: "var(--r)",
    height: "calc(var(--r) * 1.3334)",
    boxSizing: "border-box",
  },
  riverCellSide: {
    position: "relative",
    width: "calc(var(--r) * 1.3334)",
    height: "var(--r)",
    boxSizing: "border-box",
  },
  riverEmpty: { borderRadius: 3, background: "rgba(0,0,0,0.12)", boxShadow: "inset 0 0 0 1px rgba(244,239,224,0.05)" },
  riverTile: {
    ["--tile-width" as string]: "var(--r)",
    position: "absolute",
    top: "50%",
    left: "50%",
    width: "var(--r)",
    height: "calc(var(--r) * 1.3334)",
    display: "flex",
  },
  compassArea: { display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0, minHeight: 0 },
  compass: {
    position: "relative",
    // Always a true circle, 6 tiles across, whatever shape the cell around it is.
    width: "calc(var(--r) * 6)",
    height: "calc(var(--r) * 6)",
    flex: "none",
    borderRadius: "50%",
    background: "radial-gradient(circle at 50% 40%, rgba(0,0,0,0.38), rgba(0,0,0,0.55))",
    boxShadow: "inset 0 0 0 2px rgba(242,177,52,0.45), inset 0 0 0 calc(var(--r) * 0.5) rgba(0,0,0,0.12)",
    fontSize: "calc(var(--r) * 0.5)",
  },
  compassEdge: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "calc(var(--r) * 1.1)",
    height: "calc(var(--r) * 1.1)",
    borderRadius: "50%",
    background: "rgba(0,0,0,0.45)",
    color: "rgba(244,239,224,0.75)",
    fontFamily: '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif',
    fontSize: "calc(var(--r) * 0.65)",
    fontWeight: 900,
    lineHeight: 1,
    transition: "background 150ms ease, color 150ms ease, box-shadow 150ms ease",
  },
  compassEdgeOn: {
    background: "#f2b134",
    color: "#1f2430",
    boxShadow: "0 0 calc(var(--r) * 0.8) rgba(242,177,52,0.75)",
  },
  compassEdgeWaiting: { boxShadow: "0 0 0 2px #5aa9ff, 0 0 12px rgba(90,169,255,0.6)" },
  compassDealer: {
    position: "absolute",
    top: "-22%",
    left: "-22%",
    width: "46%",
    height: "46%",
    boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
    borderRadius: "50%",
    background: "#c0392b",
    color: "#fff",
    fontSize: "0.4em",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  compassScore: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    fontSize: "calc(var(--r) * 0.44)",
    fontWeight: 700,
    letterSpacing: "0.02em",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    textShadow: "0 1px 2px rgba(0,0,0,0.7)",
  },
  compassCore: {
    position: "absolute",
    inset: "25% 23% 29%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--r) * 0.1)",
    textAlign: "center",
    minWidth: 0,
  },
  compassGlyph: {
    fontFamily: '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif',
    fontSize: "calc(var(--r) * 1.05)",
    fontWeight: 900,
    lineHeight: 1,
    color: "#f2b134",
    textShadow: "0 2px 6px rgba(0,0,0,0.5)",
  },
  compassRound: { fontSize: "calc(var(--r) * 0.5)", fontWeight: 800, letterSpacing: "0.04em", whiteSpace: "nowrap" },
  compassHand: { fontSize: "calc(var(--r) * 0.4)", opacity: 0.75, whiteSpace: "nowrap" },
  timerCompass: { display: "flex", flexDirection: "column", alignItems: "center", gap: "calc(var(--r) * 0.06)", width: "62%" },
  timerSeconds: {
    fontSize: "calc(var(--r) * 0.62)",
    fontWeight: 900,
    fontVariantNumeric: "tabular-nums",
    lineHeight: 1,
  },
  handArea: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--t) * 0.15)",
    minWidth: 0,
  },
  actionButton: {
    minHeight: "max(40px, calc(var(--t, 44px) * 1.15))",
    minWidth: "max(72px, calc(var(--t, 44px) * 2.2))",
    padding: "0 calc(var(--t, 44px) * 0.6)",
    borderRadius: "calc(var(--t, 44px) * 0.6)",
    border: "none",
    background: "#f2b134",
    color: "#1f2430",
    fontSize: "max(0.95rem, calc(var(--t, 44px) * 0.42))",
    fontWeight: 700,
    cursor: "pointer",
    touchAction: "manipulation",
  },
  passButton: {
    minHeight: "max(40px, calc(var(--t, 44px) * 1.15))",
    minWidth: "max(72px, calc(var(--t, 44px) * 2.2))",
    padding: "0 calc(var(--t, 44px) * 0.6)",
    borderRadius: "calc(var(--t, 44px) * 0.6)",
    border: "2px solid rgba(244,239,224,0.5)",
    background: "transparent",
    color: "#f4efe0",
    fontSize: "max(0.95rem, calc(var(--t, 44px) * 0.42))",
    fontWeight: 600,
    cursor: "pointer",
    touchAction: "manipulation",
  },
  claimRow: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "calc(var(--t) * 0.2)",
  },
  melds: {
    ["--tile-width" as string]: "var(--meld-tile, max(16px, calc(var(--tm, var(--t)) * 0.6)))",
    boxSizing: "border-box",
    // One tile high plus the padding, whether or not there is a meld to hold.
    height: "calc(var(--tm, var(--t)) * 1.06)",
    display: "flex",
    flexWrap: "nowrap",
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--tm, var(--t)) * 0.3)",
    padding: "calc(var(--tm, var(--t)) * 0.12) calc(var(--tm, var(--t)) * 0.3)",
    borderRadius: 12,
    background: "rgba(0,0,0,0.22)",
    boxShadow: "inset 0 0 0 1px rgba(244,239,224,0.14)",
  },
  meldsEmpty: { background: "transparent", boxShadow: "none" },
  meld: { display: "flex", flex: "none", gap: "calc(var(--tm, var(--t)) * 0.04)" },
  hand: {
    ["--tile-width" as string]: "var(--tm, var(--t))",
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "calc(var(--tm) * 0.25) calc(var(--tm) * 0.07)",
    paddingTop: "calc(var(--tm) * 0.25)",
  },
  drawnGap: { marginLeft: "calc(var(--tm) * 0.25)" },
  cutin: {
    position: "fixed",
    inset: 0,
    zIndex: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },
  cutinBand: {
    width: "100%",
    boxSizing: "border-box",
    padding: "20px 16px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    background:
      "linear-gradient(90deg, transparent 0%, rgba(8,20,15,0.82) 18%, rgba(8,20,15,0.82) 82%, transparent 100%)",
  },
  cutinCall: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
  },
  cutinGlyph: {
    fontFamily: '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif',
    fontSize: "clamp(4.5rem, 26vw, 9rem)",
    fontWeight: 900,
    lineHeight: 1,
    whiteSpace: "nowrap",
    WebkitTextStroke: "2px rgba(15,15,15,0.85)",
    paintOrder: "stroke fill",
  },
  cutinTitle: {
    fontSize: "clamp(1.6rem, 9vw, 3.2rem)",
    fontWeight: 900,
    lineHeight: 1,
    letterSpacing: "0.3em",
    paddingLeft: "0.3em", // balances the trailing letter-spacing so the word looks centred
    textAlign: "center",
    WebkitTextStroke: "1.5px rgba(15,15,15,0.85)",
    paintOrder: "stroke fill",
    whiteSpace: "nowrap",
  },
  cutinSubtitle: {
    fontSize: "clamp(0.85rem, 3.5vw, 1.25rem)",
    fontWeight: 700,
    letterSpacing: "0.3em",
    paddingLeft: "0.3em",
    textTransform: "uppercase",
    color: "#f4efe0",
    textShadow: "0 2px 6px rgba(0,0,0,0.7)",
  },
  // The ring is a box-shadow (the equivalent of ring-4 ring-blue-500); the slot keeps the
  // layout identical whether or not a tile is highlighted.
  coachSlot: { display: "flex", borderRadius: 8 },
  coachRing: {
    display: "flex",
    borderRadius: 8,
    boxShadow: "0 0 0 4px #3b82f6",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    background: "rgba(0,0,0,0.6)",
  },
  scoreCard: {
    width: "100%",
    maxWidth: 420,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    padding: 20,
    borderRadius: 16,
    background: "#fbf7ea",
    color: "#1f2430",
    textAlign: "center",
    boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
    maxHeight: "calc(100dvh - 32px)",
    overflowY: "auto",
  },
  scoreTitle: { margin: 0, fontSize: "1.4rem" },
  // The big 流局 over a draw game's card.
  drawGlyph: {
    fontFamily: '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif',
    fontSize: "3.2rem",
    fontWeight: 900,
    letterSpacing: "0.15em",
    color: "#b45309", // dark amber: the card is cream, so the table's gold would wash out
  },
  fanBlock: { width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  // The pattern pills: navy with the fan in gold, so they read on the cream card.
  patternPills: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
  },
  patternPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px",
    borderRadius: 9999,
    background: "#1f2430",
    color: "#fbf7ea",
    fontSize: "0.88rem",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  patternPillLimit: { background: "#f2b134", color: "#3a2600", boxShadow: "0 0 0 2px #b45309" },
  pillDot: { opacity: 0.6 },
  pillFan: { color: "#f2b134", fontWeight: 800 },
  pillFanLimit: { color: "#3a2600", fontWeight: 800 },
  // The total: a dark accent box with gold figures.
  totalBox: {
    width: "100%",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    padding: "10px 14px",
    borderRadius: 14,
    background: "#1f2430",
    border: "2px solid #f2b134",
    color: "#fbf7ea",
  },
  totalBoxLimit: { borderColor: "#fff3c4", background: "linear-gradient(180deg, #2b2410 0%, #1f2430 100%)" },
  totalTop: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" },
  totalLabel: { fontSize: "0.8rem", letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.75 },
  totalFan: { fontSize: "2rem", fontWeight: 900, color: "#f2b134", lineHeight: 1.1 },
  totalMath: { fontSize: "1.05rem", fontVariantNumeric: "tabular-nums" },
  totalPoints: { color: "#f2b134", fontSize: "1.3rem" },
  totalNote: { fontSize: "0.85rem", opacity: 0.85 },
  limitTag: {
    padding: "2px 12px",
    borderRadius: 9999,
    border: "2px solid #fff3c4",
    background: "linear-gradient(180deg, #ffe680 0%, #f2b134 55%, #d98a12 100%)",
    color: "#3a2600",
    fontSize: "0.8rem",
    fontWeight: 900,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  },
  scoreHand: {
    ["--tile-width" as string]: "clamp(20px, 5.5vw, 28px)",
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    margin: "6px 0",
  },
};
