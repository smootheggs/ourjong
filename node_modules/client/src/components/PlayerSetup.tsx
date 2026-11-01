import type { CSSProperties } from "react";
import { DEFAULT_NAMES, MAX_NAME_LENGTH } from "../session";
import type { SeatNames } from "../session";

/**
 * Players & Ledger: the four names, and the switch for recording the match ledger.
 *
 * Everything here is held in memory by the app (see session.tsx): nothing is saved, so closing the
 * app forgets it. A name belongs to a seat number, not to a wind, so it follows its player as the
 * dealership rotates.
 */
export function PlayerSetupScreen({
  names,
  onName,
  ledgerOn,
  onLedger,
  onBack,
}: {
  names: SeatNames;
  onName: (seat: number, name: string) => void;
  ledgerOn: boolean;
  onLedger: (on: boolean) => void;
  onBack: () => void;
}) {
  return (
    <main className="ps-screen" style={ps.screen}>
      <style>{PS_CSS}</style>
      <div className="ps-body" style={ps.body}>
        <h1 style={ps.title}>Players</h1>
        <p style={ps.sub}>Names last for this session only.</p>

        <div className="ps-grid" style={ps.grid}>
          {names.map((name, seat) => (
            <label key={seat} className="ps-field" style={ps.field}>
              <span style={ps.badge} aria-hidden="true">
                {seat + 1}
              </span>
              <input
                className="ps-input"
                style={ps.input}
                type="text"
                value={name}
                maxLength={MAX_NAME_LENGTH}
                placeholder={DEFAULT_NAMES[seat]}
                aria-label={`Name for player ${seat + 1}`}
                autoComplete="off"
                autoCapitalize="words"
                spellCheck={false}
                enterKeyHint="done"
                onChange={(event) => onName(seat, event.target.value)}
              />
            </label>
          ))}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={ledgerOn}
          className="ps-switch"
          style={ps.switchRow}
          onClick={() => onLedger(!ledgerOn)}
        >
          <span style={ps.switchText}>
            <span style={ps.switchLabel}>Record Match Ledger</span>
            <span style={ps.switchHint}>
              {ledgerOn ? "Each hand is noted. Cleared when you close the app." : "Off: nothing about your games is recorded."}
            </span>
          </span>
          <span style={{ ...ps.track, ...(ledgerOn ? ps.trackOn : null) }} aria-hidden="true">
            <span style={{ ...ps.thumb, ...(ledgerOn ? ps.thumbOn : null) }} />
          </span>
        </button>

        <button type="button" className="oj-start" style={ps.done} onClick={onBack}>
          Done
        </button>
      </div>
    </main>
  );
}

const PS_CSS = `
.ps-input { transition: border-color 150ms ease, background 150ms ease; }
.ps-input:focus { outline: none; border-color: #ffd978 !important; background: rgba(255,255,255,0.1) !important; }
.ps-input::placeholder { color: rgba(244,239,224,0.4); }
.ps-switch { transition: transform 100ms ease, background 150ms ease; }
.ps-switch:active { transform: scale(0.985); }
.ps-switch:focus-visible { outline: 2px solid #ffe3a1; outline-offset: 2px; }
@media (min-width: 560px) { .ps-grid { grid-template-columns: 1fr 1fr !important; } }
@media (max-height: 520px) {
  .ps-body { gap: 8px !important; padding-top: 12px !important; }
  .ps-body h1 { font-size: 1.4rem !important; }
  .ps-body > p { display: none; }
}
@media (prefers-reduced-motion: reduce) { .ps-input, .ps-switch { transition: none; } }
`;

const SERIF = '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif';

const ps: Record<string, CSSProperties> = {
  screen: {
    position: "absolute",
    inset: 0,
    overflowX: "hidden",
    overflowY: "auto",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))",
    background: "radial-gradient(120% 90% at 50% 0%, #1f5a47, #12382d 60%, #0a241c)",
    color: "#f4efe0",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "clamp(8px, 2vmin, 16px)",
    width: "min(100%, 560px)",
    margin: "auto",
    padding: "clamp(40px, 8vmin, 56px) 0 16px",
  },
  title: { margin: 0, fontSize: "clamp(1.6rem, 5vmin, 2.2rem)", fontWeight: 800 },
  sub: { margin: "0 0 4px", color: "rgba(244,239,224,0.65)", fontSize: "0.95rem" },
  grid: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, width: "100%" },
  field: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
    padding: "6px 8px 6px 10px",
    borderRadius: 16,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
  },
  badge: {
    flex: "none",
    width: 30,
    height: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    background: "rgba(242,177,52,0.18)",
    color: "#ffd978",
    fontFamily: SERIF,
    fontWeight: 900,
    fontSize: "0.95rem",
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#f4efe0",
    fontFamily: "inherit",
    fontSize: "1rem", // 16px or more, so iOS does not zoom the page on focus
    fontWeight: 600,
  },
  switchRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    width: "100%",
    minWidth: 0,
    minHeight: 56,
    padding: "8px 14px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    touchAction: "manipulation",
  },
  switchText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  switchLabel: { fontSize: "1rem", fontWeight: 700 },
  switchHint: { fontSize: "0.82rem", color: "rgba(244,239,224,0.6)", lineHeight: 1.3 },
  track: {
    flex: "none",
    width: 46,
    height: 28,
    padding: 3,
    borderRadius: 9999,
    background: "rgba(0,0,0,0.4)",
    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.5)",
    transition: "background 150ms ease",
  },
  trackOn: { background: "#f2b134" },
  thumb: {
    display: "block",
    width: 22,
    height: 22,
    borderRadius: "50%",
    background: "#f4efe0",
    boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
    transition: "transform 150ms ease",
  },
  thumbOn: { transform: "translateX(18px)" },
  done: {
    marginTop: 4,
    width: "100%",
    minHeight: 54,
    border: "none",
    borderRadius: 9999,
    background: "linear-gradient(180deg, #ffd978, #e09a1d)",
    color: "#3a2400",
    fontSize: "1.1rem",
    fontWeight: 800,
    letterSpacing: "0.02em",
    cursor: "pointer",
    touchAction: "manipulation",
    boxShadow: "0 3px 0 #9a6410, 0 10px 22px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.55)",
  },
};
