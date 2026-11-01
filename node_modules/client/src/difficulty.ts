import type { BotLevel } from "@ourjong/engine";

/** The three bot strengths the menu offers, weakest first. The numbers are the engine's levels. */
export const DIFFICULTIES: readonly { level: BotLevel; label: string; hint: string }[] = [
  { level: 1, label: "Novice", hint: "Plays toward a complete hand and takes any claim" },
  { level: 2, label: "Intermediate", hint: "Plays for 3+ fan and claims with a plan" },
  { level: 3, label: "Expert", hint: "Plays for 3+ fan and folds when the table turns dangerous" },
];

export const DEFAULT_DIFFICULTY: BotLevel = 1;

const KEY = "ourjong.difficulty";

/** The saved choice, or the default; browser storage can be blocked or empty, so it never throws. */
export function loadDifficulty(): BotLevel {
  try {
    const n = Number(window.localStorage.getItem(KEY));
    return n === 1 || n === 2 || n === 3 ? n : DEFAULT_DIFFICULTY;
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

export function saveDifficulty(level: BotLevel): void {
  try {
    window.localStorage.setItem(KEY, String(level));
  } catch {
    /* private window or blocked storage: the choice just lasts for this visit */
  }
}
