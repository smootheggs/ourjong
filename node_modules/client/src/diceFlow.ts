import { generateDiceRoll } from "@ourjong/engine";
import type { DiceRollResult, GameState } from "@ourjong/engine";

/**
 * The opening dice roll as a small piece of UI state, and the rules for moving through it:
 *
 *   ROLL_STARTED   a hand has been dealt. The engine has already decided the roll; it is stored as
 *                  `targets` and the game waits (`isDiceRolling`). Nothing about the roll's
 *                  outcome (dealer pip, "East rolls an 8", the break in the wall) is shown yet.
 *   DICE_SETTLED   the dice have stopped on `targets`. The wait ends and the outcome appears.
 *   DICE_DISMISSED the dice have faded from the table (the outcome stays).
 *
 * The game itself is not touched: the engine's state has no idea any of this is happening.
 */

/** The hand a roll belongs to: the same for every render of one hand, new for the next. */
export const diceKeyOf = (state: GameState): string =>
  `${state.id}|${state.random.seed}|${state.round.handNumber}|${state.round.dealerRepeats}`;

export interface DiceFlowState {
  /** The hand this roll is for (see diceKeyOf). Null before the first roll. */
  readonly key: string | null;
  /** What the dice must land on, straight from the engine. */
  readonly diceTargets: [number, number] | null;
  /** True from the deal until the dice stop. The game does not move while this is true. */
  readonly isDiceRolling: boolean;
  /** The engine's full result, set only once the dice have settled. */
  readonly settled: DiceRollResult | null;
  /** The dice are still drawn on the table (rolling, or lingering after they stop). */
  readonly visible: boolean;
  /** The result as the engine worked it out; held back until DICE_SETTLED. */
  readonly pending: DiceRollResult | null;
}

export type DiceAction =
  | { readonly type: "ROLL_STARTED"; readonly key: string; readonly roll: DiceRollResult }
  | { readonly type: "DICE_SETTLED"; readonly key: string }
  | { readonly type: "DICE_DISMISSED"; readonly key: string };

export const INITIAL_DICE_FLOW: DiceFlowState = {
  key: null,
  diceTargets: null,
  isDiceRolling: false,
  settled: null,
  visible: false,
  pending: null,
};

export function diceReducer(flow: DiceFlowState, action: DiceAction): DiceFlowState {
  switch (action.type) {
    case "ROLL_STARTED":
      if (flow.key === action.key) return flow; // this hand already has its roll
      return {
        key: action.key,
        diceTargets: [action.roll.dice[0], action.roll.dice[1]],
        isDiceRolling: true,
        settled: null,
        visible: true,
        pending: action.roll,
      };
    case "DICE_SETTLED":
      // A late or repeated message about an old roll changes nothing.
      if (action.key !== flow.key || !flow.isDiceRolling) return flow;
      return { ...flow, isDiceRolling: false, settled: flow.pending };
    case "DICE_DISMISSED":
      if (action.key !== flow.key || !flow.visible) return flow;
      return { ...flow, visible: false };
  }
}

/** The action that starts the roll for a freshly dealt hand: the engine decides, right here. */
export function startRoll(state: GameState): DiceAction {
  return { type: "ROLL_STARTED", key: diceKeyOf(state), roll: generateDiceRoll(state) };
}
