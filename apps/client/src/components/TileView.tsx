import type { CSSProperties, ReactNode } from "react";
import type { SuitRank, Tile, TileFace } from "@ourjong/engine";

export interface TileViewProps {
  /** Required unless the tile is face down (an opponent's concealed tile). */
  tile?: Tile;
  /** Show the green back instead of the face. Opponents' concealed hands use this. */
  faceDown?: boolean;
  isSelected?: boolean;
  isDrawn?: boolean;
  onClick?: () => void;
}

const COLORS = {
  red: "#c62828",
  green: "#1b7f3b",
  blue: "#1e4fa3",
  ink: "#1f2430",
  ivory: "#fbf7ea",
  ivoryEdge: "#e4dcc3",
  tileBack: "#2f8f6b",
  accent: "#f2b134",
  orange: "#e8962a",
};

const CHARACTER_NUMERALS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const WIND_GLYPHS = { east: "東", south: "南", west: "西", north: "北" } as const;
const DRAGON_GLYPHS = { red: "中", green: "發" } as const;

const SERIF =
  '"Noto Serif TC", "Noto Serif CJK TC", "Songti TC", "PMingLiU", "Hiragino Mincho ProN", serif';

/* ==========================================================================
 * Tile faces are drawn as inline SVG on a 60 x 80 canvas, so they scale cleanly with
 * --tile-width at any size. The usable area is roughly x 6-54, y 6-74.
 * ========================================================================== */

function Art({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 60 80"
      width="100%"
      height="100%"
      style={{ display: "block" }}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function Glyph({
  children,
  x = 30,
  y,
  size,
  color,
}: {
  children: ReactNode;
  x?: number;
  y: number;
  size: number;
  color: string;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontFamily={SERIF}
      fontWeight={900}
      fontSize={size}
      fill={color}
    >
      {children}
    </text>
  );
}

/* ---------- Dots (筒): concentric circles ---------- */

interface Spot {
  x: number;
  y: number;
  color: string;
}

const R = COLORS.red;
const G = COLORS.green;
const B = COLORS.blue;

// Where each dot sits, with the traditional colour mix. Ranks 2-3 use bigger dots.
const DOT_LAYOUTS: Record<number, { r: number; spots: Spot[] }> = {
  2: {
    r: 10.5,
    spots: [
      { x: 30, y: 22, color: G },
      { x: 30, y: 58, color: B },
    ],
  },
  3: {
    r: 9.5,
    spots: [
      { x: 15, y: 17, color: B },
      { x: 30, y: 40, color: R },
      { x: 45, y: 63, color: G },
    ],
  },
  4: {
    r: 9,
    spots: [
      { x: 18, y: 22, color: G },
      { x: 42, y: 22, color: B },
      { x: 18, y: 58, color: B },
      { x: 42, y: 58, color: G },
    ],
  },
  5: {
    r: 8.5,
    spots: [
      { x: 17, y: 20, color: G },
      { x: 43, y: 20, color: B },
      { x: 30, y: 40, color: R },
      { x: 17, y: 60, color: B },
      { x: 43, y: 60, color: G },
    ],
  },
  6: {
    r: 7.5,
    spots: [
      { x: 18, y: 18, color: G },
      { x: 42, y: 18, color: G },
      { x: 18, y: 46, color: R },
      { x: 42, y: 46, color: R },
      { x: 18, y: 64, color: R },
      { x: 42, y: 64, color: R },
    ],
  },
  7: {
    r: 7,
    spots: [
      { x: 14, y: 13, color: G },
      { x: 30, y: 19, color: G },
      { x: 46, y: 25, color: G },
      { x: 18, y: 50, color: R },
      { x: 42, y: 50, color: R },
      { x: 18, y: 66, color: R },
      { x: 42, y: 66, color: R },
    ],
  },
  8: {
    r: 7,
    spots: [14, 31.3, 48.7, 66].flatMap((y) => [
      { x: 18, y, color: B },
      { x: 42, y, color: B },
    ]),
  },
  9: {
    r: 7,
    spots: [
      { y: 16, color: G },
      { y: 40, color: R },
      { y: 64, color: B },
    ].flatMap(({ y, color }) => [14, 30, 46].map((x) => ({ x, y, color }))),
  },
};

function Dot({ x, y, r, color }: { x: number; y: number; r: number; color: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={color} stroke="rgba(0,0,0,0.3)" strokeWidth={0.5} />
      <circle cx={x} cy={y} r={r * 0.72} fill={COLORS.ivory} />
      <circle cx={x} cy={y} r={r * 0.54} fill={color} />
      <circle cx={x} cy={y} r={r * 0.2} fill={COLORS.ivory} />
    </g>
  );
}

function DotsFace({ rank }: { rank: SuitRank }) {
  if (rank === 1) {
    // The big ornate dot: red, green and blue rings round a red heart.
    return (
      <Art>
        <circle cx={30} cy={40} r={21} fill={R} stroke="rgba(0,0,0,0.3)" strokeWidth={0.5} />
        <circle cx={30} cy={40} r={17.5} fill={COLORS.ivory} />
        <circle cx={30} cy={40} r={15} fill={G} />
        <circle cx={30} cy={40} r={11} fill={COLORS.ivory} />
        <circle cx={30} cy={40} r={9} fill={B} />
        <circle cx={30} cy={40} r={4.5} fill={R} />
        <circle cx={30} cy={40} r={1.6} fill={COLORS.ivory} />
      </Art>
    );
  }
  const layout = DOT_LAYOUTS[rank];
  return (
    <Art>
      {layout.spots.map((spot, i) => (
        <Dot key={i} x={spot.x} y={spot.y} r={layout.r} color={spot.color} />
      ))}
    </Art>
  );
}

/* ---------- Bamboo (索): segmented sticks ---------- */

interface StickSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

function Stick({ x, y, w, h, color }: StickSpec) {
  const left = x - w / 2;
  const top = y - h / 2;
  return (
    <g>
      <rect
        x={left}
        y={top}
        width={w}
        height={h}
        rx={w / 2.6}
        fill={color}
        stroke="rgba(0,0,0,0.3)"
        strokeWidth={0.5}
      />
      {/* Joints between the three segments. */}
      <line x1={left} x2={left + w} y1={y - h / 6} y2={y - h / 6} stroke={COLORS.ivory} strokeWidth={1.2} />
      <line x1={left} x2={left + w} y1={y + h / 6} y2={y + h / 6} stroke={COLORS.ivory} strokeWidth={1.2} />
      {/* A soft highlight down one side. */}
      <rect
        x={left + w * 0.18}
        y={top + h * 0.08}
        width={w * 0.18}
        height={h * 0.84}
        rx={w * 0.09}
        fill="rgba(255,255,255,0.35)"
      />
    </g>
  );
}

const col = (xs: number[], y: number, w: number, h: number, color: string): StickSpec[] =>
  xs.map((x) => ({ x, y, w, h, color }));

const STICK_LAYOUTS: Record<number, StickSpec[]> = {
  2: [
    { x: 30, y: 24, w: 8, h: 28, color: G },
    { x: 30, y: 56, w: 8, h: 28, color: G },
  ],
  3: [
    { x: 30, y: 24, w: 8, h: 28, color: G },
    { x: 21, y: 56, w: 8, h: 28, color: G },
    { x: 39, y: 56, w: 8, h: 28, color: G },
  ],
  4: [...col([21, 39], 24, 8, 28, G), ...col([21, 39], 56, 8, 28, G)],
  5: [
    ...col([17, 43], 24, 8, 28, G),
    { x: 30, y: 40, w: 8, h: 28, color: R },
    ...col([17, 43], 56, 8, 28, G),
  ],
  6: [...col([15, 30, 45], 24, 8, 28, G), ...col([15, 30, 45], 56, 8, 28, G)],
  7: [
    { x: 30, y: 15, w: 8, h: 16, color: R },
    ...col([15, 30, 45], 39, 8, 20, G),
    ...col([15, 30, 45], 63, 8, 20, G),
  ],
  8: [...col([12, 24, 36, 48], 24, 7, 28, G), ...col([12, 24, 36, 48], 56, 7, 28, G)],
  9: [
    ...col([15, 30, 45], 16, 9, 20, G),
    ...col([15, 30, 45], 40, 9, 20, R),
    ...col([15, 30, 45], 64, 9, 20, B),
  ],
};

function OneBamboo() {
  // The traditional "1 bamboo" is a bird perched on a branch.
  return (
    <Art>
      <path d="M8 70 Q30 62 52 70" stroke={G} strokeWidth={3.5} fill="none" strokeLinecap="round" />
      <ellipse cx={20} cy={58} rx={4.2} ry={11} fill={R} transform="rotate(28 20 58)" />
      <ellipse cx={40} cy={58} rx={4.2} ry={11} fill={B} transform="rotate(-28 40 58)" />
      <ellipse cx={30} cy={61} rx={4.2} ry={12} fill={G} />
      <ellipse cx={30} cy={42} rx={11.5} ry={14.5} fill={G} stroke="rgba(0,0,0,0.3)" strokeWidth={0.5} />
      <path d="M22 40 Q30 55 40 40 Q32 33 22 40Z" fill={R} />
      <circle cx={30} cy={24} r={7.5} fill={G} stroke="rgba(0,0,0,0.3)" strokeWidth={0.5} />
      <path d="M28 18 L25 9 M31 17 L33 8" stroke={R} strokeWidth={2} strokeLinecap="round" />
      <path d="M36 23 L45 26 L36 29Z" fill={COLORS.orange} />
      <circle cx={32.5} cy={22.5} r={1.6} fill={COLORS.ivory} />
      <circle cx={33} cy={22.5} r={0.7} fill={COLORS.ink} />
    </Art>
  );
}

function BambooFace({ rank }: { rank: SuitRank }) {
  if (rank === 1) return <OneBamboo />;
  return (
    <Art>
      {STICK_LAYOUTS[rank].map((stick, i) => (
        <Stick key={i} {...stick} />
      ))}
    </Art>
  );
}

/* ---------- Everything else ---------- */

function CharactersFace({ rank }: { rank: SuitRank }) {
  return (
    <Art>
      <Glyph y={35} size={31} color={COLORS.ink}>
        {CHARACTER_NUMERALS[rank]}
      </Glyph>
      <Glyph y={69} size={33} color={COLORS.red}>
        萬
      </Glyph>
    </Art>
  );
}

function faceContent(face: TileFace): ReactNode {
  switch (face.kind) {
    case "suit":
      switch (face.suit) {
        case "characters":
          return <CharactersFace rank={face.rank} />;
        case "bamboo":
          return <BambooFace rank={face.rank} />;
        case "dots":
          return <DotsFace rank={face.rank} />;
      }
      break;
    case "wind":
      return (
        <Art>
          <Glyph y={57} size={46} color={COLORS.ink}>
            {WIND_GLYPHS[face.wind]}
          </Glyph>
        </Art>
      );
    case "dragon":
      if (face.dragon === "white") {
        // The white dragon is an empty frame.
        return (
          <Art>
            <rect x={13} y={11} width={34} height={58} rx={4} fill="none" stroke={B} strokeWidth={3.6} />
            <rect x={18.5} y={16.5} width={23} height={47} rx={2} fill="none" stroke={B} strokeWidth={1} />
          </Art>
        );
      }
      return (
        <Art>
          <Glyph y={59} size={52} color={face.dragon === "red" ? R : G}>
            {DRAGON_GLYPHS[face.dragon]}
          </Glyph>
        </Art>
      );
    case "flower":
      return (
        <Art>
          <Glyph y={44} size={34} color={R}>
            花
          </Glyph>
          <Glyph y={68} size={22} color={COLORS.ink}>
            {String(face.number)}
          </Glyph>
        </Art>
      );
    case "season":
      return (
        <Art>
          <Glyph y={44} size={34} color={G}>
            季
          </Glyph>
          <Glyph y={68} size={22} color={COLORS.ink}>
            {String(face.number)}
          </Glyph>
        </Art>
      );
    case "custom":
      return (
        <Art>
          <Glyph y={44} size={14} color={COLORS.ink}>
            {face.key}
          </Glyph>
        </Art>
      );
  }
}

function describeFace(face: TileFace): string {
  switch (face.kind) {
    case "suit":
      return `${face.rank} of ${face.suit}`;
    case "wind":
      return `${face.wind} wind`;
    case "dragon":
      return `${face.dragon} dragon`;
    case "flower":
      return `flower ${face.number}`;
    case "season":
      return `season ${face.number}`;
    case "custom":
      return face.key;
  }
}

/* ---------- The tile itself ---------- */

// Thickness of the tile edge: scales with the tile, never thinner than 2px.
const DEPTH = "clamp(2px, calc(var(--tile-width, 44px) * 0.065), 5px)";

export function TileView({
  tile,
  faceDown = false,
  isSelected = false,
  isDrawn = false,
  onClick,
}: TileViewProps) {
  const hidden = faceDown || tile === undefined;

  // Outer element: the visible tile (size, shape, shadow). No padding here.
  const outerStyle: CSSProperties = {
    // Size the tile by setting --tile-width on it or any ancestor.
    width: "var(--tile-width, clamp(28px, 6vmin, 56px))",
    aspectRatio: "3 / 4",
    position: "relative",
    boxSizing: "border-box",
    flex: "0 0 auto",
    display: "block",
    padding: 0,
    margin: 0,
    background: hidden ? "linear-gradient(145deg, #3fae86, #1f6e55)" : COLORS.ivory,
    border: `clamp(1px, calc(var(--tile-width, 44px) * 0.025), 2px) solid ${hidden ? "#14503d" : COLORS.ivoryEdge}`,
    borderRadius: "14% / 11%",
    boxShadow: isSelected
      ? `0 calc(var(--tile-width, 44px) * 0.18) calc(var(--tile-width, 44px) * 0.3) rgba(0,0,0,0.28), 0 0 0 2px ${COLORS.accent}`
      : isDrawn
        ? `0 ${DEPTH} 0 ${hidden ? "#0f3d2e" : COLORS.tileBack}, 0 0 0 2px ${COLORS.accent}`
        : hidden
          ? `0 ${DEPTH} 0 #0f3d2e, 0 calc(${DEPTH} * 1.4) calc(${DEPTH} * 2) rgba(0,0,0,0.3)`
          : `0 ${DEPTH} 0 ${COLORS.tileBack}, 0 calc(${DEPTH} * 1.4) calc(${DEPTH} * 2) rgba(0,0,0,0.22)`,
    transform: isSelected ? "translateY(calc(var(--tile-width, 44px) * -0.22))" : "none",
    transition: "transform 120ms ease, box-shadow 120ms ease",
    cursor: onClick ? "pointer" : "default",
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
    userSelect: "none",
    font: "inherit",
    color: "inherit",
  };

  if (hidden || tile === undefined) {
    return (
      <div role="img" aria-label="Face-down tile" style={outerStyle}>
        <span
          style={{
            position: "absolute",
            inset: "11%",
            borderRadius: "12% / 9%",
            border: "1px solid rgba(255,255,255,0.35)",
            background:
              "repeating-linear-gradient(45deg, rgba(255,255,255,0.09) 0 3px, transparent 3px 6px)",
            boxShadow: "inset 0 1px 2px rgba(0,0,0,0.25)",
          }}
        />
      </div>
    );
  }

  const inner = (
    <span
      style={{
        position: "absolute",
        inset: 0,
        display: "block",
        boxSizing: "border-box",
        padding: "7% 8%",
        overflow: "hidden",
        borderRadius: "inherit",
      }}
    >
      {faceContent(tile.face)}
    </span>
  );

  const label = describeFace(tile.face);

  if (!onClick) {
    return (
      <div role="img" aria-label={label} style={outerStyle}>
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isSelected}
      onClick={onClick}
      style={outerStyle}
    >
      {inner}
    </button>
  );
}
