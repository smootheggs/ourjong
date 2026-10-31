import { useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { TURN_TIME_OPTIONS_MS } from "../network/useMultiplayer";
import type { ConnectionStatus, RoomSummary } from "../network/useMultiplayer";

export interface LobbyProps {
  status: ConnectionStatus;
  /** A join is in flight (or a saved seat is being resumed). */
  joining: boolean;
  /** The room this tab already sits in; shows the waiting room instead of the form. */
  roomCode: string | null;
  room: RoomSummary | null;
  error: string | null;
  /** Why the last request (such as a settings change) was refused. */
  actionError?: string | null;
  onJoin: (code: string, name: string) => void;
  onLeave: () => void;
  /** Host only: choose the turn time in ms (0 = Infinite). The claim time follows from it. */
  onUpdateSettings: (turnTimeMs: number) => void;
}

const SEATS = 4;

const turnLabel = (ms: number): string => (ms <= 0 ? "∞" : `${ms / 1000}s`);
const turnWords = (ms: number): string => (ms <= 0 ? "Infinite" : `${ms / 1000} seconds`);
const WINDS = [
  { glyph: "東", name: "East" },
  { glyph: "南", name: "South" },
  { glyph: "西", name: "West" },
  { glyph: "北", name: "North" },
] as const;

// The server never makes codes with I or O (too easy to confuse with 1 and 0).
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const NAME_KEY = "ourjong.name";

const randomCode = (): string =>
  Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");

const cleanCode = (value: string): string => value.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 4);

function savedName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not remembering the name is fine.
  }
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting to the server…",
  connected: "Connected",
  disconnected: "Offline — retrying…",
};

export function Lobby({
  status,
  joining,
  roomCode,
  room,
  error,
  actionError,
  onJoin,
  onLeave,
  onUpdateSettings,
}: LobbyProps) {
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  const connected = status === "connected";
  const codeOk = /^[A-Z]{4}$/.test(code);
  const canJoin = connected && !joining && codeOk;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canJoin) return;
    const trimmed = name.trim();
    rememberName(trimmed);
    onJoin(code, trimmed);
  };

  const copyCode = async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the code is on screen anyway.
    }
  };

  return (
    <div style={styles.page}>
      <style>{LOBBY_CSS}</style>
      <div style={styles.card}>
        <h1 style={styles.title}>
          <span style={styles.titleZh}>麻雀</span> Play online
        </h1>

        <p style={styles.statusLine} role="status">
          <span
            aria-hidden="true"
            style={{
              ...styles.dot,
              background: connected ? "#4ade80" : status === "connecting" ? "#f2b134" : "#f87171",
            }}
          />
          {STATUS_TEXT[status]}
        </p>

        {roomCode === null ? (
          <form onSubmit={submit} style={styles.form}>
            <label style={styles.label}>
              Your name
              <input
                className="ourjong-lobby-pill"
                style={styles.pill}
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 20))}
                placeholder="Player"
                autoComplete="nickname"
                maxLength={20}
              />
            </label>

            <label style={styles.label}>
              Room code
              <div style={styles.codeRow}>
                <input
                  className="ourjong-lobby-pill"
                  style={{ ...styles.pill, ...styles.codeInput }}
                  value={code}
                  onChange={(e) => setCode(cleanCode(e.target.value))}
                  placeholder="ABCD"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4}
                  aria-describedby="lobby-code-hint"
                />
                <button
                  type="button"
                  className="ourjong-lobby-btn"
                  style={styles.ghostButton}
                  onClick={() => setCode(randomCode())}
                >
                  New code
                </button>
              </div>
            </label>
            <p id="lobby-code-hint" style={styles.hint}>
              Pick any four letters and share them: the first person to use a code opens the room.
            </p>

            {error && (
              <p style={styles.error} role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="ourjong-lobby-btn"
              style={canJoin ? styles.primaryButton : { ...styles.primaryButton, ...styles.disabled }}
              disabled={!canJoin}
            >
              {joining ? "Joining…" : "Join table"}
            </button>
          </form>
        ) : (
          <div style={styles.waiting}>
            <div style={styles.codeBlock}>
              <span style={styles.hint}>Room</span>
              <button
                type="button"
                className="ourjong-lobby-btn"
                style={styles.codeBadge}
                onClick={copyCode}
                title="Copy the room code"
              >
                {roomCode}
                <span style={styles.copyHint}>{copied ? "copied" : "tap to copy"}</span>
              </button>
            </div>

            <WaitingSeats room={room} />

            {room && <TableSettings room={room} onChange={onUpdateSettings} />}

            {(error || actionError) && (
              <p style={styles.error} role="alert">
                {error ?? actionError}
              </p>
            )}

            <button
              type="button"
              className="ourjong-lobby-btn"
              style={styles.ghostButton}
              onClick={onLeave}
            >
              Leave room
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The host (seat 0, the first to join) picks how long a turn lasts. Everyone else sees the
 * choice, read-only, so there are no surprises when the game starts. The claim window (how long
 * the table has to Pong, Chow or Win on a discard) is worked out by the server from this.
 */
function TableSettings({ room, onChange }: { room: RoomSummary; onChange: (turnTimeMs: number) => void }) {
  const isHost = room.yourSeat === 0;
  const { turnTimeMs, claimTimeMs } = room.settings;
  const locked = room.started;
  const canEdit = isHost && !locked;
  const host = room.seats.find((s) => s.seat === 0);

  return (
    <fieldset style={styles.settings} disabled={!canEdit}>
      <legend style={styles.settingsLegend}>
        Turn time
        {isHost && <span style={styles.hostBadge}>You're the host</span>}
      </legend>

      <div role="radiogroup" aria-label="Turn time" style={styles.segmented}>
        {TURN_TIME_OPTIONS_MS.map((ms) => {
          const active = ms === turnTimeMs;
          return (
            <button
              key={ms}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={turnWords(ms)}
              className="ourjong-lobby-btn"
              disabled={!canEdit}
              style={{
                ...styles.segment,
                ...(active ? styles.segmentActive : null),
                ...(!canEdit ? styles.segmentReadOnly : null),
              }}
              onClick={() => {
                if (!active) onChange(ms);
              }}
            >
              {turnLabel(ms)}
            </button>
          );
        })}
      </div>

      <p style={styles.hint}>
        {turnTimeMs <= 0
          ? "No clock: nobody is ever skipped. A player who walks away stalls the table."
          : `A player who runs out of time is skipped automatically. Claiming a discard gets ${claimTimeMs / 1000}s.`}
      </p>
      {!isHost && (
        <p style={styles.hint}>{host ? `${host.name} sets the clock.` : "The host sets the clock."}</p>
      )}
    </fieldset>
  );
}

function WaitingSeats({ room }: { room: RoomSummary | null }) {
  const seats = room?.seats ?? [];
  const here = seats.length;

  return (
    <div style={styles.seatsBlock}>
      <p style={styles.waitingTitle} role="status" aria-live="polite">
        {here >= SEATS ? "Table full: starting…" : `Waiting for players… ${here}/${SEATS}`}
      </p>
      <ul style={styles.seatList}>
        {WINDS.map((wind, i) => {
          const seat = seats[i];
          return (
            <li
              key={wind.name}
              className={seat ? undefined : "ourjong-lobby-empty"}
              style={seat ? styles.seatPill : { ...styles.seatPill, ...styles.seatEmpty }}
            >
              <span style={styles.seatWind}>{wind.glyph}</span>
              <span style={styles.seatName}>{seat ? seat.name : "Waiting…"}</span>
              {seat && (
                <span
                  aria-label={seat.connected ? "connected" : "disconnected"}
                  style={{
                    ...styles.dot,
                    background: seat.connected ? "#4ade80" : "#f87171",
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const LOBBY_CSS = `
.ourjong-lobby-pill:focus-visible,
.ourjong-lobby-btn:focus-visible { outline: 3px solid #f2b134; outline-offset: 3px; }
.ourjong-lobby-pill::placeholder { color: rgba(244,239,224,0.4); }
.ourjong-lobby-btn { transition: transform 120ms ease, filter 120ms ease; }
@media (hover: hover) {
  .ourjong-lobby-btn:not(:disabled):hover { transform: translateY(-2px); filter: brightness(1.08); }
}
.ourjong-lobby-btn:not(:disabled):active { transform: translateY(1px) scale(0.98); }
@keyframes ourjong-lobby-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
.ourjong-lobby-empty { animation: ourjong-lobby-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .ourjong-lobby-empty { animation: none; }
  .ourjong-lobby-btn { transition: none; }
}
`;

const SERIF =
  '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif';

const pillBase: CSSProperties = {
  minHeight: 48,
  borderRadius: 9999,
  padding: "0 22px",
  font: "inherit",
  fontSize: "1rem",
  fontWeight: 700,
};

const styles: Record<string, CSSProperties> = {
  // Scrolls on its own on short screens; the nav above never moves.
  page: {
    flex: "1 1 0",
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    background: "radial-gradient(ellipse at center, #1c5a46 0%, #12382d 100%)",
  },
  card: {
    width: "min(100%, 440px)",
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: "clamp(18px, 4vmin, 32px)",
    borderRadius: 32,
    background: "rgba(0,0,0,0.38)",
    border: "2px solid rgba(242,177,52,0.45)",
    boxShadow: "0 18px 40px rgba(0,0,0,0.4)",
  },
  title: { margin: 0, fontSize: "clamp(1.4rem, 4vmin, 1.9rem)", letterSpacing: "0.04em" },
  titleZh: { fontFamily: SERIF, color: "#f2b134", marginRight: 4 },
  statusLine: {
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: "0.85rem",
    color: "rgba(244,239,224,0.7)",
  },
  dot: { display: "inline-block", width: 10, height: 10, borderRadius: "50%", flex: "none" },
  form: { display: "flex", flexDirection: "column", gap: 14 },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: "0.85rem",
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: "rgba(244,239,224,0.8)",
  },
  pill: {
    ...pillBase,
    width: "100%",
    boxSizing: "border-box",
    border: "2px solid rgba(244,239,224,0.35)",
    background: "rgba(0,0,0,0.35)",
    color: "#f4efe0",
  },
  codeRow: { display: "flex", gap: 8, alignItems: "center" },
  codeInput: {
    flex: 1,
    minWidth: 0,
    textAlign: "center",
    textTransform: "uppercase",
    letterSpacing: "0.5em",
    paddingLeft: "calc(22px + 0.5em)", // balances the trailing letter-spacing
    fontSize: "1.25rem",
    fontWeight: 800,
  },
  hint: { margin: 0, fontSize: "0.8rem", color: "rgba(244,239,224,0.55)" },
  error: {
    margin: 0,
    padding: "8px 16px",
    borderRadius: 9999,
    background: "rgba(248,113,113,0.18)",
    border: "1px solid rgba(248,113,113,0.6)",
    color: "#fecaca",
    fontSize: "0.9rem",
  },
  primaryButton: {
    ...pillBase,
    border: "2px solid #fff3c4",
    background: "linear-gradient(180deg, #ffe680 0%, #f2b134 55%, #d98a12 100%)",
    color: "#3a2600",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    cursor: "pointer",
    boxShadow: "0 4px 0 #8a5a08, 0 8px 16px rgba(0,0,0,0.35)",
  },
  ghostButton: {
    ...pillBase,
    minHeight: 44,
    border: "2px solid rgba(244,239,224,0.4)",
    background: "transparent",
    color: "#f4efe0",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  disabled: { opacity: 0.45, cursor: "not-allowed", boxShadow: "none" },
  waiting: { display: "flex", flexDirection: "column", gap: 16, alignItems: "stretch" },
  codeBlock: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  codeBadge: {
    ...pillBase,
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    padding: "6px 26px",
    border: "2px solid #f2b134",
    background: "rgba(242,177,52,0.14)",
    color: "#f2b134",
    fontSize: "1.9rem",
    fontWeight: 900,
    letterSpacing: "0.3em",
    cursor: "pointer",
    lineHeight: 1.1,
  },
  copyHint: { fontSize: "0.65rem", fontWeight: 600, letterSpacing: "0.08em", opacity: 0.7 },
  settings: {
    margin: 0,
    padding: "10px 14px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    borderRadius: 24,
    border: "2px solid rgba(244,239,224,0.25)",
    background: "rgba(0,0,0,0.2)",
    minWidth: 0,
  },
  settingsLegend: {
    padding: "0 8px",
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: "0.85rem",
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: "rgba(244,239,224,0.8)",
  },
  hostBadge: {
    padding: "2px 10px",
    borderRadius: 9999,
    background: "rgba(242,177,52,0.2)",
    border: "1px solid #f2b134",
    color: "#f2b134",
    fontSize: "0.7rem",
    letterSpacing: "0.04em",
  },
  segmented: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 4,
    padding: 4,
    borderRadius: 9999,
    background: "rgba(0,0,0,0.35)",
    border: "2px solid rgba(244,239,224,0.25)",
  },
  segment: {
    ...pillBase,
    minHeight: 44,
    padding: 0,
    border: "2px solid transparent",
    background: "transparent",
    color: "#f4efe0",
    cursor: "pointer",
  },
  segmentActive: {
    background: "linear-gradient(180deg, #ffe680 0%, #f2b134 55%, #d98a12 100%)",
    borderColor: "#fff3c4",
    color: "#3a2600",
  },
  segmentReadOnly: { cursor: "default" },
  seatsBlock: { display: "flex", flexDirection: "column", gap: 10 },
  waitingTitle: { margin: 0, fontWeight: 700 },
  seatList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 },
  seatPill: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minHeight: 48,
    padding: "0 18px",
    borderRadius: 9999,
    background: "rgba(244,239,224,0.1)",
    border: "2px solid rgba(244,239,224,0.4)",
  },
  seatEmpty: { background: "transparent", borderStyle: "dashed", color: "rgba(244,239,224,0.6)" },
  seatWind: { fontFamily: SERIF, fontSize: "1.4rem", color: "#f2b134", width: "1.4em", textAlign: "center" },
  seatName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 },
};
