import type { CSSProperties, ReactNode } from "react";
import { LIMIT_FAN, calculateFan, isLimitFan } from "@ourjong/engine";
import type {
  DragonName,
  SuitName,
  SuitRank,
  Tile,
  TileFace,
  WindName,
} from "@ourjong/engine";
import { TileView } from "./TileView";

/* ---------- Example tiles ---------- */

// The guide only draws tiles, so ids are made up here. Each face gets copies 0-3 in turn.
let nextId = 90_000;
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

const wind = (name: WindName, n: number): Tile[] =>
  Array.from({ length: n }, () => mk({ kind: "wind", wind: name }));
const dragon = (name: DragonName, n: number): Tile[] =>
  Array.from({ length: n }, () => mk({ kind: "dragon", dragon: name }));

/* ---------- Pattern data ---------- */

interface Group {
  tiles: Tile[];
  /** The group the pattern is about; drawn with a gold highlight. */
  highlight?: boolean;
  pair?: boolean;
}

interface Example {
  groups: Group[];
  /** Winds used when scoring the example. */
  seat?: WindName;
  prevalent?: WindName;
  /** Illustrative groups only (not a full hand): no score line. */
  partial?: boolean;
  caption?: string;
}

interface Pattern {
  id: string;
  zh: string;
  en: string;
  /** Fan value, or "limit" for the hand that scores the maximum. */
  fan: number | "limit";
  rule: string;
  examples: Example[];
}

const meld = (tiles: Tile[], highlight = false): Group => ({ tiles, highlight });
const pairOf = (tiles: Tile[], highlight = false): Group => ({ tiles, pair: true, highlight });

// Winds used for the examples unless an example says otherwise: you sit East in an East round.
const DEFAULT_SEAT: WindName = "east";
const DEFAULT_PREVALENT: WindName = "east";

const PATTERNS: Pattern[] = [
  {
    id: "common-hand",
    zh: "平胡",
    en: "Common Hand",
    fan: 1,
    rule: "Four chows and a pair of plain suit tiles: no pongs, and the pair is not winds or dragons.",
    examples: [
      {
        groups: [
          meld(dots(1, 2, 3), true),
          meld(bamboo(2, 3, 4), true),
          meld(chars(5, 6, 7), true),
          meld(dots(7, 8, 9), true),
          pairOf(bamboo(8, 8), true),
        ],
      },
    ],
  },
  {
    id: "all-in-triplets",
    zh: "對對胡",
    en: "All in Triplets",
    fan: 3,
    rule: "Four pongs or kongs and a pair, with no chows at all.",
    examples: [
      {
        groups: [
          meld(dots(2, 2, 2), true),
          meld(bamboo(6, 6, 6), true),
          meld(chars(9, 9, 9), true),
          meld(dots(4, 4, 4), true),
          pairOf(chars(3, 3)),
        ],
      },
    ],
  },
  {
    id: "mixed-one-suit",
    zh: "混一色",
    en: "Mixed One Suit",
    fan: 3,
    rule: "Every tile is from a single suit, except for some wind or dragon tiles.",
    examples: [
      {
        groups: [
          meld(bamboo(1, 2, 3)),
          meld(bamboo(4, 5, 6)),
          meld(bamboo(7, 7, 7)),
          meld(wind("south", 3), true),
          pairOf(bamboo(9, 9)),
        ],
      },
    ],
  },
  {
    id: "all-one-suit",
    zh: "清一色",
    en: "All One Suit",
    fan: 7,
    rule: "Every tile is from a single suit, with no winds or dragons at all.",
    examples: [
      {
        groups: [
          meld(dots(1, 2, 3)),
          meld(dots(4, 5, 6)),
          meld(dots(7, 8, 9)),
          meld(dots(2, 2, 2)),
          pairOf(dots(9, 9)),
        ].map((g) => ({ ...g, highlight: true })),
      },
    ],
  },
  {
    id: "small-three-dragons",
    zh: "小三元",
    en: "Small Three Dragons",
    fan: 5,
    rule: "Pongs (or kongs) of two of the three dragons, plus a pair of the third. The pattern itself is worth 3 fan, and each of the two dragon pongs adds its own 1 fan, so the hand is 5 fan before anything else.",
    examples: [
      {
        groups: [
          meld(dragon("red", 3), true),
          meld(dragon("green", 3), true),
          pairOf(dragon("white", 2), true),
          meld(dots(2, 3, 4)),
          meld(bamboo(6, 7, 8)),
        ],
      },
    ],
  },
  {
    id: "small-four-winds",
    zh: "小四喜",
    en: "Small Four Winds",
    fan: 6,
    rule: "Pongs (or kongs) of three of the four winds, plus a pair of the fourth. Worth 6 fan; a seat or round wind pong, and a single-suit remainder, score on top.",
    examples: [
      {
        groups: [
          meld(wind("east", 3), true),
          meld(wind("south", 3), true),
          meld(wind("west", 3), true),
          pairOf(wind("north", 2), true),
          meld(dots(4, 5, 6)),
        ],
        caption: "The chow is from one suit, so Mixed One Suit (3 fan) is added to the 6.",
        seat: "north",
        prevalent: "north",
      },
    ],
  },
  {
    id: "all-honors",
    zh: "字一色",
    en: "All Honours",
    fan: 10,
    rule: "The whole hand is winds and dragons. A limit hand worth 10 fan on its own: nothing else is added to it.",
    examples: [
      {
        groups: [
          meld(wind("east", 3), true),
          meld(wind("south", 3), true),
          meld(dragon("red", 3), true),
          meld(dragon("white", 3), true),
          pairOf(wind("north", 2), true),
        ],
        seat: "west",
        prevalent: "west",
      },
    ],
  },
  {
    id: "thirteen-orphans",
    zh: "十三么",
    en: "Thirteen Orphans",
    fan: 13,
    rule: "One of each terminal (1 and 9 of every suit), each wind and each dragon, plus a second copy of any one of them as the pair. No melds, and it must be fully concealed. The top limit hand: 13 fan.",
    examples: [
      {
        caption: "Thirteen different tiles, with the red dragon doubled as the pair.",
        groups: [
          meld(dots(1, 9), true),
          meld(bamboo(1, 9), true),
          meld(chars(1, 9), true),
          meld(
            [
              ...wind("east", 1),
              ...wind("south", 1),
              ...wind("west", 1),
              ...wind("north", 1),
            ],
            true,
          ),
          meld([...dragon("green", 1), ...dragon("white", 1), ...dragon("red", 2)], true),
        ],
      },
    ],
  },
  {
    id: "dragon-pung",
    zh: "箭刻",
    en: "Dragon Pong or Kong",
    fan: 1,
    rule: "A pong or kong of red (紅中), green (發) or white (白板) dragons: 1 fan for each one you hold.",
    examples: [
      {
        groups: [
          meld(dots(1, 2, 3)),
          meld(bamboo(4, 5, 6)),
          meld(chars(7, 8, 9)),
          meld(dragon("red", 3), true),
          pairOf(dots(5, 5)),
        ],
      },
      {
        partial: true,
        caption: "Red 紅中, green 發 and white 白板 each count the same.",
        groups: [
          meld(dragon("red", 3), true),
          meld(dragon("green", 3), true),
          meld(dragon("white", 3), true),
        ],
      },
    ],
  },
  {
    id: "seat-wind",
    zh: "門風",
    en: "Seat Wind",
    fan: 1,
    rule: "A pong or kong of the wind that matches your own seat; here you sit East (東).",
    examples: [
      {
        groups: [
          meld(dots(1, 2, 3)),
          meld(bamboo(4, 5, 6)),
          meld(chars(7, 8, 9)),
          meld(wind("east", 3), true),
          pairOf(dots(5, 5)),
        ],
        seat: "east",
        prevalent: "south",
      },
    ],
  },
  {
    id: "prevalent-wind",
    zh: "圈風",
    en: "Prevalent Wind",
    fan: 1,
    rule: "A pong or kong of the wind of the current round; in a South round that is South (南).",
    examples: [
      {
        groups: [
          meld(dots(1, 2, 3)),
          meld(bamboo(4, 5, 6)),
          meld(chars(7, 8, 9)),
          meld(wind("south", 3), true),
          pairOf(dots(5, 5)),
        ],
        seat: "east",
        prevalent: "south",
      },
      {
        caption: "When your seat wind is also the round wind, one pong scores both: 2 fan.",
        groups: [
          meld(dots(1, 2, 3)),
          meld(bamboo(4, 5, 6)),
          meld(chars(7, 8, 9)),
          meld(wind("east", 3), true),
          pairOf(dots(5, 5)),
        ],
        seat: "east",
        prevalent: "east",
      },
    ],
  },
];

/* ---------- Building blocks ---------- */

function ExampleHand({ example }: { example: Example }) {
  const tiles = example.groups.flatMap((g) => g.tiles);
  const result = example.partial
    ? null
    : calculateFan(
        tiles,
        [],
        tiles[tiles.length - 1],
        example.seat ?? DEFAULT_SEAT,
        example.prevalent ?? DEFAULT_PREVALENT,
      );

  return (
    <figure style={styles.example}>
      <div style={styles.exampleTiles}>
        {example.groups.map((group, i) => (
          <div
            key={i}
            style={{
              ...styles.group,
              ...(group.pair ? styles.pairGroup : null),
              ...(group.highlight ? styles.highlightGroup : null),
            }}
          >
            {group.tiles.map((tile) => (
              <TileView key={tile.id} tile={tile} />
            ))}
          </div>
        ))}
      </div>

      {(example.caption || result) && (
        <figcaption style={styles.caption}>
          {example.caption && <span>{example.caption}</span>}
          {result && result.totalFan > 0 && (
            <span>
              This hand scores{" "}
              <strong style={styles.gold}>
                {result.totalFan} fan{isLimitFan(result.totalFan) ? " (limit)" : ""}
              </strong>
              : {result.patterns.join(", ")}.
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}

function FanBadge({ fan }: { fan: Pattern["fan"] }) {
  if (fan === "limit") {
    return <span style={{ ...styles.fanBadge, ...styles.limitBadge }}>Limit · {LIMIT_FAN} fan</span>;
  }
  return isLimitFan(fan) ? (
    <span style={{ ...styles.fanBadge, ...styles.limitBadge }}>Limit · {fan} fan</span>
  ) : (
    <span style={styles.fanBadge}>{fan} fan</span>
  );
}

function PatternCard({ pattern }: { pattern: Pattern }) {
  return (
    <article style={styles.card} id={pattern.id}>
      <header style={styles.patternHeader}>
        <span style={styles.zh}>{pattern.zh}</span>
        <span style={styles.en}>{pattern.en}</span>
        <FanBadge fan={pattern.fan} />
      </header>
      <p style={styles.text}>{pattern.rule}</p>
      {pattern.examples.map((example, i) => (
        <ExampleHand key={i} example={example} />
      ))}
    </article>
  );
}

function Section({
  id,
  title,
  zh,
  children,
}: {
  id: string;
  title: string;
  zh: string;
  children: ReactNode;
}) {
  return (
    <section id={id} style={styles.section} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} style={styles.h2}>
        <span style={styles.h2zh}>{zh}</span> {title}
      </h2>
      {children}
    </section>
  );
}

function RuleCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article style={styles.card}>
      <h3 style={styles.h3}>{title}</h3>
      {children}
    </article>
  );
}

const scrollTo = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

/* ---------- The guide ---------- */

export function ReferenceGuide() {
  return (
    <div style={styles.page}>
      <div style={styles.inner}>
        <header style={styles.hero}>
          <h1 style={styles.h1}>
            <span style={styles.h1zh}>規則</span> Reference Guide
          </h1>
          <p style={styles.text}>
            How Hong Kong Old Style Mahjong plays here, and what each winning pattern is worth.
          </p>
          <nav style={styles.jump} aria-label="Jump to a section">
            <button type="button" style={styles.jumpButton} onClick={() => scrollTo("rules")}>
              Basic Rules
            </button>
            <button type="button" style={styles.jumpButton} onClick={() => scrollTo("scoring")}>
              Scoring Patterns
            </button>
          </nav>
        </header>

        <Section id="rules" title="Basic Rules" zh="玩法">
          <RuleCard title="The goal">
            <p style={styles.text}>
              Be first to complete a hand of <strong>14 tiles</strong>: <strong>4 melds</strong> and{" "}
              <strong>1 pair</strong>. You hold 13 tiles, and the 14th is the one you draw or claim
              to win. A kong has four tiles but counts as one meld.
            </p>
          </RuleCard>

          <RuleCard title="The tiles">
            <p style={styles.text}>
              136 tiles: three suits numbered 1-9 (bamboo, characters, dots), four winds and three
              dragons, four copies of each. There are no flowers or seasons.
            </p>
            <div style={styles.tileRows}>
              <div style={styles.tileRow}>{bamboo(1, 2, 3, 4, 5, 6, 7, 8, 9).map(renderTile)}</div>
              <div style={styles.tileRow}>{chars(1, 2, 3, 4, 5, 6, 7, 8, 9).map(renderTile)}</div>
              <div style={styles.tileRow}>{dots(1, 2, 3, 4, 5, 6, 7, 8, 9).map(renderTile)}</div>
              <div style={styles.tileRow}>
                {(["east", "south", "west", "north"] as const)
                  .flatMap((w) => wind(w, 1))
                  .map(renderTile)}
                <span style={styles.rowGap} />
                {(["red", "green", "white"] as const).flatMap((d) => dragon(d, 1)).map(renderTile)}
              </div>
            </div>
          </RuleCard>

          <RuleCard title="Melds">
            <div style={styles.meldExamples}>
              <figure style={styles.meldExample}>
                <div style={styles.group}>{dots(4, 5, 6).map(renderTile)}</div>
                <figcaption style={styles.caption}>
                  <strong style={styles.gold}>Chow 吃</strong> Three in a row in one suit.
                </figcaption>
              </figure>
              <figure style={styles.meldExample}>
                <div style={styles.group}>{bamboo(7, 7, 7).map(renderTile)}</div>
                <figcaption style={styles.caption}>
                  <strong style={styles.gold}>Pong 碰</strong> Three identical tiles.
                </figcaption>
              </figure>
              <figure style={styles.meldExample}>
                <div style={styles.group}>{chars(2, 2, 2, 2).map(renderTile)}</div>
                <figcaption style={styles.caption}>
                  <strong style={styles.gold}>Kong 槓</strong> Four identical tiles.
                </figcaption>
              </figure>
            </div>
            <p style={styles.text}>
              Winds and dragons can only form pongs and kongs, never chows.
            </p>
          </RuleCard>

          <RuleCard title="Taking a turn">
            <p style={styles.text}>
              Draw one tile, then discard one. Play goes around the table East → South → West →
              North, and you can only throw away a tile from your 13 or the one you just drew.
            </p>
          </RuleCard>

          <RuleCard title="Claiming a discard">
            <ul style={styles.list}>
              <li>
                <strong>Pong or kong:</strong> claim any player's discard when you hold the matching
                tiles.
              </li>
              <li>
                <strong>Chow:</strong> only on the discard of the player to your left, the one who
                plays just before you.
              </li>
              <li>
                <strong>Win:</strong> claim any discard that completes your hand.
              </li>
              <li>
                <strong>Priority:</strong> a win beats a pong or kong, which beats a chow. A claim
                skips everyone in between, and you discard next.
              </li>
            </ul>
          </RuleCard>

          <RuleCard title="Kongs and the dead wall">
            <ul style={styles.list}>
              <li>
                <strong>Concealed kong:</strong> four identical tiles from your own hand.
              </li>
              <li>
                <strong>Added kong:</strong> the fourth tile joins one of your open pongs.
              </li>
              <li>
                <strong>Exposed kong:</strong> claim a discard when you hold the other three.
              </li>
              <li>
                Every kong draws a replacement tile from the end of the wall (the dead wall), and the
                dead wall is topped up from the live wall so it stays 16 tiles.
              </li>
              <li>
                <strong>Robbing the kong 搶槓:</strong> when someone adds to a pong, any player who
                could win on that tile may do so, and the kong never happens.
              </li>
            </ul>
          </RuleCard>

          <RuleCard title="Winning and scoring">
            <ul style={styles.list}>
              <li>
                Each pattern below is worth a number of <strong>fan</strong>. Patterns add up, to a
                maximum of {LIMIT_FAN}.
              </li>
              <li>
                Hong Kong Old Style normally needs at least <strong>3 fan</strong> to win. The game
                shows your fan but doesn't enforce that minimum yet.
              </li>
              <li>If the wall runs out with no winner, the hand is a draw.</li>
            </ul>
          </RuleCard>
        </Section>

        <Section id="scoring" title="Scoring Patterns" zh="番種">
          <p style={styles.text}>
            Gold outlines mark the part of the hand that earns the fan. Each score line is worked
            out by the game's own scoring code, so it always matches what you'll see at the table.
          </p>
          {PATTERNS.map((pattern) => (
            <PatternCard key={pattern.id} pattern={pattern} />
          ))}
        </Section>
      </div>
    </div>
  );
}

function renderTile(tile: Tile) {
  return <TileView key={tile.id} tile={tile} />;
}

/* ---------- Styles ---------- */

const SERIF =
  '"Noto Serif TC", "Noto Serif CJK TC", "PingFang TC", "Hiragino Mincho ProN", serif';

const styles: Record<string, CSSProperties> = {
  page: {
    flex: "1 0 auto",
    boxSizing: "border-box",
    padding: "20px 16px 48px",
    background: "radial-gradient(ellipse at top, #1c5a46 0%, #12382d 70%)",
    color: "#f4efe0",
    fontFamily: "system-ui, sans-serif",
  },
  inner: {
    maxWidth: 760,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 28,
  },
  hero: { display: "flex", flexDirection: "column", gap: 10 },
  h1: { margin: 0, fontSize: "clamp(1.6rem, 6vw, 2.2rem)", lineHeight: 1.2 },
  h1zh: { fontFamily: SERIF, color: "#f2b134", marginRight: 6 },
  jump: { display: "flex", flexWrap: "wrap", gap: 8 },
  jumpButton: {
    minHeight: 40,
    padding: "0 18px",
    borderRadius: 20,
    border: "2px solid rgba(242,177,52,0.6)",
    background: "transparent",
    color: "#f2b134",
    fontSize: "0.9rem",
    fontWeight: 700,
    cursor: "pointer",
    touchAction: "manipulation",
  },
  section: { display: "flex", flexDirection: "column", gap: 14, scrollMarginTop: 12 },
  h2: {
    margin: 0,
    paddingBottom: 8,
    borderBottom: "2px solid rgba(242,177,52,0.45)",
    fontSize: "1.35rem",
  },
  h2zh: { fontFamily: SERIF, color: "#f2b134", marginRight: 4 },
  h3: { margin: 0, fontSize: "1.05rem", color: "#f2b134" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "14px 16px",
    borderRadius: 14,
    background: "rgba(0,0,0,0.24)",
    boxShadow: "inset 0 0 0 1px rgba(244,239,224,0.12), 0 6px 16px rgba(0,0,0,0.25)",
    scrollMarginTop: 12,
  },
  text: { margin: 0, lineHeight: 1.55, fontSize: "0.95rem" },
  list: { margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6, lineHeight: 1.5, fontSize: "0.95rem" },
  gold: { color: "#f2b134" },

  patternHeader: { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" },
  zh: { fontFamily: SERIF, fontSize: "1.7rem", fontWeight: 900, color: "#f2b134", lineHeight: 1.1 },
  en: { fontSize: "1.05rem", fontWeight: 700, letterSpacing: "0.04em" },
  fanBadge: {
    marginLeft: "auto",
    padding: "3px 12px",
    borderRadius: 999,
    background: "#f2b134",
    color: "#1f2430",
    fontSize: "0.85rem",
    fontWeight: 800,
    whiteSpace: "nowrap",
  },
  limitBadge: { background: "#c62828", color: "#fff" },

  example: {
    ["--tile-width" as string]: "clamp(17px, 4.9vw, 30px)",
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 10,
    borderRadius: 10,
    background: "rgba(0,0,0,0.2)",
  },
  exampleTiles: { display: "flex", flexWrap: "wrap", gap: "8px 10px" },
  group: {
    display: "flex",
    gap: 1,
    padding: 3,
    borderRadius: 6,
    boxShadow: "inset 0 0 0 1px transparent",
  },
  pairGroup: { boxShadow: "inset 0 0 0 1px rgba(244,239,224,0.3)" },
  highlightGroup: {
    background: "rgba(242,177,52,0.18)",
    boxShadow: "0 0 0 2px #f2b134",
  },
  caption: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    fontSize: "0.85rem",
    lineHeight: 1.45,
    opacity: 0.92,
  },

  tileRows: {
    ["--tile-width" as string]: "clamp(17px, 5.2vw, 32px)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  tileRow: { display: "flex", flexWrap: "wrap", gap: 2 },
  rowGap: { width: 10 },
  meldExamples: {
    ["--tile-width" as string]: "clamp(22px, 6.4vw, 34px)",
    display: "flex",
    flexWrap: "wrap",
    gap: "14px 24px",
  },
  meldExample: { margin: 0, display: "flex", flexDirection: "column", gap: 6, maxWidth: 220 },
};
