import { useEffect } from "react";
import type { CSSProperties } from "react";
import { playSound } from "../audio";

/* ---------- The roll itself ---------- */

export interface DiceRollState {
  /** Changes with every roll, so the same numbers twice in a row still replay the animation. */
  readonly id: number;
  readonly values: readonly [number, number];
}

let rollCounter = 0;

/**
 * Two dice from a seed string. The same string always gives the same pair, so every screen
 * at the table shows the same roll for the same hand.
 */
export function rollDice(seed: string): DiceRollState {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = (h ^ (h >>> 15)) >>> 0;
  const a = (h % 6) + 1;
  const b = (Math.floor(h / 6) % 6) + 1;
  return { id: ++rollCounter, values: [a, b] };
}

/* ---------- Timing ---------- */

const TUMBLE_MS = 1500; // from release to the last bounce
const HOLD_MS = 1500; // settled, so the numbers can be read
const FADE_MS = 400;
const SECOND_DIE_DELAY_MS = 140;
/** Moments the die meets the table, as a share of the tumble (see the keyframes below). */
const IMPACTS: readonly number[] = [0.36, 0.7];

/** Haptic burst: strong on the first landing, lighter on the bounce. Silent where unsupported. */
function diceHaptic(strength: 1 | 2): void {
  try {
    navigator.vibrate?.(strength === 1 ? [16, 24, 8] : 6);
  } catch {
    // Unsupported or blocked.
  }
}

/* ---------- A die ---------- */

// Which pips (row, column on a 3 x 3 grid) each face shows.
const PIPS: Record<number, readonly (readonly [number, number])[]> = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [1, 3], [3, 1], [3, 3]],
  5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
  6: [[1, 1], [2, 1], [3, 1], [1, 3], [2, 3], [3, 3]],
};

// Opposite faces add to seven. Face number -> where it sits on the cube.
const FACE_PLACE: Record<number, string> = {
  1: "translateZ(calc(var(--die) / 2))",
  6: "rotateY(180deg) translateZ(calc(var(--die) / 2))",
  3: "rotateY(90deg) translateZ(calc(var(--die) / 2))",
  4: "rotateY(-90deg) translateZ(calc(var(--die) / 2))",
  2: "rotateX(90deg) translateZ(calc(var(--die) / 2))",
  5: "rotateX(-90deg) translateZ(calc(var(--die) / 2))",
};

// The turn of the whole cube that brings each face to the front (before the viewing tilt).
const FACE_TO_FRONT: Record<number, [number, number]> = {
  1: [0, 0],
  6: [0, 180],
  3: [0, -90],
  4: [0, 90],
  2: [-90, 0],
  5: [90, 0],
};

/** Traditional dice: bone white, black pips, with the 1 and the 4 in red. */
const isRed = (face: number): boolean => face === 1 || face === 4;

function Face({ face }: { face: number }) {
  const red = isRed(face);
  return (
    <div className="ourjong-die-face" style={{ ...faceStyle, transform: FACE_PLACE[face] }}>
      {PIPS[face].map(([row, column], i) => (
        <span
          key={i}
          style={{
            ...(red ? pipRed : pipBlack),
            gridRow: row,
            gridColumn: column,
            ...(face === 1 ? pipOne : null),
          }}
        />
      ))}
    </div>
  );
}

function Die({ value, index, from }: { value: number; index: 0 | 1; from: 1 | -1 }) {
  const [rx, ry] = FACE_TO_FRONT[value];
  // A fixed slant, so the settled die shows its top and side as well as the face.
  const tiltX = -24;
  const tiltY = index === 0 ? -30 : 26;
  return (
    <div
      className="ourjong-die-slide"
      style={
        {
          "--from": from,
          "--delay": `${index * SECOND_DIE_DELAY_MS}ms`,
          "--fx": `${rx + tiltX}deg`,
          "--fy": `${ry + tiltY}deg`,
          "--spinx": `${(index === 0 ? 2 : 3) * 360}deg`,
          "--spiny": `${(index === 0 ? 3 : 2) * 360}deg`,
        } as CSSProperties
      }
    >
      <div className="ourjong-die-shadow" />
      <div className="ourjong-die-bounce">
        <div className="ourjong-die-cube" aria-hidden="true">
          {[1, 2, 3, 4, 5, 6].map((face) => (
            <Face key={face} face={face} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- The roll, drawn over the compass ---------- */

/**
 * Two dice that tumble in over the middle of the table, bounce, and settle on `roll.values`.
 * Place it inside a positioned parent the size of the hub; it ignores the pointer and clears
 * itself (calling `onDone`) a moment after the dice stop.
 */
export function DiceRoll({ roll, onDone }: { roll: DiceRollState; onDone: () => void }) {
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timers: number[] = [];
    if (!reduce) {
      [0, 1].forEach((die) => {
        const start = die * SECOND_DIE_DELAY_MS;
        IMPACTS.forEach((share, hit) => {
          timers.push(
            window.setTimeout(() => {
              if (hit === 0) playSound("dice"); // placeholder asset: see audio.ts
              diceHaptic(hit === 0 ? 1 : 2);
            }, start + share * TUMBLE_MS),
          );
        });
      });
    }
    timers.push(window.setTimeout(onDone, (reduce ? 0 : TUMBLE_MS + SECOND_DIE_DELAY_MS) + HOLD_MS + FADE_MS));
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roll.id]);

  return (
    <div
      key={roll.id}
      className="ourjong-dice"
      style={layerStyle}
      role="img"
      aria-label={`Dice rolled ${roll.values[0]} and ${roll.values[1]}`}
    >
      <style>{DICE_CSS}</style>
      <Die value={roll.values[0]} index={0} from={-1} />
      <Die value={roll.values[1]} index={1} from={1} />
    </div>
  );
}

/* ---------- Styles ---------- */

const layerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 6,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "calc(var(--r, 24px) * 0.55)",
  pointerEvents: "none",
  perspective: "calc(var(--r, 24px) * 18)",
  ["--die" as string]: "calc(var(--r, 24px) * 1.25)",
};

const faceStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  gridTemplate: "repeat(3, 1fr) / repeat(3, 1fr)",
  placeItems: "center",
  padding: "17%",
  boxSizing: "border-box",
  // Bone white with a faint warm gradient, and a rounded, softly bevelled edge.
  background: "linear-gradient(145deg, #fffaf0 0%, #f1e8d0 60%, #e3d7b8 100%)",
  borderRadius: "16%",
  boxShadow: "inset 0 0 0 1px rgba(120,100,60,0.25), inset 0 -3px 6px rgba(120,100,60,0.22), inset 0 2px 3px rgba(255,255,255,0.8)",
  backfaceVisibility: "hidden",
};

const pipBase: CSSProperties = {
  width: "74%",
  aspectRatio: "1",
  borderRadius: "50%",
  display: "block",
};
// Pips are dished in: a darker rim and a light lower edge.
const pipBlack: CSSProperties = {
  ...pipBase,
  background: "radial-gradient(circle at 35% 30%, #4a4a4a, #111 70%)",
  boxShadow: "inset 0 1px 2px rgba(0,0,0,0.8), 0 1px 0 rgba(255,255,255,0.7)",
};
const pipRed: CSSProperties = {
  ...pipBase,
  background: "radial-gradient(circle at 35% 30%, #e5483c, #a31208 70%)",
  boxShadow: "inset 0 1px 2px rgba(80,0,0,0.7), 0 1px 0 rgba(255,255,255,0.7)",
};
// The one is the big red dot.
const pipOne: CSSProperties = { width: "190%" };

// Tumble: the die slides in from its side, drops, bounces twice and spins down to its face.
const DICE_CSS = `
.ourjong-die-slide {
  position: relative;
  width: var(--die);
  height: var(--die);
  animation: ourjong-die-slide ${TUMBLE_MS}ms cubic-bezier(0.2, 0.7, 0.3, 1) var(--delay) both,
             ourjong-dice-out ${FADE_MS}ms ease-in ${TUMBLE_MS + HOLD_MS}ms forwards;
}
.ourjong-die-bounce {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  animation: ourjong-die-bounce ${TUMBLE_MS}ms linear var(--delay) both;
}
.ourjong-die-cube {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  transform: rotateX(var(--fx)) rotateY(var(--fy));
  animation: ourjong-die-spin ${TUMBLE_MS}ms cubic-bezier(0.15, 0.6, 0.25, 1) var(--delay) both;
}
.ourjong-die-shadow {
  position: absolute;
  left: 8%; right: 8%; bottom: -14%;
  height: 22%;
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(0,0,0,0.55), rgba(0,0,0,0) 70%);
  animation: ourjong-die-shadow ${TUMBLE_MS}ms linear var(--delay) both;
}
@keyframes ourjong-die-slide {
  from { transform: translateX(calc(var(--from) * var(--die) * 4.5)); }
  to   { transform: translateX(0); }
}
/* Height above the table: high at the throw, down at 36%, up and down again at 70%, a hop at 90%. */
@keyframes ourjong-die-bounce {
  0%   { transform: translateY(calc(var(--die) * -5)) scale(1.35); animation-timing-function: cubic-bezier(0.5, 0, 0.9, 0.6); }
  36%  { transform: translateY(0) scale(1); animation-timing-function: cubic-bezier(0.2, 0.6, 0.4, 1); }
  54%  { transform: translateY(calc(var(--die) * -1.1)); animation-timing-function: cubic-bezier(0.6, 0, 0.9, 0.6); }
  70%  { transform: translateY(0); animation-timing-function: cubic-bezier(0.2, 0.6, 0.4, 1); }
  81%  { transform: translateY(calc(var(--die) * -0.35)); animation-timing-function: cubic-bezier(0.6, 0, 0.9, 0.6); }
  91%  { transform: translateY(0); animation-timing-function: cubic-bezier(0.2, 0.6, 0.4, 1); }
  96%  { transform: translateY(calc(var(--die) * -0.08)); animation-timing-function: ease-in; }
  100% { transform: translateY(0); }
}
@keyframes ourjong-die-spin {
  from { transform: rotateX(calc(var(--fx) + var(--spinx))) rotateY(calc(var(--fy) + var(--spiny))) rotateZ(160deg); }
  to   { transform: rotateX(var(--fx)) rotateY(var(--fy)) rotateZ(0deg); }
}
@keyframes ourjong-die-shadow {
  0%   { opacity: 0; transform: scale(0.4); }
  36%  { opacity: 1; transform: scale(1); }
  54%  { opacity: 0.45; transform: scale(0.6); }
  70%  { opacity: 1; transform: scale(1); }
  81%  { opacity: 0.7; transform: scale(0.85); }
  91%, 100% { opacity: 1; transform: scale(1); }
}
@keyframes ourjong-dice-out { to { opacity: 0; transform: scale(0.85); } }
@media (prefers-reduced-motion: reduce) {
  .ourjong-die-slide, .ourjong-die-bounce, .ourjong-die-cube, .ourjong-die-shadow { animation: none; }
  .ourjong-die-slide { animation: ourjong-dice-out ${FADE_MS}ms ease-in ${HOLD_MS}ms forwards; }
}
`;
