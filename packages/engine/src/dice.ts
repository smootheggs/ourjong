import { seededRandom } from "./game.ts";
import type { GameState, SeatIndex } from "./types.ts";

/**
 * The opening dice roll of a hand, worked out by the engine.
 *
 * The roll is decided here, from the game's own seed, BEFORE any animation exists. A screen's
 * job is to play the dice falling onto exactly these two numbers, never to choose them. Because
 * the numbers come from the seed and the hand number, every device at the table computes the
 * same roll for the same hand, and asking again never gives a different answer.
 *
 * What the roll decides, as at a real table:
 *  - The dealer throws two dice.
 *  - The total is counted around the table starting with the dealer as 1 (counter-clockwise, the
 *    same way play goes). Whoever it lands on is the seat whose wall is broken.
 *  - The wall is 4 sides of 17 stacks (two tiles each). Counting from the right-hand end of that
 *    seat's side, the total picks the stack where the wall opens.
 */

/** Exactly two dice, each 1 to 6. */
export type DiceTuple = [number, number];

/** 136 tiles stacked two high: 17 stacks along each of the four sides. */
export const WALL_STACKS_PER_SIDE = 17;
export const WALL_STACKS = WALL_STACKS_PER_SIDE * 4;

export interface DiceRollResult {
  /** The two dice, in the order they are thrown. */
  readonly dice: DiceTuple;
  /** 2 to 12. */
  readonly total: number;
  /** The seat that throws: the dealer. */
  readonly rollerSeat: SeatIndex;
  /** The seat whose wall is broken, counting `total` from the dealer as 1. */
  readonly breakerSeat: SeatIndex;
  /** Which stack of that wall opens, 1 to 12, counted from the right-hand end as that seat sees it. */
  readonly breakStack: number;
  /** The same place on the whole ring of 68 stacks (0-based): breakerSeat * 17 + breakStack - 1. */
  readonly breakIndex: number;
}

/**
 * The roll for the hand that `state` is about to play (or is playing). Pure: the same state always
 * gives the same answer, and it draws from its own stream, so it never disturbs the shuffle.
 */
export function generateDiceRoll(state: GameState): DiceRollResult {
  const { handNumber, dealerRepeats, dealerSeat } = state.round;
  const random = seededRandom(`${state.random.seed}|dice|${handNumber}|${dealerRepeats}`);
  const die = () => Math.floor(random() * 6) + 1;
  const dice: DiceTuple = [die(), die()];
  return resolveDiceRoll(dice, dealerSeat);
}

/** Works out who breaks the wall, and where, from two dice and the dealer. */
export function resolveDiceRoll(dice: DiceTuple, dealerSeat: SeatIndex): DiceRollResult {
  const total = dice[0] + dice[1];
  const breakerSeat = ((dealerSeat + total - 1) % 4) as SeatIndex;
  return {
    dice,
    total,
    rollerSeat: dealerSeat,
    breakerSeat,
    breakStack: total,
    breakIndex: breakerSeat * WALL_STACKS_PER_SIDE + total - 1,
  };
}
