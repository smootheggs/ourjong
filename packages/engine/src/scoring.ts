import type {
  DragonName,
  GameState,
  Meld,
  Payment,
  Scores,
  ScoringResult,
  SeatIndex,
  Standing,
  SuitName,
  Tile,
  TileFace,
  WindName,
} from "./types.ts";

/** The most a single hand can score. All Honors is worth exactly this. */
export const LIMIT_FAN = 13;

/**
 * Every pattern the engine recognises and what it is worth. `calculateFan` reads its values from
 * here and `patternLabels` reads them back, so a pattern's worth is written down exactly once.
 * (The names are the ones that appear in `ScoringResult.patterns`.)
 */
export const PATTERN_FAN = {
  "Common Hand": 1, // Ping Wu: four chows and a plain pair
  "All in Triplets": 3, // Dui Dui Hu: four pungs or kongs and a pair
  "Mixed One Suit": 3, // Hun Yi Se: one suit plus honors
  "All One Suit": 7, // Qing Yi Se: one suit, no honors
  "Small Three Dragons": 3, // Siu Sam Yuen: two dragon pungs and a pair of the third (5 with the pungs)
  "Small Four Winds": 6, // Siu Sei Hei: three wind pungs and a pair of the fourth wind
  "All Honors": 10, // Zi Yi Se: nothing but winds and dragons (a limit hand)
  "Thirteen Orphans": LIMIT_FAN, // Sap Saam Yiu: one of each terminal and honor, plus any one twice
  "Red Dragon": 1,
  "Green Dragon": 1,
  "White Dragon": 1,
  "Seat Wind": 1,
  "Prevalent Wind": 1,
} as const satisfies Record<string, number>;

export type PatternName = keyof typeof PATTERN_FAN;

/**
 * Limit hands. They are worth their own value and nothing is added on top of it: an All Honors
 * hand is always four pungs and a pair, and counting those again would make it worth the cap
 * every time.
 */
export const LIMIT_HANDS: readonly PatternName[] = ["All Honors", "Thirteen Orphans"];

/* ---------- Face indexing ---------- */

// Every face gets an index 0-33 so a hand becomes a small count array:
// 0-26 suit tiles (bamboo, characters, dots; ranks 1-9), 27-30 winds, 31-33 dragons.
const SUIT_ORDER: readonly SuitName[] = ["bamboo", "characters", "dots"];
const WIND_ORDER: readonly WindName[] = ["east", "south", "west", "north"];
const DRAGON_ORDER: readonly DragonName[] = ["red", "green", "white"];
const WIND_BASE = 27;
const DRAGON_BASE = 31;
const FACE_COUNT = 34;

const isSuitIndex = (i: number) => i < WIND_BASE;
const isWindIndex = (i: number) => i >= WIND_BASE && i < DRAGON_BASE;
const isDragonIndex = (i: number) => i >= DRAGON_BASE;

function faceIndex(face: TileFace): number | null {
  switch (face.kind) {
    case "suit":
      return SUIT_ORDER.indexOf(face.suit) * 9 + face.rank - 1;
    case "wind":
      return WIND_BASE + WIND_ORDER.indexOf(face.wind);
    case "dragon":
      return DRAGON_BASE + DRAGON_ORDER.indexOf(face.dragon);
    default:
      return null; // flowers, seasons and custom faces never score here
  }
}

/* ---------- Groups and decomposition ---------- */

/** A meld reduced to its shape. Kongs count as pungs. A chow's index is its lowest tile. */
interface Group {
  readonly kind: "chow" | "pung";
  readonly index: number;
}

function meldToGroup(meld: Meld): Group | null {
  const indices = meld.tiles.map((t) => faceIndex(t.face));
  if (indices.length === 0 || indices.some((i) => i === null)) return null;
  const nums = indices as number[];

  if (meld.type === "chow") {
    const sorted = [...nums].sort((a, b) => a - b);
    const consecutive =
      sorted.length === 3 &&
      isSuitIndex(sorted[2]) &&
      sorted[1] === sorted[0] + 1 &&
      sorted[2] === sorted[0] + 2 &&
      Math.floor(sorted[0] / 9) === Math.floor(sorted[2] / 9);
    return consecutive ? { kind: "chow", index: sorted[0] } : null;
  }

  return nums.every((i) => i === nums[0]) ? { kind: "pung", index: nums[0] } : null;
}

/** Every way to split the counts entirely into pungs and chows (lowest face first). */
function splitMelds(counts: number[]): Group[][] {
  const i = counts.findIndex((c) => c > 0);
  if (i === -1) return [[]];

  const out: Group[][] = [];

  if (counts[i] >= 3) {
    counts[i] -= 3;
    for (const rest of splitMelds(counts)) out.push([{ kind: "pung", index: i }, ...rest]);
    counts[i] += 3;
  }

  if (isSuitIndex(i) && i % 9 <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--;
    counts[i + 1]--;
    counts[i + 2]--;
    for (const rest of splitMelds(counts)) out.push([{ kind: "chow", index: i }, ...rest]);
    counts[i]++;
    counts[i + 1]++;
    counts[i + 2]++;
  }

  return out;
}

/** Every pair + melds reading of the concealed tiles. */
function readings(counts: number[]): Array<{ pair: number; groups: Group[] }> {
  const out: Array<{ pair: number; groups: Group[] }> = [];
  for (let pair = 0; pair < FACE_COUNT; pair++) {
    if (counts[pair] < 2) continue;
    counts[pair] -= 2;
    for (const groups of splitMelds(counts)) out.push({ pair, groups });
    counts[pair] += 2;
  }
  return out;
}

/* ---------- Thirteen Orphans ---------- */

/** The 13 faces of a Thirteen Orphans hand: both ends of every suit, and all seven honors. */
const ORPHAN_INDICES: readonly number[] = [
  ...[0, 1, 2].flatMap((suit) => [suit * 9, suit * 9 + 8]),
  ...Array.from({ length: 7 }, (_, i) => WIND_BASE + i),
];

/** 14 tiles: every orphan at least once, which leaves exactly one of them held twice. */
function isThirteenOrphans(counts: readonly number[]): boolean {
  const total = counts.reduce((sum, c) => sum + c, 0);
  return total === 14 && ORPHAN_INDICES.every((index) => counts[index] >= 1);
}

/* ---------- Scoring one reading ---------- */

interface Entry {
  readonly name: PatternName;
  readonly fan: number;
}

const entry = (name: PatternName): Entry => ({ name, fan: PATTERN_FAN[name] });

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function scoreReading(
  pair: number,
  groups: readonly Group[],
  seatIndex: number,
  prevalentIndex: number,
): ScoringResult {
  // A hand of nothing but winds and dragons is a limit hand, scored on its own.
  if ([pair, ...groups.map((g) => g.index)].every((index) => !isSuitIndex(index))) {
    const only = entry("All Honors");
    return { totalFan: only.fan, patterns: [only.name] };
  }

  const entries: Entry[] = [];

  // Hand shape.
  if (groups.every((g) => g.kind === "pung")) {
    entries.push(entry("All in Triplets"));
  } else if (groups.every((g) => g.kind === "chow") && isSuitIndex(pair)) {
    // A common hand needs a plain pair: an honor pair (wind or dragon) rules it out.
    entries.push(entry("Common Hand"));
  }

  // Suit makeup.
  const suits = new Set<number>();
  let hasHonor = false;
  for (const index of [pair, ...groups.map((g) => g.index)]) {
    if (isSuitIndex(index)) suits.add(Math.floor(index / 9));
    else hasHonor = true;
  }
  if (suits.size === 1) {
    entries.push(
      entry(hasHonor ? "Mixed One Suit" : "All One Suit"),
    );
  }

  // Honor bonuses: a pung or kong of dragons, the seat wind or the prevalent wind.
  for (const group of groups) {
    if (group.kind !== "pung") continue;
    if (isDragonIndex(group.index)) {
      const dragon = DRAGON_ORDER[group.index - DRAGON_BASE];
      entries.push(entry(`${capitalize(dragon)} Dragon` as PatternName));
    } else if (isWindIndex(group.index)) {
      if (group.index === seatIndex) entries.push(entry("Seat Wind"));
      if (group.index === prevalentIndex) entries.push(entry("Prevalent Wind"));
    }
  }

  // Small Three Dragons / Small Four Winds: pungs of all but one dragon (or wind) and a pair of
  // the last. The pungs score for themselves above; these are the bonus for the whole set.
  const dragonPungs = groups.filter((g) => g.kind === "pung" && isDragonIndex(g.index)).length;
  const windPungs = groups.filter((g) => g.kind === "pung" && isWindIndex(g.index)).length;
  if (dragonPungs === 2 && isDragonIndex(pair)) entries.push(entry("Small Three Dragons"));
  if (windPungs === 3 && isWindIndex(pair)) entries.push(entry("Small Four Winds"));

  const total = entries.reduce((sum, e) => sum + e.fan, 0);
  return { totalFan: Math.min(total, LIMIT_FAN), patterns: entries.map((e) => e.name) };
}

/* ---------- Public API ---------- */

const noScore = (): ScoringResult => ({ totalFan: 0, patterns: [] });

/**
 * Scores a winning Hong Kong Old Style hand.
 *
 * - `hand`: the concealed tiles, normally WITHOUT the winning tile (13 minus 3 per open
 *   meld). If you pass them with the winning tile already included (a count of 2 mod 3),
 *   it is not added twice.
 * - `melds`: open melds and kongs; a kong scores as a pung.
 * - `winningTile`: the tile that completed the hand.
 *
 * Every way of reading the hand is scored and the best one wins, so 111222333 counts as
 * three pungs or three chows, whichever is worth more. Fan from patterns is cumulative up to
 * LIMIT_FAN. An invalid hand scores zero with no patterns; a valid hand with no pattern also
 * scores zero (the minimum-fan check belongs to the caller).
 */
export function calculateFan(
  hand: Tile[],
  melds: Meld[],
  winningTile: Tile,
  seatWind: WindName,
  prevalentWind: WindName,
): ScoringResult {
  const openGroups: Group[] = [];
  for (const meld of melds) {
    const group = meldToGroup(meld);
    if (group === null) return noScore();
    openGroups.push(group);
  }
  if (openGroups.length > 4) return noScore();

  const concealed = hand.length % 3 === 2 ? hand : [...hand, winningTile];
  if (concealed.length !== 3 * (4 - openGroups.length) + 2) return noScore();

  const counts = new Array<number>(FACE_COUNT).fill(0);
  for (const tile of concealed) {
    const index = faceIndex(tile.face);
    if (index === null) return noScore();
    counts[index]++;
    if (counts[index] > 4) return noScore();
  }

  // Thirteen Orphans is not four melds and a pair, so it is checked before the usual reading.
  if (openGroups.length === 0 && isThirteenOrphans(counts)) {
    const orphans = entry("Thirteen Orphans");
    return { totalFan: orphans.fan, patterns: [orphans.name] };
  }

  const seatIndex = WIND_BASE + WIND_ORDER.indexOf(seatWind);
  const prevalentIndex = WIND_BASE + WIND_ORDER.indexOf(prevalentWind);

  let best: ScoringResult | null = null;
  for (const { pair, groups } of readings(counts)) {
    const result = scoreReading(pair, [...openGroups, ...groups], seatIndex, prevalentIndex);
    if (best === null || result.totalFan > best.totalFan) best = result;
  }

  return best ?? noScore();
}

/* ---------- Payments and standings ---------- */

/**
 * The payout table: a hand is worth 2 to the power of its fan, so every extra fan doubles it.
 *
 *   fan   0  1  2  3  4   5   6   7    8+
 *   pts   1  2  4  8  16  32  64  128  256
 *
 * Hands above `PAYOUT_FAN_CAP` fan pay the same as the cap (a "limit" payout), so one monster
 * hand cannot wipe a table out. The 3 fan minimum to win means the smallest real payout is 8.
 */
export const PAYOUT_FAN_CAP = 8;

/** A self-draw costs each payer this many points more than the table says. */
export const SELF_DRAW_BONUS = 1;

/** Points one payer owes for a hand worth `fan` fan. */
export const fanToPoints = (fan: number): number =>
  2 ** Math.min(Math.max(Math.floor(fan), 0), PAYOUT_FAN_CAP);

/** A hand worth this many fan pays the cap: the table's "limit" payout. */
export const isLimitFan = (fan: number): boolean => fan >= PAYOUT_FAN_CAP;

/** The base payout for a scored hand; an unscored one (no result) is the 0 fan base of 1. */
export function basePoints(result?: ScoringResult): number {
  return fanToPoints(result?.totalFan ?? 0);
}

/** The patterns of a result with what each is worth, e.g. ["All in Triplets (3)", "Red Dragon (1)"]. */
export function patternLabels(result: ScoringResult): string[] {
  return result.patterns.map((name) => {
    const fan = (PATTERN_FAN as Record<string, number | undefined>)[name];
    return fan === undefined ? name : `${name} (${fan})`;
  });
}

/** How a hand was won, for `settleWin`. */
export interface WinSettlement {
  readonly winners: readonly SeatIndex[];
  /** Zimo: every other seat pays. */
  readonly selfDrawn: boolean;
  /** Ron: the seat that discarded the tile (or added the kong that was robbed) pays alone. */
  readonly chucker?: SeatIndex;
  readonly result?: ScoringResult;
}

/**
 * Who pays whom for a win.
 * - Self-drawn: each of the three opponents pays the winner the base plus the self-draw bonus.
 * - Won on a discard: the discarder alone pays the winner the base.
 * The base comes from the hand's fan through the payout table (`basePoints`).
 * Returns nothing for an impossible win (no winner, or a discard win with no discarder).
 */
export function settleWin(playerCount: number, win: WinSettlement): Payment[] {
  const base = basePoints(win.result);
  const payments: Payment[] = [];

  for (const winner of win.winners) {
    if (win.selfDrawn) {
      for (let seat = 0; seat < playerCount; seat++) {
        if (seat === winner) continue;
        payments.push({ from: seat as SeatIndex, to: winner, amount: base + SELF_DRAW_BONUS });
      }
    } else if (win.chucker !== undefined && win.chucker !== winner) {
      payments.push({ from: win.chucker, to: winner, amount: base });
    }
  }
  return payments;
}

/** The scores after the payments, as a new array. */
export function applyPayments(scores: Scores, payments: readonly Payment[]): Scores {
  const next: [number, number, number, number] = [scores[0], scores[1], scores[2], scores[3]];
  for (const { from, to, amount } of payments) {
    next[from] -= amount;
    next[to] += amount;
  }
  return next;
}

/**
 * Everyone's place in the match so far, best first. Seats on the same score share a rank and
 * stay in seat order, so 10, 0, 0, -10 is ranked 1, 2, 2, 4.
 */
export function matchStandings(state: GameState): Standing[] {
  const ordered = state.players
    .map((player) => ({ player, score: state.round.scores[player.seat] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.player.seat - b.player.seat);

  const standings: Standing[] = [];
  ordered.forEach(({ player, score }, i) => {
    const tiedWith = standings[i - 1];
    standings.push({
      // A tie takes the rank of the first seat on that score.
      rank: tiedWith !== undefined && tiedWith.score === score ? tiedWith.rank : i + 1,
      seat: player.seat,
      playerId: player.id,
      ...(player.name !== undefined ? { name: player.name } : {}),
      score,
    });
  });
  return standings;
}
