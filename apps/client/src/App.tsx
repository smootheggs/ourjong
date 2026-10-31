import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { initializeHKOSGame, processAction } from "@ourjong/engine";
import type { GameAction, GameState, SeatIndex } from "@ourjong/engine";
import { GameTable } from "./components/GameTable";
import { Lobby } from "./components/Lobby";
import { ReferenceGuide } from "./components/ReferenceGuide";
import { TutorialSandbox } from "./components/TutorialSandbox";
import { useMultiplayer } from "./network/useMultiplayer";
import { DEFAULT_SEAT_SETUP, PassAndPlayTable, SeatSetupScreen, humanSeatsOf } from "./components/PassAndPlay";
import type { SeatSetup } from "./components/PassAndPlay";

/**
 * Thin wrapper over the engine's pure reducer. The engine throws on illegal moves,
 * so the wrapper keeps the previous state instead of crashing the UI.
 */
type AppAction = GameAction | { type: "new-game"; seed: string };

function gameReducer(state: GameState, action: AppAction): GameState {
  // Starting from the menu always deals a fresh game.
  if (action.type === "new-game") return createInitialState(action.seed);
  try {
    return processAction(state, action);
  } catch (error) {
    console.warn("Rejected action:", action, error);
    return state;
  }
}

/** A new shuffle seed: unguessable and different on every call. */
function freshSeed(): string {
  const bytes = new Uint32Array(2);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    bytes[0] = Math.floor(Math.random() * 2 ** 32);
    bytes[1] = Math.floor(Math.random() * 2 ** 32);
  }
  return `${Date.now().toString(36)}-${bytes[0].toString(36)}${bytes[1].toString(36)}`;
}

function createInitialState(seed: string = freshSeed()): GameState {
  return initializeHKOSGame("demo-game", ["p1", "p2", "p3", "p4"], seed);
}

/** "menu" is the landing screen; the rest are the pages the top bar switches between. */
type View = "menu" | "setup" | "play" | "guide" | "tutorial";
// "online" is still here, switched off for now: the menu offers Local and Pass & Play only.
type Mode = "local" | "hotseat" | "online";


const MODES: readonly { id: Mode; label: string; hint: string }[] = [
  { id: "local", label: "Local Play", hint: "You and three computer players" },
  { id: "hotseat", label: "Pass & Play", hint: "Share one device, with bots in any empty seat" },
];

export default function App() {
  // The local game lives here, so opening the guide never loses your hand. The table itself
  // is unmounted while the guide is open, which pauses the bots until you come back.
  const [state, dispatchToEngine] = useReducer(gameReducer, undefined, () => createInitialState());

  // "Next Hand" is the engine's own "round-advance": it keeps or passes the dealership, moves
  // the round wind on and ends the match after the last hand. The reducer must stay pure, so the
  // fresh shuffle seed is picked here, before the action is dispatched.
  const dispatch = useCallback((action: GameAction) => {
    if (action.type === "system" && action.event === "round-advance" && action.payload?.seed === undefined) {
      const seed = freshSeed();
      dispatchToEngine({ ...action, payload: { ...action.payload, seed } });
      return;
    }
    dispatchToEngine(action);
  }, []);
  const [view, setView] = useState<View>("menu");
  const [mode, setMode] = useState<Mode>("local");
  // The kind of game that is actually running (the menu's choice only applies to the next one).
  const [gameMode, setGameMode] = useState<Mode>("local");
  // Pass & Play: who sits where (edited on the setup screen), and whose hand is on screen now.
  const [seatSetup, setSeatSetup] = useState<SeatSetup>(DEFAULT_SEAT_SETUP);
  const [hotseatView, setHotseatView] = useState<SeatIndex>(0);
  // Local-play aids. They live in the top bar and are handed to the table.
  const [coachOn, setCoachOn] = useState(false);
  const [peekOn, setPeekOn] = useState(false);
  // Emoji floating over each seat (absolute seat numbers). `id` changes on every send so the
  // same emoji can be sent twice in a row and restart its animation.
  const [emojis, setEmojis] = useState<Partial<Record<number, { id: number; emoji: string }>>>({});
  const showEmoji = useCallback((seat: number, emoji: string) => {
    setEmojis((current) => ({ ...current, [seat]: { id: (current[seat]?.id ?? 0) + 1, emoji } }));
  }, []);
  const clearEmoji = useCallback((seat: number) => {
    setEmojis((current) => {
      const { [seat]: _gone, ...rest } = current;
      return rest;
    });
  }, []);

  // The socket exists only in Multiplayer mode, and it survives switching to the guide or the
  // tutorial, so you stay seated at the table while you look something up.
  const online = useMultiplayer(mode === "online", showEmoji);
  const seated = online.gameState !== null && online.mySeat !== null;

  // Online: tell the server (it relays to everyone else) and show it over your own seat at once.
  // Local: just your own seat, which is always East.
  const handleEmojiClick = (emoji: string) => {
    if (gameMode === "online") {
      if (online.mySeat === null) return;
      online.sendEmoji(emoji);
      showEmoji(online.mySeat, emoji);
    } else if (gameMode === "hotseat") {
      showEmoji(hotseatView, emoji);
    } else {
      showEmoji(0, emoji);
    }
  };

  // Leaving a running game gives up the seat, so it takes two taps.
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    if (!confirmLeave) return undefined;
    const id = setTimeout(() => setConfirmLeave(false), 3000);
    return () => clearTimeout(id);
  }, [confirmLeave]);

  const leaveTable = () => {
    if (!confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    setConfirmLeave(false);
    online.leave();
  };

  // Start Game: a local game is dealt fresh each time (the dice roll with it); a multiplayer
  // game goes to the lobby. Resume picks the local game up where it was left.
  const startGame = () => {
    if (mode === "hotseat") {
      setView("setup");
      return;
    }
    if (mode === "local") {
      dispatchToEngine({ type: "new-game", seed: freshSeed() });
      setGameMode("local");
    }
    setView("play");
  };
  // Pass & Play: the seats are chosen, deal a fresh game.
  const dealHotseat = () => {
    dispatchToEngine({ type: "new-game", seed: freshSeed() });
    setGameMode("hotseat");
    setView("play");
  };
  const resumable = mode === "online" ? seated : state.history.length > 0 && gameMode === mode;

  if (view === "menu") {
    return (
      <div style={styles.app}>
        <style>{GLOBAL_CSS}</style>
        <MainMenu
          mode={mode}
          onMode={setMode}
          onStart={startGame}
          onResume={resumable ? () => setView("play") : null}
          onOpen={setView}
        />
      </div>
    );
  }

  if (view === "setup") {
    return (
      <div style={styles.app}>
        <style>{GLOBAL_CSS}</style>
        <SeatSetupScreen
          value={seatSetup}
          onChange={setSeatSetup}
          onDeal={dealHotseat}
          onBack={() => setView("menu")}
        />
      </div>
    );
  }

  return (
    <div style={styles.app}>
      {/* The app is a fullscreen canvas: the page itself never scrolls. */}
      <style>{GLOBAL_CSS}</style>
      {view === "play" && !(gameMode === "online" && !seated) && <SocialMenu onEmoji={handleEmojiClick} />}
      {/* No bar and no title: just the coin, floating in the corner, opening the menu. */}
      <CornerMenu
        view={view}
        mode={gameMode}
        seated={seated}
        coachOn={coachOn}
        onCoach={setCoachOn}
        peekOn={peekOn}
        onPeek={setPeekOn}
        confirmLeave={confirmLeave}
        onLeave={leaveTable}
        onGo={setView}
      />

      <main style={view === "play" && !(gameMode === "online" && !seated) ? styles.mainFixed : styles.mainPage}>
        {view === "play" && gameMode === "hotseat" && (
          <PassAndPlayTable
            key={state.random.seed}
            state={state}
            dispatch={dispatch}
            humanSeats={humanSeatsOf(seatSetup)}
            emojis={emojis}
            onEmojiDone={clearEmoji}
            onViewSeat={setHotseatView}
          />
        )}

        {view === "play" && gameMode === "local" && (
          <GameTable gameState={state} onPlayerAction={dispatch} coachOn={coachOn} peek={peekOn} emojis={emojis} onEmojiDone={clearEmoji} />
        )}

        {view === "play" &&
          gameMode === "online" &&
          (online.gameState !== null && online.mySeat !== null ? (
            <GameTable
              gameState={online.gameState}
              onPlayerAction={online.sendAction}
              isMultiplayer
              mySeat={online.mySeat}
              clockOffsetMs={online.clockOffsetMs}
              emojis={emojis}
              onEmojiDone={clearEmoji}
              notice={
                online.status === "disconnected" ? "Connection lost. Reconnecting…" : online.actionError
              }
            />
          ) : (
            <Lobby
              status={online.status}
              joining={online.joining}
              roomCode={online.roomCode}
              room={online.room}
              error={online.error}
              actionError={online.actionError}
              onJoin={online.join}
              onLeave={online.leave}
              onUpdateSettings={online.updateSettings}
            />
          ))}

        {view === "guide" && <ReferenceGuide />}
        {view === "tutorial" && <TutorialSandbox />}
      </main>
    </div>
  );
}

/* ---------- Play-aid switches ---------- */

const BulbIcon = () => (
  <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z" />
  </svg>
);
const EyeIcon = () => (
  <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** A modern toggle switch: icon, label and a sliding thumb on a small track. */
function Switch({
  label,
  on,
  onChange,
  icon,
  block = false,
}: {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
  icon: ReactNode;
  /** A full-width row, for lists. */
  block?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="oj-switch"
      aria-label={label}
      style={{
        ...styles.switchBase,
        ...(on ? styles.switchOn : null),
        ...(block ? styles.switchBlock : null),
      }}
    >
      <span style={styles.switchIcon}>{icon}</span>
      <span className="oj-switch-label" style={block ? { flex: 1, textAlign: "left" } : undefined}>
        {label}
      </span>
      <span className="oj-switch-track" style={on ? { ...styles.switchTrack, ...styles.switchTrackOn } : styles.switchTrack} aria-hidden="true">
        <span style={on ? { ...styles.switchThumb, ...styles.switchThumbOn } : styles.switchThumb} />
      </span>
    </button>
  );
}

/* ---------- The corner coin and its menu ---------- */

const BookIcon = () => (
  <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16M8 7h8" />
  </svg>
);
const PuzzleIcon = () => (
  <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M9 9h.01M15 15h.01M9 15h.01M15 9h.01" />
  </svg>
);
const ExitIcon = () => (
  <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />
  </svg>
);
const HomeIcon = () => (
  <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />
  </svg>
);

/**
 * The only chrome on screen during a game: the gold 麻 coin in the top-left corner. Tapping it
 * opens a glass panel with the secondary controls; tapping the coin again, tapping anywhere
 * outside the panel, or pressing Escape closes it.
 */
function CornerMenu({
  view,
  mode,
  seated,
  coachOn,
  onCoach,
  peekOn,
  onPeek,
  confirmLeave,
  onLeave,
  onGo,
}: {
  view: View;
  mode: Mode;
  seated: boolean;
  coachOn: boolean;
  onCoach: (on: boolean) => void;
  peekOn: boolean;
  onPeek: (on: boolean) => void;
  confirmLeave: boolean;
  onLeave: () => void;
  onGo: (view: View) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // Going somewhere closes the panel; flipping a switch leaves it open.
  const go = (next: View) => {
    setOpen(false);
    onGo(next);
  };

  const playing = view === "play";
  return (
    <div ref={root} style={styles.cornerRoot}>
      <button
        type="button"
        className="oj-corner-coin"
        style={open ? { ...styles.cornerCoin, ...styles.cornerCoinOpen } : styles.cornerCoin}
        onClick={() => setOpen((on) => !on)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
      >
        麻
      </button>

      {open && (
        <div className="oj-dropdown" style={styles.dropdown} role="menu" aria-label="Game menu">
          {!playing && (
            <button type="button" role="menuitem" className="oj-item" style={styles.item} onClick={() => go("play")}>
              <span style={styles.switchIcon}>
                <HomeIcon />
              </span>
              Back to game
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="oj-item"
            style={view === "guide" ? { ...styles.item, ...styles.itemOn } : styles.item}
            onClick={() => go("guide")}
          >
            <span style={styles.switchIcon}>
              <BookIcon />
            </span>
            Reference Guide
          </button>
          <button
            type="button"
            role="menuitem"
            className="oj-item"
            style={view === "tutorial" ? { ...styles.item, ...styles.itemOn } : styles.item}
            onClick={() => go("tutorial")}
          >
            <span style={styles.switchIcon}>
              <PuzzleIcon />
            </span>
            Tutorial Puzzles
          </button>

          {playing && mode === "local" && (
            <>
              <div style={styles.itemRule} role="separator" />
              <Switch block label="Coach" on={coachOn} onChange={onCoach} icon={<BulbIcon />} />
              <Switch block label="Peek" on={peekOn} onChange={onPeek} icon={<EyeIcon />} />
            </>
          )}

          {mode === "online" && seated && (
            <>
              <div style={styles.itemRule} role="separator" />
              <button
                type="button"
                role="menuitem"
                className="oj-item"
                style={{ ...styles.item, ...styles.itemDanger }}
                onClick={() => {
                  onLeave();
                  if (confirmLeave) setOpen(false);
                }}
              >
                <span style={styles.switchIcon}>
                  <ExitIcon />
                </span>
                {confirmLeave ? "Tap again to leave" : "Leave table"}
              </button>
            </>
          )}

          <div style={styles.itemRule} role="separator" />
          <button type="button" role="menuitem" className="oj-item" style={styles.item} onClick={() => go("menu")}>
            <span style={styles.switchIcon}>
              <HomeIcon />
            </span>
            Main menu
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Quick chat ---------- */

const QUICK_EMOJIS = ["👋", "😅", "🀄", "😤", "🙏", "👏", "😂", "🤔"] as const;

const ChatIcon = () => (
  <svg viewBox="0 0 24 24" width="54%" height="54%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5h16v11H9l-5 4z" />
  </svg>
);

/**
 * The top-right counterpart to the corner coin: a glass chat button that opens a grid of quick
 * emoji. Closes the same ways the main menu does.
 */
function SocialMenu({ onEmoji }: { onEmoji: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // Shows the emoji over your own seat; sending it to other players comes with the chat backend.
  const handleEmojiClick = (emoji: string) => {
    console.log("Quick chat emoji:", emoji);
    onEmoji(emoji);
    setOpen(false);
  };

  return (
    <div ref={root} style={styles.socialRoot}>
      <button
        type="button"
        className="oj-corner-coin"
        style={open ? { ...styles.socialButton, ...styles.socialButtonOpen } : styles.socialButton}
        onClick={() => setOpen((on) => !on)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Quick chat"
      >
        <ChatIcon />
      </button>

      {open && (
        <div className="oj-dropdown oj-dropdown-right" style={styles.socialDropdown} role="menu" aria-label="Quick chat">
          <div style={styles.emojiGrid}>
            {QUICK_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                className="oj-emoji"
                style={styles.emojiButton}
                onClick={() => handleEmojiClick(emoji)}
                aria-label={`Send ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Main menu ---------- */

function MainMenu({
  mode,
  onMode,
  onStart,
  onResume,
  onOpen,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  onStart: () => void;
  onResume: (() => void) | null;
  onOpen: (view: View) => void;
}) {
  return (
    <main className="oj-menu" style={styles.menu}>
      <div className="oj-menu-rings" style={styles.menuRings} aria-hidden="true" />
      <div className="oj-menu-body" style={styles.menuBody}>
        <div className="oj-menu-coin" style={styles.menuCoin} aria-hidden="true">
          麻
        </div>
        <h1 style={styles.menuTitle}>Ourjong</h1>
        <p style={styles.menuTagline}>Hong Kong Old Style Mahjong</p>

        <button type="button" className="oj-start" style={styles.menuStart} onClick={onStart}>
          Start Game
        </button>
        {onResume && (
          <button type="button" className="oj-link" style={styles.menuResume} onClick={onResume}>
            Resume game
          </button>
        )}

        <div style={styles.menuModes} role="group" aria-label="Game mode">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onMode(item.id)}
              aria-pressed={mode === item.id}
              title={item.hint}
              style={mode === item.id ? styles.menuModeOn : styles.menuMode}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div style={styles.menuLinks}>
          <button type="button" className="oj-link" style={styles.menuLink} onClick={() => onOpen("guide")}>
            Reference Guide
          </button>
          <span style={styles.menuDot} aria-hidden="true">
            ·
          </span>
          <button type="button" className="oj-link" style={styles.menuLink} onClick={() => onOpen("tutorial")}>
            Tutorial Puzzles
          </button>
        </div>
      </div>
    </main>
  );
}

const GLOBAL_CSS = `
html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #12382d; }
*, *::before, *::after { box-sizing: border-box; }
button { font-family: inherit; }

.oj-tab, .oj-switch, .oj-item { transition: background 150ms ease, color 150ms ease, transform 100ms ease; }
.oj-switch:active, .oj-item:active { transform: scale(0.97); }
.oj-corner-coin { transition: transform 140ms ease, box-shadow 140ms ease; }
@media (hover: hover) {
  .oj-corner-coin:hover { transform: scale(1.06); }
  .oj-item:hover { background: rgba(255,255,255,0.08) !important; }
}
.oj-corner-coin:active { transform: scale(0.94); }
.oj-corner-coin:focus-visible, .oj-item:focus-visible { outline: 2px solid #ffe3a1; outline-offset: 2px; }
.oj-dropdown-right { transform-origin: top right !important; }
.oj-emoji { transition: transform 140ms ease, background 140ms ease, box-shadow 140ms ease; }
@media (hover: hover) {
  .oj-emoji:hover { transform: scale(1.14); background: rgba(255,255,255,0.16) !important; box-shadow: 0 0 16px rgba(255,255,255,0.22); }
}
.oj-emoji:active { transform: scale(0.94); }
.oj-emoji:focus-visible { outline: 2px solid #ffe3a1; outline-offset: 2px; }
.oj-dropdown { transform-origin: top left; animation: oj-drop 160ms cubic-bezier(0.2, 0.9, 0.3, 1.1) both; }
@keyframes oj-drop { from { opacity: 0; transform: translateY(-6px) scale(0.94); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .oj-dropdown { animation: none; } }

/* Main menu */
.oj-menu-body > * { animation: oj-rise 700ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.oj-menu-body > *:nth-child(2) { animation-delay: 80ms; }
.oj-menu-body > *:nth-child(3) { animation-delay: 140ms; }
.oj-menu-body > *:nth-child(4) { animation-delay: 220ms; }
.oj-menu-body > *:nth-child(5) { animation-delay: 280ms; }
.oj-menu-body > *:nth-child(6) { animation-delay: 340ms; }
.oj-menu-body > *:nth-child(7) { animation-delay: 400ms; }
@keyframes oj-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.oj-menu-rings { animation: oj-spin 120s linear infinite; }
@keyframes oj-spin { to { transform: translate(-50%, -50%) rotate(360deg); } }
.oj-start { transition: transform 140ms ease, filter 140ms ease, box-shadow 140ms ease; }
@media (hover: hover) { .oj-start:hover { transform: translateY(-2px); filter: brightness(1.07); } }
.oj-start:active { transform: translateY(3px) scale(0.98); box-shadow: 0 1px 0 #9a6410, 0 6px 14px rgba(0,0,0,0.4) !important; }
.oj-start:focus-visible, .oj-link:focus-visible { outline: 2px solid #ffe3a1; outline-offset: 3px; }
.oj-link { transition: color 150ms ease, opacity 150ms ease; }
@media (hover: hover) { .oj-link:hover { color: #ffe3a1 !important; } }
@media (prefers-reduced-motion: reduce) {
  .oj-menu-body > *, .oj-menu-rings { animation: none; }
}
`;

const SERIF =
  '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif';



const styles: Record<string, CSSProperties> = {
  app: {
    // The corner coin's size, and the square of the screen it keeps for itself.
    ["--oj-coin" as string]: "clamp(38px, 10.5vmin, 56px)",
    ["--oj-corner" as string]: "calc(var(--oj-coin) + 14px)",
    position: "fixed",
    inset: 0,
    width: "100%",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    background: "#12382d",
    color: "#f4efe0",
    fontFamily: "system-ui, sans-serif",
  },
  // A floating glass bar: translucent dark, blurred, with a hairline edge and a soft shadow.
  // Segmented controls: a recessed track with a gold thumb on the active choice.
  // ---- Quick chat ----
  socialRoot: {
    position: "fixed",
    top: "max(8px, env(safe-area-inset-top))",
    right: "max(8px, env(safe-area-inset-right))",
    zIndex: 50,
  },
  socialButton: {
    width: "var(--oj-coin)",
    height: "var(--oj-coin)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "linear-gradient(180deg, rgba(20,40,34,0.7), rgba(8,20,16,0.7))",
    WebkitBackdropFilter: "blur(12px)",
    backdropFilter: "blur(12px)",
    color: "#f4efe0",
    cursor: "pointer",
    touchAction: "manipulation",
    boxShadow: "0 3px 10px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.12)",
  },
  socialButtonOpen: { borderColor: "rgba(242,177,52,0.6)", color: "#ffe3a1" },
  socialDropdown: {
    position: "absolute",
    top: "calc(100% + 8px)",
    right: 0,
    padding: 8,
    borderRadius: 16,
    background: "linear-gradient(180deg, rgba(20,40,34,0.82), rgba(8,20,16,0.82))",
    WebkitBackdropFilter: "blur(16px) saturate(1.3)",
    backdropFilter: "blur(16px) saturate(1.3)",
    border: "1px solid rgba(255,255,255,0.14)",
    boxShadow: "0 14px 36px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)",
  },
  emojiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 4,
  },
  emojiButton: {
    width: 48,
    height: 48,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    borderRadius: 12,
    background: "rgba(255,255,255,0.05)",
    fontSize: "1.75rem",
    lineHeight: 1,
    cursor: "pointer",
    touchAction: "manipulation",
  },
  // ---- Corner coin and its menu ----
  cornerRoot: {
    position: "fixed",
    top: "max(8px, env(safe-area-inset-top))",
    left: "max(8px, env(safe-area-inset-left))",
    zIndex: 50,
  },
  cornerCoin: {
    width: "var(--oj-coin)",
    height: "var(--oj-coin)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: "50%",
    background: "linear-gradient(180deg, #ffd978, #e09a1d)",
    color: "#3a2400",
    fontFamily: SERIF,
    fontWeight: 900,
    fontSize: "calc(var(--oj-coin) * 0.54)",
    lineHeight: 1,
    cursor: "pointer",
    touchAction: "manipulation",
    boxShadow: "0 3px 10px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.55)",
  },
  cornerCoinOpen: { boxShadow: "0 0 0 3px rgba(242,177,52,0.4), 0 3px 10px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.55)" },
  dropdown: {
    position: "absolute",
    top: "calc(100% + 8px)",
    left: 0,
    minWidth: "min(240px, calc(100vw - 24px))",
    maxHeight: "calc(100vh - 80px)",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: 6,
    borderRadius: 16,
    background: "linear-gradient(180deg, rgba(20,40,34,0.82), rgba(8,20,16,0.82))",
    WebkitBackdropFilter: "blur(16px) saturate(1.3)",
    backdropFilter: "blur(16px) saturate(1.3)",
    border: "1px solid rgba(255,255,255,0.14)",
    boxShadow: "0 14px 36px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)",
    color: "#f4efe0",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    minHeight: 44,
    padding: "0 14px 0 12px",
    border: "none",
    borderRadius: 11,
    background: "transparent",
    color: "rgba(244,239,224,0.9)",
    fontFamily: "inherit",
    fontSize: "0.95rem",
    fontWeight: 600,
    textAlign: "left",
    cursor: "pointer",
    touchAction: "manipulation",
    whiteSpace: "nowrap",
  },
  itemOn: { background: "rgba(242,177,52,0.16)", color: "#ffe3a1" },
  itemDanger: { color: "#fecaca" },
  itemRule: { height: 1, margin: "4px 8px", background: "rgba(255,255,255,0.1)" },
  switchBlock: {
    width: "100%",
    minHeight: 44,
    justifyContent: "flex-start",
    border: "none",
    borderRadius: 11,
    background: "transparent",
    boxShadow: "none",
    fontSize: "0.95rem",
    padding: "0 14px 0 12px",
  },
  // ---- Main menu ----
  menu: {
    position: "relative",
    flex: "1 1 0",
    minHeight: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "auto",
    padding: "clamp(16px, 4vmin, 48px)",
    background:
      "radial-gradient(ellipse at 50% 38%, #1f6b53 0%, #134a39 42%, #0b2a21 100%)",
  },
  menuRings: {
    position: "absolute",
    left: "50%",
    top: "42%",
    width: "min(120vmin, 1100px)",
    height: "min(120vmin, 1100px)",
    transform: "translate(-50%, -50%)",
    borderRadius: "50%",
    border: "1px solid rgba(242,177,52,0.14)",
    boxShadow:
      "inset 0 0 0 clamp(40px, 9vmin, 110px) rgba(0,0,0,0.04), 0 0 0 clamp(40px, 9vmin, 110px) rgba(242,177,52,0.04)",
    pointerEvents: "none",
  },
  menuBody: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "clamp(8px, 1.8vmin, 16px)",
    textAlign: "center",
    maxWidth: "100%",
  },
  menuCoin: {
    width: "clamp(56px, 13vmin, 112px)",
    height: "clamp(56px, 13vmin, 112px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    background: "linear-gradient(180deg, #ffd978, #e09a1d)",
    color: "#3a2400",
    fontFamily: SERIF,
    fontWeight: 900,
    fontSize: "clamp(1.8rem, 6.5vmin, 3.6rem)",
    lineHeight: 1,
    boxShadow: "0 10px 30px rgba(0,0,0,0.45), 0 0 0 clamp(4px, 1vmin, 8px) rgba(242,177,52,0.18), inset 0 2px 0 rgba(255,255,255,0.55)",
  },
  menuTitle: {
    margin: "clamp(4px, 1.2vmin, 12px) 0 0",
    fontSize: "clamp(2rem, 8.5vmin, 4.2rem)",
    fontWeight: 800,
    letterSpacing: "0.16em",
    paddingLeft: "0.16em",
    lineHeight: 1.05,
    color: "#f7f1de",
    textShadow: "0 4px 24px rgba(0,0,0,0.45)",
  },
  menuTagline: {
    margin: 0,
    fontSize: "clamp(0.68rem, 1.9vmin, 0.95rem)",
    letterSpacing: "0.32em",
    paddingLeft: "0.32em",
    textTransform: "uppercase",
    opacity: 0.6,
  },
  menuStart: {
    marginTop: "clamp(14px, 4vmin, 40px)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "clamp(200px, 34vmin, 300px)",
    minHeight: "clamp(48px, 8vmin, 64px)",
    padding: "0 clamp(28px, 6vmin, 56px)",
    border: "1.5px solid rgba(255,255,255,0.65)",
    borderRadius: 16,
    background: "linear-gradient(180deg, #ffe08a 0%, #f6b73c 48%, #de8a14 100%)",
    color: "#3a2300",
    fontSize: "clamp(1rem, 2.8vmin, 1.35rem)",
    fontWeight: 800,
    letterSpacing: "0.08em",
    lineHeight: 1,
    cursor: "pointer",
    touchAction: "manipulation",
    textShadow: "0 1px 0 rgba(255,255,255,0.5)",
    boxShadow: "0 5px 0 #9a6410, 0 12px 26px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.7)",
  },
  menuResume: {
    border: "none",
    background: "transparent",
    color: "rgba(244,239,224,0.75)",
    fontSize: "clamp(0.8rem, 2vmin, 1rem)",
    fontWeight: 600,
    letterSpacing: "0.04em",
    cursor: "pointer",
    padding: "4px 8px",
  },
  menuModes: {
    display: "flex",
    gap: 3,
    padding: 3,
    marginTop: "clamp(6px, 1.6vmin, 16px)",
    borderRadius: 9999,
    background: "rgba(0,0,0,0.3)",
    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.4)",
  },
  menuMode: {
    minHeight: "clamp(32px, 5vmin, 42px)",
    padding: "0 clamp(12px, 2.6vmin, 22px)",
    border: "none",
    borderRadius: 9999,
    background: "transparent",
    color: "rgba(244,239,224,0.75)",
    fontSize: "clamp(0.8rem, 1.9vmin, 1rem)",
    fontWeight: 700,
    cursor: "pointer",
    touchAction: "manipulation",
    whiteSpace: "nowrap",
    transition: "background 150ms ease, color 150ms ease",
  },
  menuModeOn: {
    minHeight: "clamp(32px, 5vmin, 42px)",
    padding: "0 clamp(12px, 2.6vmin, 22px)",
    border: "none",
    borderRadius: 9999,
    background: "rgba(244,239,224,0.94)",
    color: "#12382d",
    fontSize: "clamp(0.8rem, 1.9vmin, 1rem)",
    fontWeight: 700,
    cursor: "pointer",
    touchAction: "manipulation",
    whiteSpace: "nowrap",
    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
    transition: "background 150ms ease, color 150ms ease",
  },
  menuLinks: { display: "flex", alignItems: "center", gap: 6, marginTop: "clamp(4px, 1.2vmin, 12px)" },
  menuLink: {
    border: "none",
    background: "transparent",
    color: "rgba(244,239,224,0.6)",
    fontSize: "clamp(0.74rem, 1.7vmin, 0.92rem)",
    fontWeight: 600,
    letterSpacing: "0.06em",
    cursor: "pointer",
    padding: "6px 8px",
  },
  menuDot: { opacity: 0.35 },
  switchBase: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: "clamp(32px, 4.4vmin, 44px)",
    padding: "0 clamp(8px, 1.4vmin, 14px) 0 clamp(10px, 1.6vmin, 16px)",
    borderRadius: 9999,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))",
    color: "rgba(244,239,224,0.75)",
    fontFamily: "inherit",
    fontSize: "clamp(0.78rem, 1.6vmin, 1rem)",
    fontWeight: 700,
    letterSpacing: "0.03em",
    lineHeight: 1,
    cursor: "pointer",
    touchAction: "manipulation",
    whiteSpace: "nowrap",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
    transition: "background 160ms ease, color 160ms ease, border-color 160ms ease",
  },
  switchOn: {
    borderColor: "rgba(242,177,52,0.55)",
    background: "linear-gradient(180deg, rgba(242,177,52,0.22), rgba(242,177,52,0.08))",
    color: "#ffe3a1",
  },
  switchIcon: { display: "inline-flex", alignItems: "center", fontSize: "1.05em" },
  switchTrack: {
    position: "relative",
    width: 34,
    height: 18,
    flex: "none",
    borderRadius: 9999,
    background: "rgba(0,0,0,0.4)",
    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.5)",
    transition: "background 160ms ease",
  },
  switchTrackOn: { background: "linear-gradient(180deg, #ffd978, #e8a21f)" },
  switchThumb: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "#f4efe0",
    boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
    transition: "transform 180ms cubic-bezier(0.3, 1.4, 0.5, 1)",
  },
  switchThumbOn: { transform: "translateX(16px)" },
  // The game table fills <main> exactly and never scrolls; the Guide and Tutorial pages scroll
  // inside their own <main>, so the nav stays put and the page itself never moves.
  mainFixed: {
    flex: "1 1 0",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  // Pages that scroll (the guide, the puzzles, the lobby) start below the corner coin.
  mainPage: {
    paddingTop: "var(--oj-corner)",
    flex: "1 1 0",
    minHeight: 0,
    minWidth: 0,
    overflowX: "hidden",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
};
