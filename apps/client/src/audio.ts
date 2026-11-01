/**
 * Central sound hook for the table. Game code calls `playSound("discard")` (and friends) at the
 * moment something happens; which file backs each name lives only here, so swapping in the
 * final sound effects is a one-line change per sound. A missing file, a blocked autoplay or no
 * audio support at all is ignored: the game plays on silently.
 */
export const SOUND_FILES = {
  /** Your own or anyone's tile hitting the table. */
  discard: "/sounds/clack.mp3",
  /** A tile drawn from the wall. */
  draw: "/sounds/clack.mp3",
  /** Chow, pong or kong claimed. */
  claim: "/sounds/claim.mp3",
  /** Declining a claim. */
  pass: "/sounds/clack.mp3",
  /** A hand won. */
  win: "/sounds/claim.mp3",
  /** The dice, from the instant they are thrown. Add public/sounds/dice-roll.mp3. */
  dice: "/sounds/dice-roll.mp3",
} as const;

export type SoundName = keyof typeof SOUND_FILES;

const VOLUME: Partial<Record<SoundName, number>> = { pass: 0.35, draw: 0.5, dice: 0.6 };

/** Fire-and-forget sound effect. */
export function playSound(name: SoundName): void {
  try {
    const audio = new Audio(SOUND_FILES[name]);
    audio.volume = VOLUME[name] ?? 0.8;
    void audio.play().catch(() => undefined);
  } catch {
    // No audio support.
  }
}
