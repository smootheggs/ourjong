import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { getBestDiscard, isWinningHand, shanten } from "@ourjong/engine";
import type {
  DragonName,
  SuitName,
  SuitRank,
  Tile,
  TileFace,
  WindName,
} from "@ourjong/engine";
import { TileView } from "./TileView";

/* ---------- Tile building ---------- */

// Tutorial tiles are made here, so their ids only have to be unique inside the tutorial.
let nextId = 70_000;
const copiesByFace = new Map<string, number>();

const mk = (face: TileFace): Tile => {
  const key = JSON.stringify(face);
  const copy = copiesByFace.get(key) ?? 0;
  copiesByFace.set(key, (copy + 1) % 4);
  return { id: nextId++, face, copy };
};

const suit = (name: SuitName, ...ranks: SuitRank[]): Tile[] =>
  ranks.map((rank) => mk({ kind: "suit", suit: name, rank }));
const bamboo = (...r: SuitRank[]) => suit("bamboo", ...r);
const chars = (...r: SuitRank[]) => suit("characters", ...r);
const dots = (...r: SuitRank[]) => suit("dots", ...r);
const dragon = (name: DragonName, n = 1): Tile[] =>
  Array.from({ length: n }, () => mk({ kind: "dragon", dragon: name }));
const wind = (name: WindName, n = 1): Tile[] =>
  Array.from({ length: n }, () => mk({ kind: "wind", wind: name }));

/* ---------- Puzzles ---------- */

export interface Puzzle {
  id: string;
  title: string;
  /** 14 tiles: one discard away from a hand that is one tile from winning. */
  hand: Tile[];
  hint: string;
  /** Why the best discard is the best one. */
  lesson: string;
}

const SUIT_ORDER: Record<SuitName, number> = { bamboo: 0, characters: 1, dots: 2 };
const sortKey = (tile: Tile): number => {
  const face = tile.face;
  if (face.kind === "suit") return SUIT_ORDER[face.suit] * 10 + face.rank;
  if (face.kind === "wind") return 100 + ["east", "south", "west", "north"].indexOf(face.wind);
  if (face.kind === "dragon") return 110 + ["red", "green", "white"].indexOf(face.dragon);
  return 200;
};
const arrange = (tiles: Tile[]): Tile[] => [...tiles].sort((a, b) => sortKey(a) - sortKey(b) || a.id - b.id);

export const PUZZLES: Puzzle[] = [
  {
    id: "lone-honor",
    title: "The lone wind",
    hand: arrange([
      ...dots(1, 2, 3, 5, 5),
      ...bamboo(4, 5, 6, 7, 8),
      ...chars(7, 8, 9),
      ...wind("east"),
    ]),
    hint: "Look for the tile that doesn't connect to anything else in your hand.",
    lesson:
      "A wind or dragon with no partner can only ever grow into a pung, which needs two more identical tiles. Throw away lone honors first.",
  },
  {
    id: "lone-terminal",
    title: "The stray 9",
    hand: arrange([
      ...dots(1, 2, 3, 4, 5, 6),
      ...bamboo(7, 8, 9),
      ...chars(3, 3, 4, 5, 9),
    ]),
    hint: "Which tile has the fewest neighbours that could ever join it?",
    lesson:
      "A 9 can only join 7-8, so it has far fewer ways to connect than a middle tile. Keep the 4-5 shape and throw away the loose 9.",
  },
  {
    id: "stray-middle",
    title: "Pairs and shapes first",
    hand: arrange([
      ...dots(2, 3, 4, 6, 7),
      ...bamboo(3, 4, 5, 8, 8),
      ...chars(2, 5, 6, 7),
    ]),
    hint: "One tile sits more than two steps away from every other tile in its suit.",
    lesson:
      "Even a middle-ish 2 is useless when nothing sits next to it. Throw it away before breaking a pair or a two-tile shape such as 6-7.",
  },
  {
    id: "honor-pair",
    title: "Keep the dragon pair",
    hand: arrange([
      ...dots(1, 2, 3, 7, 8),
      ...bamboo(2, 3, 4),
      ...chars(4, 5, 6),
      ...dragon("red", 2),
      ...dragon("green"),
    ]),
    hint: "Two of the three honors in your hand are a matching pair.",
    lesson:
      "A pair of dragons is worth keeping: a third one makes a pung that scores a fan by itself. The lone green dragon has no partner at all.",
  },
];

/* ---------- Helpers ---------- */

const sameFace = (a: Tile, b: Tile): boolean => JSON.stringify(a.face) === JSON.stringify(b.face);

/** "5 Dots (筒)", "East wind (東)", "Red dragon (中)" */
function faceName(face: TileFace): string {
  switch (face.kind) {
    case "suit": {
      const names = { bamboo: "Bamboo (索)", characters: "Characters (萬)", dots: "Dots (筒)" };
      return `${face.rank} ${names[face.suit]}`;
    }
    case "wind": {
      const glyphs = { east: "東", south: "南", west: "西", north: "北" };
      return `${face.wind[0].toUpperCase()}${face.wind.slice(1)} wind (${glyphs[face.wind]})`;
    }
    case "dragon": {
      const glyphs = { red: "中", green: "發", white: "白" };
      return `${face.dragon[0].toUpperCase()}${face.dragon.slice(1)} dragon (${glyphs[face.dragon]})`;
    }
    case "flower":
      return `Flower ${face.number}`;
    case "season":
      return `Season ${face.number}`;
    case "custom":
      return face.key;
  }
}

const ALL_FACES: TileFace[] = [
  ...(["bamboo", "characters", "dots"] as const).flatMap((s) =>
    ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((rank): TileFace => ({ kind: "suit", suit: s, rank })),
  ),
  ...(["east", "south", "west", "north"] as const).map((w): TileFace => ({ kind: "wind", wind: w })),
  ...(["red", "green", "white"] as const).map((d): TileFace => ({ kind: "dragon", dragon: d })),
];

const without = (hand: readonly Tile[], tile: Tile): Tile[] => hand.filter((t) => t.id !== tile.id);

/** The tiles that would complete the hand, as one example tile per face. */
function waitingTiles(rest: readonly Tile[]): Tile[] {
  const faceCounts = new Map<string, number>();
  for (const tile of rest) {
    const key = JSON.stringify(tile.face);
    faceCounts.set(key, (faceCounts.get(key) ?? 0) + 1);
  }

  const waits: Tile[] = [];
  for (const face of ALL_FACES) {
    // If all four are already in your hand, that tile can't come.
    if ((faceCounts.get(JSON.stringify(face)) ?? 0) >= 4) continue;
    const probe: Tile = { id: -1, face, copy: 0 };
    if (isWinningHand([...rest, probe])) waits.push(mk(face));
  }
  return waits;
}

function stepsText(steps: number): string {
  if (steps <= 0) return "ready to win";
  return `${steps} step${steps === 1 ? "" : "s"} away from being ready`;
}

/* ---------- Pieces ---------- */

function TileRow({ tiles }: { tiles: Tile[] }) {
  return (
    <div style={styles.smallRow}>
      {tiles.map((tile) => (
        <TileView key={tile.id} tile={tile} />
      ))}
    </div>
  );
}

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <section style={{ ...styles.card, ...style }}>{children}</section>;
}

function Feedback({ puzzle, picked, best }: { puzzle: Puzzle; picked: Tile; best: Tile }) {
  const correct = sameFace(picked, best);
  const bestWaits = useMemo(() => waitingTiles(without(puzzle.hand, best)), [puzzle, best]);
  const pickedRest = without(puzzle.hand, picked);
  const pickedSteps = shanten(pickedRest, 0);

  return (
    <Card style={correct ? styles.good : styles.bad}>
      <h3 style={styles.feedbackTitle} role="status">
        {correct ? "✔ Correct!" : "✘ Not quite"}
      </h3>

      {correct ? (
        <p style={styles.text}>
          <strong>{faceName(best.face)}</strong> is the optimal discard. {puzzle.lesson}
        </p>
      ) : (
        <>
          <p style={styles.text}>
            You discarded <strong>{faceName(picked.face)}</strong>.{" "}
            {pickedSteps <= 0
              ? "That still leaves you ready to win, but it isn't the strongest play here."
              : `That leaves your hand ${stepsText(pickedSteps)}, so it breaks up your winning shape.`}
          </p>
          <p style={styles.text}>
            The optimal discard is <strong>{faceName(best.face)}</strong>. {puzzle.lesson}
          </p>
        </>
      )}

      {bestWaits.length > 0 && (
        <>
          <p style={styles.text}>
            After the best discard you are one tile from winning, waiting on{" "}
            <strong>{bestWaits.length === 1 ? "this tile" : `these ${bestWaits.length} tiles`}</strong>:
          </p>
          <TileRow tiles={bestWaits} />
        </>
      )}
    </Card>
  );
}

/* ---------- The tutorial ---------- */

export function TutorialSandbox() {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<Tile | null>(null);
  const [solved, setSolved] = useState<readonly string[]>([]);
  const [showHint, setShowHint] = useState(false);

  const puzzle = PUZZLES[index];
  const isLast = index === PUZZLES.length - 1;

  // The answer comes from the same AI the bots use (medium difficulty).
  const best = useMemo(() => getBestDiscard(puzzle.hand, [], "medium"), [puzzle]);

  const answered = picked !== null;
  const correct = picked !== null && sameFace(picked, best);

  const choose = (tile: Tile) => {
    if (answered) return;
    setPicked(tile);
    if (sameFace(tile, best) && !solved.includes(puzzle.id)) {
      setSolved([...solved, puzzle.id]);
    }
  };

  const goTo = (next: number) => {
    setIndex(next);
    setPicked(null);
    setShowHint(false);
  };

  const ringFor = (tile: Tile): CSSProperties | undefined => {
    if (!answered) return undefined;
    if (tile.id === picked.id) return correct ? styles.ringGood : styles.ringBad;
    // Show the right answer after a miss (every identical tile counts).
    if (!correct && sameFace(tile, best)) return styles.ringGood;
    return undefined;
  };

  return (
    <div style={styles.page}>
      <div style={styles.inner}>
        <header style={styles.hero}>
          <h1 style={styles.h1}>
            <span style={styles.zh}>教學</span> Tutorial Puzzles
          </h1>
          <p style={styles.text}>
            Each puzzle gives you 14 tiles. Discard the right one and you're a single tile from
            winning. Tap the tile you would throw away.
          </p>
        </header>

        <nav style={styles.progress} aria-label="Puzzles">
          {PUZZLES.map((item, i) => {
            const done = solved.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => goTo(i)}
                aria-current={i === index ? "step" : undefined}
                style={{
                  ...styles.step,
                  ...(done ? styles.stepDone : null),
                  ...(i === index ? styles.stepCurrent : null),
                }}
              >
                {done ? "✔" : i + 1}
              </button>
            );
          })}
          <span style={styles.score}>
            Solved {solved.length} / {PUZZLES.length}
          </span>
        </nav>

        <Card>
          <h2 style={styles.h2}>
            Puzzle {index + 1}: {puzzle.title}
          </h2>
          <p style={styles.question}>What is the optimal discard?</p>

          <div style={styles.hand} aria-label="Your hand">
            {puzzle.hand.map((tile) => (
              <div key={tile.id} style={{ ...styles.slot, ...ringFor(tile) }}>
                <TileView tile={tile} onClick={answered ? undefined : () => choose(tile)} />
              </div>
            ))}
          </div>

          {!answered && (
            <div style={styles.actions}>
              <button type="button" style={styles.ghost} onClick={() => setShowHint((on) => !on)}>
                {showHint ? "Hide hint" : "Show hint"}
              </button>
            </div>
          )}
          {!answered && showHint && <p style={styles.hint}>💡 {puzzle.hint}</p>}
        </Card>

        {picked && <Feedback puzzle={puzzle} picked={picked} best={best} />}

        {answered && (
          <div style={styles.actions}>
            {!correct && (
              <button type="button" style={styles.ghost} onClick={() => setPicked(null)}>
                Try again
              </button>
            )}
            <button
              type="button"
              style={styles.primary}
              onClick={() => goTo(isLast ? 0 : index + 1)}
            >
              {isLast ? "Back to puzzle 1" : "Next puzzle"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Styles ---------- */

const SERIF =
  '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif';

const button: CSSProperties = {
  minHeight: 46,
  padding: "0 24px",
  borderRadius: 24,
  fontSize: "1rem",
  fontWeight: 700,
  cursor: "pointer",
  touchAction: "manipulation",
};

const styles: Record<string, CSSProperties> = {
  page: {
    flex: "1 0 auto",
    boxSizing: "border-box",
    padding: "20px 16px 48px",
    background: "radial-gradient(ellipse at top, #1c5a46 0%, #12382d 70%)",
    color: "#f4efe0",
    fontFamily: "system-ui, sans-serif",
  },
  inner: { maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 },
  hero: { display: "flex", flexDirection: "column", gap: 8 },
  h1: { margin: 0, fontSize: "clamp(1.6rem, 6vw, 2.2rem)", lineHeight: 1.2 },
  zh: { fontFamily: SERIF, color: "#f2b134", marginRight: 6 },
  h2: { margin: 0, fontSize: "1.2rem", color: "#f2b134" },
  text: { margin: 0, lineHeight: 1.55, fontSize: "0.95rem" },
  question: { margin: 0, fontSize: "1.1rem", fontWeight: 700 },

  progress: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  step: {
    width: 40,
    height: 40,
    borderRadius: "50%",
    border: "2px solid rgba(244,239,224,0.4)",
    background: "transparent",
    color: "#f4efe0",
    fontSize: "0.95rem",
    fontWeight: 800,
    cursor: "pointer",
    touchAction: "manipulation",
  },
  stepDone: { borderColor: "#4ade80", color: "#4ade80" },
  stepCurrent: { background: "#f2b134", borderColor: "#f2b134", color: "#1f2430" },
  score: { marginLeft: "auto", fontSize: "0.9rem", opacity: 0.85 },

  card: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "16px",
    borderRadius: 14,
    background: "rgba(0,0,0,0.24)",
    boxShadow: "inset 0 0 0 1px rgba(244,239,224,0.12), 0 6px 16px rgba(0,0,0,0.25)",
  },
  good: { boxShadow: "inset 0 0 0 2px #4ade80, 0 6px 16px rgba(0,0,0,0.25)" },
  bad: { boxShadow: "inset 0 0 0 2px #f87171, 0 6px 16px rgba(0,0,0,0.25)" },
  feedbackTitle: { margin: 0, fontSize: "1.2rem" },

  hand: {
    ["--tile-width" as string]: "clamp(20px, 6vw, 52px)",
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "10px 4px",
    padding: "14px 4px 10px",
  },
  slot: { display: "flex", borderRadius: 8 },
  ringGood: { boxShadow: "0 0 0 4px #4ade80, 0 0 14px 4px rgba(74,222,128,0.55)" },
  ringBad: { boxShadow: "0 0 0 4px #f87171, 0 0 14px 4px rgba(248,113,113,0.55)" },
  smallRow: {
    ["--tile-width" as string]: "clamp(24px, 6.5vw, 40px)",
    display: "flex",
    flexWrap: "wrap",
    gap: 4,
  },

  actions: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  primary: { ...button, border: "none", background: "#f2b134", color: "#1f2430" },
  ghost: {
    ...button,
    border: "2px solid rgba(244,239,224,0.5)",
    background: "transparent",
    color: "#f4efe0",
  },
  hint: { margin: 0, textAlign: "center", fontSize: "0.95rem", color: "#fde68a" },
};
