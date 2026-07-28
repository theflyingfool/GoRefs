// V2 sourcing spike: walks the cached pokemon-go-api pokedex.json and
// downloads every sprite image it references (base form, costume/form
// variants, region forms, mega evolutions — both regular and shiny) into
// scripts/ingest/.cache-v2/sprites/, named from each URL's own filename
// (e.g. pm25.icon.png, pm25.cCOSTUME_1.s.icon.png).
//
// Replaces the current manual PokeMiners-dump-copy step
// (build-sprite-mapping.ts) with a real fetch — but writes to a separate
// staging directory, not public/sprites/, since this is a parity/validation
// pass, not a cutover.
//
// Requires: npm run ingest:v2:fetch has already populated
// .cache-v2/pgapi/pokedex.json. Run with: npm run ingest:v2:fetch-assets
// (safe to re-run — already-downloaded files are skipped).

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolve } from "node:path";
import { CACHE_V2_ROOT, fetchToCache, withConcurrency } from "./http-cache";

const POKEDEX_PATH = resolve(CACHE_V2_ROOT, "pgapi/pokedex.json");
const SPRITES_DIR = resolve(CACHE_V2_ROOT, "sprites");

interface AssetPair {
  image?: string;
  shinyImage?: string;
}

interface PokedexEntry {
  formId: string;
  assets?: AssetPair;
  assetForms?: AssetPair[];
  regionForms?: Record<string, PokedexEntry>;
  megaEvolutions?: Record<string, { assets?: AssetPair }>;
}

function collectUrls(entry: PokedexEntry, urls: Set<string>): void {
  if (entry.assets?.image) urls.add(entry.assets.image);
  if (entry.assets?.shinyImage) urls.add(entry.assets.shinyImage);

  for (const af of entry.assetForms ?? []) {
    if (af.image) urls.add(af.image);
    if (af.shinyImage) urls.add(af.shinyImage);
  }

  for (const mega of Object.values(entry.megaEvolutions ?? {})) {
    if (mega.assets?.image) urls.add(mega.assets.image);
    if (mega.assets?.shinyImage) urls.add(mega.assets.shinyImage);
  }

  for (const region of Object.values(entry.regionForms ?? {})) {
    collectUrls(region, urls);
  }
}

async function main() {
  if (!existsSync(POKEDEX_PATH)) {
    console.error(`Missing ${POKEDEX_PATH} — run "npm run ingest:v2:fetch" first.`);
    process.exit(1);
  }

  const pokedex: PokedexEntry[] = JSON.parse(readFileSync(POKEDEX_PATH, "utf-8"));
  const urls = new Set<string>();
  for (const entry of pokedex) collectUrls(entry, urls);

  console.log(`Found ${urls.size} unique sprite URLs. Downloading to ${SPRITES_DIR} ...`);

  const urlList = [...urls];
  let done = 0;
  await withConcurrency(urlList, 8, async (url) => {
    // Sprites are large binaries and not part of ingestion-manifest.json's
    // change detection -- keep the old skip-if-already-cached behavior
    // rather than http-cache.ts's new always-fresh default (see
    // FetchToCacheOptions in http-cache.ts).
    await fetchToCache(url, resolve(SPRITES_DIR, basename(url)), { skipIfExists: true });
    done++;
    if (done % 200 === 0) console.log(`  ${done}/${urlList.length}`);
  });

  console.log(`Done. ${urlList.length} sprite(s) in ${SPRITES_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
