// Orchestrator: walks the National Dex (1..MAX_DEX_NUMBER) and caches
// /pokemon-species/{id}, /pokemon/{id}, and /pokemon/{variety} for every
// real variety (regional forms, megas, etc.) PokeAPI knows about. Safe to
// interrupt (Ctrl-C) and re-run — scripts/ingest/pokeapi-client.ts's cache
// means anything already fetched is skipped instantly, no network call.
//
// Run with: npm run ingest:fetch

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPokeApi } from "./pokeapi-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_FILE = resolve(__dirname, "../../INGESTION_PROGRESS.md");

const MAX_DEX_NUMBER = 1025;

interface PokemonSpecies {
  id: number;
  name: string;
  gender_rate: number;
  is_legendary: boolean;
  is_mythical: boolean;
  is_baby: boolean;
  generation: { name: string };
  varieties: { is_default: boolean; pokemon: { name: string; url: string } }[];
}

function writeProgress(current: number, total: number) {
  const pct = ((current / total) * 100).toFixed(1);
  const content = `# PokeAPI Ingestion Progress

This file is updated automatically by \`scripts/ingest/fetch-pokeapi-data.ts\`
after each species. Safe to interrupt the fetch (Ctrl-C) and resume later —
\`scripts/ingest/.cache/\` holds every response already fetched, so re-running
\`npm run ingest:fetch\` skips anything already cached.

## Rate limit assumption

PokeAPI doesn't publish a hard documented requests/minute ceiling (their
stance is aggressive Fastly CDN caching + "don't abuse it," not a stated
number). Assuming a conservative **60 req/min** ceiling and targeting 75%
of that: **45 req/min**, backing off on any HTTP 429. Adjust
\`REQUESTS_PER_MINUTE\` in \`pokeapi-client.ts\` if this turns out to be wrong
in either direction.

## Status

${current >= total ? "**Done.**" : "In progress."}

- Species fetched: ${current} / ${total} (${pct}%)
- Last updated: ${new Date().toISOString()}
- Resume command: \`npm run ingest:fetch\`
`;
  writeFileSync(PROGRESS_FILE, content);
}

async function main() {
  console.log(`Fetching PokeAPI data for dex 1-${MAX_DEX_NUMBER}...`);

  for (let id = 1; id <= MAX_DEX_NUMBER; id++) {
    const species = await fetchPokeApi<PokemonSpecies>("pokemon-species", id);
    await fetchPokeApi("pokemon", id);

    for (const variety of species.varieties) {
      if (variety.is_default) continue;
      await fetchPokeApi("pokemon", variety.pokemon.name);
    }

    if (id % 10 === 0 || id === MAX_DEX_NUMBER) {
      writeProgress(id, MAX_DEX_NUMBER);
      console.log(`  ...${id}/${MAX_DEX_NUMBER}`);
    }
  }

  writeProgress(MAX_DEX_NUMBER, MAX_DEX_NUMBER);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
