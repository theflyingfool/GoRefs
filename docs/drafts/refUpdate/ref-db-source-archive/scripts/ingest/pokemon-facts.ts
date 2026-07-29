// Small hand-maintained facts PokeAPI doesn't cleanly expose as a flag.

// Ultra Beasts aren't tagged by any PokeAPI boolean — this is the complete,
// stable list (Gen 7 only; nothing since has been classified as one).
export const ULTRA_BEAST_NAMES = new Set([
  "nihilego",
  "buzzwole",
  "pheromosa",
  "xurkitree",
  "celesteela",
  "kartana",
  "guzzlord",
  "poipole",
  "naganadel",
  "stakataka",
  "blacephalon",
]);

// Generation-by-dex-number is simpler and more reliable to hardcode than
// parsing PokeAPI's roman-numeral generation name.
const GENERATION_MAX_DEX = [
  [151, 1],
  [251, 2],
  [386, 3],
  [493, 4],
  [649, 5],
  [721, 6],
  [809, 7],
  [905, 8],
  [1025, 9],
] as const;

export function generationForDex(dexNumber: number): number {
  for (const [maxDex, gen] of GENERATION_MAX_DEX) {
    if (dexNumber <= maxDex) return gen;
  }
  return GENERATION_MAX_DEX[GENERATION_MAX_DEX.length - 1][1];
}
