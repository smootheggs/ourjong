import { createContext, useContext, useMemo, useReducer } from "react";
import type { Dispatch, ReactNode } from "react";
import { recordHand } from "@ourjong/engine";
import type { GameState, Ledger } from "@ourjong/engine";

/**
 * Who is playing and what has happened so far: names, the ledger switch and the ledger itself.
 *
 * This lives only in React state. Nothing is written to storage, so it survives new hands and new
 * rounds but is gone when the app closes (the ledger is off by default, for privacy). Every field
 * is plain JSON, so the same shape can be sent over a socket when online play arrives.
 *
 * Identity is the seat number, 0-3: seats never move, only the seat winds rotate.
 */
export type SeatNames = readonly [string, string, string, string];

export interface SessionState {
  /** What each seat is called, as typed (may be blank: see `resolveNames`). */
  readonly names: SeatNames;
  /** "Record Match Ledger". Off by default. */
  readonly ledgerOn: boolean;
  readonly ledger: Ledger;
}

export const DEFAULT_NAMES: SeatNames = ["Player 1", "Bot 1", "Bot 2", "Bot 3"];
export const MAX_NAME_LENGTH = 16;

export type SessionAction =
  | { type: "set-name"; seat: number; name: string }
  | { type: "set-ledger-on"; on: boolean }
  /** The hand on screen has ended: add it to the ledger (once) if recording. */
  | { type: "record-hand"; state: GameState }
  | { type: "clear-ledger" };

export const INITIAL_SESSION: SessionState = { names: DEFAULT_NAMES, ledgerOn: false, ledger: [] };

export function sessionReducer(session: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "set-name": {
      const names = session.names.map((n, i) => (i === action.seat ? action.name.slice(0, MAX_NAME_LENGTH) : n));
      return { ...session, names: names as unknown as SeatNames };
    }
    case "set-ledger-on":
      // Switching off forgets what was recorded: it is a privacy switch.
      return action.on ? { ...session, ledgerOn: true } : { ...session, ledgerOn: false, ledger: [] };
    case "record-hand": {
      if (!session.ledgerOn) return session;
      const ledger = recordHand(session.ledger, action.state);
      return ledger === session.ledger ? session : { ...session, ledger };
    }
    case "clear-ledger":
      return session.ledger.length === 0 ? session : { ...session, ledger: [] };
  }
}

/** The names to deal with: what was typed, trimmed, or the seat's default when it was left blank. */
export function resolveNames(names: SeatNames): SeatNames {
  return names.map((n, i) => n.trim() || DEFAULT_NAMES[i]!) as unknown as SeatNames;
}

interface SessionValue {
  readonly session: SessionState;
  readonly dispatch: Dispatch<SessionAction>;
}

const NOOP: Dispatch<SessionAction> = () => undefined;
const SessionContext = createContext<SessionValue>({ session: INITIAL_SESSION, dispatch: NOOP });

/** The session store: call once, high in the tree, and hand the result to `SessionProvider`. */
export function useSessionStore(): SessionValue {
  const [session, dispatch] = useReducer(sessionReducer, INITIAL_SESSION);
  return useMemo(() => ({ session, dispatch }), [session]);
}

export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session, from any component; outside a provider it is the default (ledger off). */
export function useSession(): SessionValue {
  return useContext(SessionContext);
}
