import type {
  DragonName,
  SuitName,
  SuitRank,
  Tile,
  TileFace,
  WindName,
} from "./types.ts";

const SUITS: readonly SuitName[] = ["bamboo", "characters", "dots"];
const RANKS: readonly SuitRank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const WINDS: readonly WindName[] = ["east", "south", "west", "north"];
const DRAGONS: readonly DragonName[] = ["red", "green", "white"];
const COPIES_PER_FACE = 4;

/** Every distinct face in a standard Hong Kong set (no flowers/seasons): 34 faces. */
function standardFaces(): TileFace[] {
  const faces: TileFace[] = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      faces.push({ kind: "suit", suit, rank });
    }
  }
  for (const wind of WINDS) {
    faces.push({ kind: "wind", wind });
  }
  for (const dragon of DRAGONS) {
    faces.push({ kind: "dragon", dragon });
  }

  return faces;
}

/**
 * Creates the un-shuffled 136-tile standard deck.
 * Tiles are ordered face by face, with ids assigned sequentially from 0.
 */
export function createStandardDeck(): Tile[] {
  const deck: Tile[] = [];
  let id = 0;

  for (const face of standardFaces()) {
    for (let copy = 0; copy < COPIES_PER_FACE; copy++) {
      deck.push({ id: id++, face, copy });
    }
  }

  return deck;
}
