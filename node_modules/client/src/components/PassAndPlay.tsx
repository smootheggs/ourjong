import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ClaimKind, GameAction, GameState, SeatIndex } from "@ourjong/engine";
import { GameTable } from "./GameTable";

/**
 * Pass-and-play: one device, up to four people, bots in any seat that nobody is sitting at.
 *
 * The game itself is the same engine and the same reducer as a solo game. Three things are added:
 *
 *  1. A seat setup screen: each of the four seats is a Human or a Bot.
 *  2. A privacy screen. It covers the table whenever a different person has to act, and only
 *     goes away when that person taps "Tap to Reveal Hand".
 *  3. The table turns to face whoever revealed it, so their hand is always the one along the
 *     bottom edge.
 *
 * Bots run in the background (the table does that) and never trigger the privacy screen.
 */

export type SeatKind = "human" | "bot";
export type SeatSetup = readonly [SeatKind, SeatKind, SeatKind, SeatKind];

/** East, South, West and North at the start of the first hand. */
export const DEFAULT_SEAT_SETUP: SeatSetup = ["human", "human", "bot", "bot"];

const WINDS = [
  { name: "East", glyph: "東" },
  { name: "South", glyph: "南" },
  { name: "West", glyph: "西" },
  { name: "North", glyph: "北" },
] as const;

const CLAIM_PRIORITY: Record<ClaimKind, number> = { chow: 1, pung: 2, kong: 2, win: 3 };

export const humanSeatsOf = (setup: SeatSetup): SeatIndex[] =>
  setup.flatMap((kind, seat) => (kind === "human" ? [seat as SeatIndex] : []));

/**
 * The person the game is waiting for, or null when it is waiting on a bot (or nobody).
 *
 *  - Dealing in, drawing and discarding: whoever's turn it is, if they are a person.
 *  - A claim window: a person who can still claim the discard and has not passed. When several
 *    people can, the one with the strongest claim decides first, because the engine will not
 *    accept a weaker claim while a stronger one is still undecided.
 *  - A finished hand or match: nobody. The result card belongs to the whole table.
 */
export function pendingHuman(state: GameState, humans: readonly SeatIndex[]): SeatIndex | null {
  const phase = state.phase;
  switch (phase.type) {
    case "setup":
      return humans.includes(state.currentTurn) ? state.currentTurn : null;
    case "draw":
    case "action":
      return humans.includes(phase.seat) ? phase.seat : null;
    case "claim-window": {
      let best: { seat: SeatIndex; priority: number } | null = null;
      for (const claim of phase.availableClaims) {
        if (!humans.includes(claim.seat) || phase.passed.includes(claim.seat)) continue;
        const priority = CLAIM_PRIORITY[claim.kind];
        if (best === null || priority > best.priority) best = { seat: claim.seat, priority };
      }
      return best?.seat ?? null;
    }
    default:
      return null;
  }
}

/* ---------- The table ---------- */

/**
 * The game table for a hotseat game: runs the privacy screen and turns the table to face the
 * person who revealed it. Give it a `key` that changes with each new game.
 */
export function PassAndPlayTable({
  state,
  dispatch,
  humanSeats,
  emojis,
  onEmojiDone,
  onViewSeat,
}: {
  state: GameState;
  dispatch: (action: GameAction) => void;
  humanSeats: readonly SeatIndex[];
  emojis?: Partial<Record<number, { id: number; emoji: string }>>;
  onEmojiDone?: (seat: number) => void;
  /** Reports whose hand is on screen, so the app can send emoji from the right seat. */
  onViewSeat?: (seat: SeatIndex) => void;
}) {
  const shared = humanSeats.length > 1;

  // Whose hand is on screen. With one person there is nobody to hide it from.
  const [viewSeat, setViewSeat] = useState<SeatIndex | null>(shared ? null : (humanSeats[0] ?? 0));
  const actor = pendingHuman(state, humanSeats);

  // The privacy screen is derived, not an effect, so it is up in the very frame the turn passes.
  const masked = shared && actor !== null && actor !== viewSeat;
  const handOver = state.phase.type === "hand-end" || state.phase.type === "game-end";

  const mySeat: SeatIndex = viewSeat ?? humanSeats[0] ?? 0;
  // Between two people the bots play on, so the hand on screen is turned face down until the next
  // person asks for it. Once a hand is over, everything is on show anyway.
  const concealMine = shared && actor === null && !handOver;

  useEffect(() => {
    onViewSeat?.(mySeat);
  }, [mySeat, onViewSeat]);

  return (
    <>
      <GameTable
        gameState={state}
        onPlayerAction={dispatch}
        mySeat={mySeat}
        humanSeats={humanSeats}
        concealMine={concealMine || viewSeat === null}
        emojis={emojis}
        onEmojiDone={onEmojiDone}
      />
      {masked && actor !== null && (
        <PrivacyScreen
          key={actor}
          wind={state.players[actor].seatWind}
          seat={actor}
          onReveal={() => setViewSeat(actor)}
        />
      )}
    </>
  );
}

/* ---------- Privacy screen ---------- */

const windIndex = (wind: string): number => {
  const i = WINDS.findIndex((w) => w.name.toLowerCase() === wind);
  return i < 0 ? 0 : i;
};

/**
 * An opaque, frosted cover over the whole screen. It says only whose turn it is: nothing about
 * what that person is about to do, so a claim is not given away to whoever is looking.
 */
function PrivacyScreen({
  wind,
  seat,
  onReveal,
}: {
  wind: string;
  seat: SeatIndex;
  onReveal: () => void;
}) {
  const w = WINDS[windIndex(wind)]!;
  // A short beat before the button works, so the tap that finished the last move cannot
  // reveal the next person's hand by accident.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 500);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="pp-privacy" style={pp.privacy} role="dialog" aria-modal="true" aria-label={`Pass device to ${w.name}`}>
      <style>{PP_CSS}</style>
      <div style={pp.privacyBody}>
        <div style={pp.privacyGlyph} aria-hidden="true">
          {w.glyph}
        </div>
        <p style={pp.privacyKicker}>Pass device to</p>
        <h2 style={pp.privacyWind}>{w.name}</h2>
        <p style={pp.privacySeat}>Seat {seat + 1}</p>
        <button
          type="button"
          className="pp-reveal"
          style={armed ? pp.reveal : { ...pp.reveal, ...pp.revealWaiting }}
          disabled={!armed}
          onClick={onReveal}
        >
          Tap to Reveal Hand
        </button>
      </div>
    </div>
  );
}

/* ---------- Seat setup ---------- */

/** The Pass & Play setup screen: who sits where. */
export function SeatSetupScreen({
  value,
  onChange,
  onDeal,
  onBack,
}: {
  value: SeatSetup;
  onChange: (next: SeatSetup) => void;
  onDeal: () => void;
  onBack: () => void;
}) {
  const humans = value.filter((kind) => kind === "human").length;

  const set = (seat: number, kind: SeatKind) => {
    // At least one person has to be playing.
    if (kind === "bot" && value[seat] === "human" && humans === 1) return;
    onChange(value.map((current, i) => (i === seat ? kind : current)) as unknown as SeatSetup);
  };

  const summary =
    humans === 4 ? "Four players, one device" : humans === 1 ? "One player against three bots" : `${humans} players and ${4 - humans} bot${4 - humans === 1 ? "" : "s"}`;

  return (
    <main className="pp-setup" style={pp.setup}>
      <style>{PP_CSS}</style>
      <div style={pp.setupBody}>
        <h1 style={pp.setupTitle}>Pass &amp; Play</h1>
        <p style={pp.setupSub}>{summary}</p>

        <div className="pp-seatlist" style={pp.seatList}>
          {WINDS.map((w, seat) => (
            <div key={w.name} style={pp.seatCard}>
              <div style={pp.seatGlyph} aria-hidden="true">
                {w.glyph}
              </div>
              <div style={pp.seatName}>{w.name}</div>
              <div style={pp.seatChoice} role="group" aria-label={`${w.name} seat`}>
                {(["human", "bot"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="pp-choice"
                    aria-pressed={value[seat] === kind}
                    onClick={() => set(seat, kind)}
                    style={value[seat] === kind ? pp.choiceOn : pp.choice}
                  >
                    {kind === "human" ? "Human" : "Bot"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <button type="button" className="oj-start" style={pp.deal} onClick={onDeal}>
          Deal
        </button>
        <button type="button" className="oj-link" style={pp.back} onClick={onBack}>
          Back
        </button>
      </div>
    </main>
  );
}

/* ---------- Styles ---------- */

const SERIF = '"Noto Serif TC", "Songti SC", "STSong", "SimSun", serif';

const PP_CSS = `
@keyframes pp-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes pp-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.pp-privacy { animation: pp-fade 120ms ease-out both; }
.pp-privacy > div > * { animation: pp-rise 420ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.pp-reveal { transition: transform 120ms ease, filter 120ms ease, opacity 200ms ease; }
.pp-reveal:not(:disabled):active { transform: scale(0.96); }
@media (hover: hover) { .pp-reveal:not(:disabled):hover { filter: brightness(1.08); } }
@media (max-height: 520px) and (min-width: 600px) {
  .pp-setup > div { width: min(100%, 760px) !important; padding-top: 12px !important; gap: 8px !important; }
  .pp-seatlist { display: grid !important; grid-template-columns: 1fr 1fr; }
}
.pp-choice { transition: background 150ms ease, color 150ms ease; }
.pp-choice:focus-visible, .pp-reveal:focus-visible { outline: 2px solid #ffe3a1; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .pp-privacy, .pp-privacy > div > * { animation: none; } }
`;

const pp: Record<string, CSSProperties> = {
  privacy: {
    position: "fixed",
    inset: 0,
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))",
    // Opaque on purpose: the frost is only for looks, nothing behind it may show through.
    background:
      "radial-gradient(120% 90% at 50% 20%, rgba(30,66,56,0.99), rgba(7,20,16,1) 70%)",
    WebkitBackdropFilter: "blur(30px) saturate(1.2)",
    backdropFilter: "blur(30px) saturate(1.2)",
    color: "#f4efe0",
    touchAction: "manipulation",
    userSelect: "none",
  },
  privacyBody: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: "clamp(2px, 1vmin, 8px)",
    padding: "clamp(18px, 4vmin, 40px) clamp(24px, 6vmin, 64px)",
    borderRadius: 28,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.14)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)",
    maxWidth: "min(92vw, 460px)",
  },
  privacyGlyph: {
    fontFamily: SERIF,
    fontWeight: 900,
    fontSize: "clamp(3.5rem, 16vmin, 7rem)",
    lineHeight: 1,
    color: "#f2b134",
    textShadow: "0 4px 24px rgba(242,177,52,0.35)",
  },
  privacyKicker: {
    margin: "clamp(4px, 1.5vmin, 12px) 0 0",
    fontSize: "clamp(0.8rem, 2.4vmin, 1rem)",
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: "rgba(244,239,224,0.65)",
    fontWeight: 600,
  },
  privacyWind: {
    margin: 0,
    fontSize: "clamp(2rem, 8vmin, 3.4rem)",
    fontWeight: 800,
    letterSpacing: "0.02em",
  },
  privacySeat: {
    margin: 0,
    fontSize: "clamp(0.75rem, 2vmin, 0.9rem)",
    color: "rgba(244,239,224,0.45)",
  },
  reveal: {
    marginTop: "clamp(14px, 3.5vmin, 28px)",
    minHeight: 54,
    padding: "0 clamp(24px, 6vmin, 44px)",
    border: "none",
    borderRadius: 9999,
    background: "linear-gradient(180deg, #ffd978, #e09a1d)",
    color: "#3a2400",
    fontSize: "clamp(1rem, 2.8vmin, 1.2rem)",
    fontWeight: 800,
    letterSpacing: "0.02em",
    cursor: "pointer",
    touchAction: "manipulation",
    boxShadow: "0 8px 22px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.55)",
  },
  revealWaiting: { opacity: 0.45, cursor: "default" },

  setup: {
    position: "absolute",
    inset: 0,
    overflowY: "auto",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))",
    background: "radial-gradient(120% 90% at 50% 0%, #1f5a47, #12382d 60%, #0a241c)",
    color: "#f4efe0",
  },
  setupBody: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "clamp(8px, 2vmin, 16px)",
    width: "min(100%, 440px)",
    margin: "auto",
    padding: "clamp(40px, 8vmin, 56px) 0 16px",
  },
  setupTitle: { margin: 0, fontSize: "clamp(1.6rem, 5vmin, 2.2rem)", fontWeight: 800 },
  setupSub: { margin: "0 0 4px", color: "rgba(244,239,224,0.65)", fontSize: "0.95rem" },
  seatList: { display: "flex", flexDirection: "column", gap: 8, width: "100%" },
  seatCard: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 8px 8px 14px",
    borderRadius: 16,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
  },
  seatGlyph: { fontFamily: SERIF, fontWeight: 900, fontSize: "1.7rem", color: "#f2b134", width: "1.4em", textAlign: "center" },
  seatName: { flex: 1, fontSize: "1.05rem", fontWeight: 700 },
  seatChoice: { display: "flex", gap: 3, padding: 3, borderRadius: 9999, background: "rgba(0,0,0,0.3)" },
  choice: {
    minHeight: 40,
    minWidth: 76,
    padding: "0 14px",
    border: "none",
    borderRadius: 9999,
    background: "transparent",
    color: "rgba(244,239,224,0.75)",
    fontSize: "0.92rem",
    fontWeight: 700,
    cursor: "pointer",
    touchAction: "manipulation",
  },
  choiceOn: {
    minHeight: 40,
    minWidth: 76,
    padding: "0 14px",
    border: "none",
    borderRadius: 9999,
    background: "rgba(244,239,224,0.94)",
    color: "#12382d",
    fontSize: "0.92rem",
    fontWeight: 700,
    cursor: "pointer",
    touchAction: "manipulation",
    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
  },
  deal: {
    marginTop: 8,
    width: "100%",
    minHeight: 54,
    border: "none",
    borderRadius: 9999,
    background: "linear-gradient(180deg, #ffd978, #e09a1d)",
    color: "#3a2400",
    fontSize: "1.1rem",
    fontWeight: 800,
    cursor: "pointer",
    touchAction: "manipulation",
    boxShadow: "0 8px 22px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.55)",
  },
  back: {
    border: "none",
    background: "transparent",
    color: "rgba(244,239,224,0.6)",
    fontSize: "0.9rem",
    fontWeight: 600,
    letterSpacing: "0.06em",
    cursor: "pointer",
    padding: "8px 12px",
  },
};
