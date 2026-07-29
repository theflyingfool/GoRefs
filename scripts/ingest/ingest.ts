// The real ingestion pipeline — replaces the old fetch-reference-data.ts +
// build-reference.ts + check-slug-stability.ts + csv-authoring.ts's
// npm-script surface with a single orchestrator. Consumes ONLY GAME_MASTER
// (alexelgt/game_masters), pokemon-go-api.github.io's pokedex/types/mega/
// raidboss files, and the pokemongo-shiny community sheet — no pogoapi.net
// live fetch (that source is unmaintained; the one thing it still supplies,
// medal display names, comes from the committed vendor/pogoapi-snapshot
// instead — see sources/pogoapi-badges.ts).
//
// Usage:
//   tsx scripts/ingest/ingest.ts                 # full run: fetch, build,
//                                                 # slug-check, sprites, manifest
//   tsx scripts/ingest/ingest.ts --skip-sprites   # skip the sprite fetch/build step
//   tsx scripts/ingest/ingest.ts --skip-sqlite    # reserved for a later task, no-op today
//   tsx scripts/ingest/ingest.ts --check          # fetch + write manifest + diff against
//                                                 # the last committed manifest only;
//                                                 # exits non-zero if upstream changed

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CACHE_V2_ROOT, fetchToCache } from "./http-cache";
import { GAME_MASTER_CACHE_PATH, GAME_MASTER_URL, createGameMasterIndex } from "./sources/game-master";
import { PGAPI_FILES, createPokedexSource, type PokedexEntry } from "./sources/pokemon-go-api";
import { SHINY_SHEET_CACHE_PATH, SHINY_SHEET_URL, createShinySheetSource, type ShinySheetRecord } from "./sources/shiny-sheet";
import { loadVendorBadgeDisplayNames } from "./sources/pogoapi-badges";

import { buildSpecies, GEN_TO_REGION } from "./transform/species";
import { buildFormMoves, buildMoves, buildTypeEffectivenessAndWeather } from "./transform/moves";
import { buildSpeciesEvolutions } from "./transform/evolutions";
import { buildPlayerProgression } from "./transform/player-progression";
import { buildPvp } from "./transform/pvp";

import { writeReferenceJson } from "./write/reference-json";
import { writeSpriteManifest } from "./write/sprite-manifest";
import { writeManifest, loadCommittedManifest, diffManifests, MANIFEST_REPO_RELATIVE_PATH } from "./write/manifest";

import { fetchSprites } from "./fetch-sprites";
import { buildSprites } from "./build-sprites";
import { slugsOf, findVanishedSlugProblems } from "./slug-stability";

import type { Form } from "../../src/db/types";
import type { ReferenceData } from "../../src/db/reference-data";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const REFERENCE_JSON_REPO_RELATIVE_PATH = "src/data/reference.json";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- Flags -----------------------------------------------------------------

interface Flags {
  skipSprites: boolean;
  skipSqlite: boolean;
  check: boolean;
}

function parseFlags(argv: string[]): Flags {
  return {
    skipSprites: argv.includes("--skip-sprites"),
    skipSqlite: argv.includes("--skip-sqlite"),
    check: argv.includes("--check"),
  };
}

// --- Fetch -------------------------------------------------------------

async function fetchAll(): Promise<void> {
  console.log("Fetching GAME_MASTER...");
  await fetchToCache(GAME_MASTER_URL, resolve(CACHE_V2_ROOT, GAME_MASTER_CACHE_PATH));

  console.log("Fetching pokemon-go-api files...");
  for (const [relPath, url] of Object.entries(PGAPI_FILES)) {
    await fetchToCache(url, resolve(CACHE_V2_ROOT, relPath));
    console.log(`  ${relPath}`);
  }

  console.log("Fetching shiny sheet...");
  await fetchToCache(SHINY_SHEET_URL, resolve(CACHE_V2_ROOT, SHINY_SHEET_CACHE_PATH));
}

// --- Build -------------------------------------------------------------

function loadJson<T>(cacheRelativePath: string): T {
  return JSON.parse(readFileSync(resolve(CACHE_V2_ROOT, cacheRelativePath), "utf-8")) as T;
}

async function build(): Promise<ReferenceData> {
  console.log("Loading cached data...");
  const gameMaster = createGameMasterIndex(loadJson<unknown[]>(GAME_MASTER_CACHE_PATH));
  const pokedex = createPokedexSource(loadJson<PokedexEntry[]>("pgapi/pokedex.json"));
  const shinySheet = createShinySheetSource(loadJson<ShinySheetRecord[]>(SHINY_SHEET_CACHE_PATH));

  console.log("Building species/forms/formTypes/megaVariants...");
  const speciesResult = buildSpecies({ pokedex, gameMaster, shinySheet });

  console.log("Building moves, evolutions, player progression, PvP...");
  const { moves, slugByMovementId } = buildMoves(gameMaster, pokedex);
  const formMoves = buildFormMoves(gameMaster, pokedex, speciesResult.forms, slugByMovementId);
  const speciesEvolutions = buildSpeciesEvolutions(pokedex, speciesResult.species);
  const { typeEffectiveness, weatherBoosts } = buildTypeEffectivenessAndWeather(gameMaster);
  const vendorBadges = loadVendorBadgeDisplayNames();
  const progression = buildPlayerProgression(gameMaster, vendorBadges);
  const pvp = buildPvp(gameMaster);

  // Types referenced anywhere (form typing, moves, type effectiveness,
  // weather boosts) — not just formTypes — or a Tier-1 FK would dangle.
  const allTypeSlugs = new Set([
    ...speciesResult.formTypes.map((ft) => ft.typeSlug),
    ...moves.map((m) => m.typeSlug),
    ...typeEffectiveness.flatMap((te) => [te.attackingTypeSlug, te.defendingTypeSlug]),
    ...weatherBoosts.map((wb) => wb.typeSlug),
  ]);

  // FormWithShinyDebut's extra shinyReleasedAt field is dropped here — the
  // schema doesn't have a column for it yet (see transform/species.ts's
  // header comment: a later schema task adds it and stops dropping it).
  const forms: Form[] = speciesResult.forms.map((f) => ({
    slug: f.slug,
    speciesSlug: f.speciesSlug,
    formName: f.formName,
    costumeName: f.costumeName,
    gender: f.gender,
    evolves: f.evolves,
    shinyAvailable: f.shinyAvailable,
    shadowAvailable: f.shadowAvailable,
    dynamaxAvailable: f.dynamaxAvailable,
    regionalExclusive: f.regionalExclusive,
    imageRef: f.imageRef,
  }));

  const referenceData: ReferenceData = {
    regions: [...new Set(Object.values(GEN_TO_REGION))].map((slug) => ({ slug, name: capitalize(slug) })),
    types: [...allTypeSlugs].map((slug) => ({ slug, name: capitalize(slug) })),
    backgrounds: [
      { slug: "spring-2024", name: "Spring 2024" },
      { slug: "anniversary-2016", name: "8th Anniversary" },
    ],
    species: speciesResult.species,
    forms,
    formTypes: speciesResult.formTypes,
    megaVariants: speciesResult.megaVariants,
    moves,
    formMoves,
    speciesEvolutions,
    typeEffectiveness,
    weatherBoosts,
    ...progression,
    ...pvp,
    // Raid bosses and Community Days are dropped from ingestion entirely —
    // no source/transform module builds them any more (owner decision, see
    // .superpowers/sdd/task-3-report.md).
    raidBosses: [],
    raidBossWeatherBoosts: [],
    communityDays: [],
    communityDayBonuses: [],
    communityDaySpecies: [],
    communityDayEventMoves: [],
  };

  const spriteManifestPath = writeSpriteManifest(speciesResult.spriteManifest);
  const writeResult = writeReferenceJson(referenceData);

  console.log(
    `Wrote ${referenceData.species.length} species, ${referenceData.forms.length} forms ` +
      `(${speciesResult.gigantamaxSpeciesCount} with Gigantamax, ${speciesResult.duplicateFormsDropped} duplicate slug(s) dropped), ` +
      `${referenceData.megaVariants.length} mega variants.`,
  );
  console.log(
    `Tier 1: ${referenceData.moves.length} moves, ${referenceData.formMoves.length} form-move links, ` +
      `${referenceData.speciesEvolutions.length} evolutions, ${referenceData.typeEffectiveness.length} type-effectiveness rows, ` +
      `${referenceData.weatherBoosts.length} weather boosts.`,
  );
  console.log(
    `Player progression: ${referenceData.playerLevels.length} levels, ${referenceData.playerLevelRewards.length} rewards, ` +
      `${referenceData.medals.length} medals, ${referenceData.medalTiers.length} medal tiers, ${referenceData.friendshipLevels.length} friendship levels.`,
  );
  console.log(`PvP: ${referenceData.pvpRankRewards.length} rank rewards, ${referenceData.pvpRankRequirements.length} rank requirements.`);
  console.log(`Gaps: ${writeResult.staticGapsCount} stateless + ${writeResult.comparativeGapsCount} comparative -> ${writeResult.gapsOutPath}`);
  console.log(`Sprite manifest: ${Object.keys(speciesResult.spriteManifest).length} slugs -> ${spriteManifestPath}`);
  console.log(`Reference data version: ${writeResult.referenceDataVersion}`);
  console.log(`-> ${writeResult.outPath}`);

  return referenceData;
}

// --- Slug-stability check ------------------------------------------------
//
// Inline port of the old check-slug-stability.ts: fails loudly if a
// species/form/megaVariant/medal slug the last *committed* reference.json
// had has vanished in this run's candidate, without either a
// src/db/slug-renames.ts entry (species/form only) or being one of the
// handful of "no rename mechanism, report every time" categories.
//
// Medal slugs are covered here too (added per Task 3's review): they now
// depend on a subsequence-alignment join between GAME_MASTER's badgeSettings
// and the vendored badges.json snapshot (sources/pogoapi-badges.ts). If that
// alignment ever silently degrades (e.g. a future GAME_MASTER fetch
// reorders/drops a vendored badge), medal slugs could drift —
// medal_progress_personal.medal_slug is a live FK
// (src/db/migrations/0004_empty_vapor.sql:144) that reference-sync.ts's
// quarantineOrphans does NOT cover, so a stale slug there rolls back the
// entire sync transaction at COMMIT for any user with medal progress. No
// other automated check catches this today.

function loadCommittedReferenceData(): ReferenceData | null {
  try {
    const content = execFileSync("git", ["show", `HEAD:${REFERENCE_JSON_REPO_RELATIVE_PATH}`], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(content) as ReferenceData;
  } catch {
    // No committed version yet (e.g. brand-new repo) — nothing to diff against.
    return null;
  }
}

async function checkSlugStability(referenceData: ReferenceData): Promise<void> {
  const committed = loadCommittedReferenceData();
  if (!committed) {
    console.log("No committed src/data/reference.json to compare against — skipping slug-stability check.");
    return;
  }

  // Dynamic import to avoid a hard dependency on src/db/slug-renames.ts at
  // module-load time for callers that never reach this step (e.g. --check
  // mode never imports this module's build path at all).
  const { SLUG_RENAMES } = await import("../../src/db/slug-renames");

  const before = slugsOf(committed);
  const after = slugsOf(referenceData);
  const renamedSpeciesSlugs = new Set(SLUG_RENAMES.filter((r) => r.table === "species_personal").map((r) => r.from));
  const renamedFormSlugs = new Set(SLUG_RENAMES.filter((r) => r.table === "form_personal").map((r) => r.from));

  const problems = findVanishedSlugProblems(before, after, renamedSpeciesSlugs, renamedFormSlugs);

  if (problems.length > 0) {
    console.error(`Slug stability check failed — ${problems.length} slug(s) vanished unaccounted for:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nIf this is intentional (e.g. a pre-release correction, or a real rename), either:");
    console.error("  - add a src/db/slug-renames.ts entry (species/form slugs), or");
    console.error("  - confirm no real device has this slug's personal data yet, then ignore.");
    throw new Error(`Slug stability check failed: ${problems.length} slug(s) vanished unaccounted for.`);
  }

  console.log(
    `Slug stability check passed (${before.species.size} species, ${before.forms.size} forms, ${before.megaVariants.size} mega variants, ${before.medals.size} medals checked).`,
  );
}

// --- Sprites -------------------------------------------------------------

async function sprites(): Promise<void> {
  await fetchSprites();
  await buildSprites();
}

// --- Manifest --------------------------------------------------------------

async function manifest(): Promise<void> {
  const result = await writeManifest();
  console.log(`Wrote ingestion manifest (GAME_MASTER @ ${result.gameMaster.commitSha.slice(0, 8)}) -> ${CACHE_V2_ROOT}/ingestion-manifest.json`);
}

// --- Check mode --------------------------------------------------------

async function runCheckMode(): Promise<void> {
  console.log("=== check: fetch ===");
  await fetchAll();

  console.log("=== check: manifest ===");
  const freshManifest = await writeManifest();
  const committed = loadCommittedManifest();

  if (!committed) {
    console.log(`No committed manifest at ${MANIFEST_REPO_RELATIVE_PATH} yet — nothing to diff against. Treating as changed.`);
    process.exitCode = 1;
    return;
  }

  const diffs = diffManifests(committed, freshManifest);
  if (diffs.length === 0) {
    console.log("No upstream changes detected since the last committed manifest.");
    return;
  }

  console.log(`${diffs.length} upstream change(s) detected:`);
  for (const d of diffs) console.log(`  - ${d}`);
  process.exitCode = 1;
}

// --- Orchestrator --------------------------------------------------------

interface PipelineStep {
  name: string;
  run: () => Promise<void>;
  skip?: (flags: Flags) => boolean;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.check) {
    await runCheckMode();
    return;
  }

  let referenceData: ReferenceData | undefined;

  const steps: PipelineStep[] = [
    { name: "fetch", run: fetchAll },
    {
      name: "build",
      run: async () => {
        referenceData = await build();
      },
    },
    {
      name: "slug-check",
      run: async () => {
        if (!referenceData) throw new Error("slug-check ran before build");
        await checkSlugStability(referenceData);
      },
    },
    { name: "sprites", run: sprites, skip: (f) => f.skipSprites },
    { name: "manifest", run: manifest },
  ];

  if (flags.skipSqlite) {
    // Reserved for a later task (SQLite output step) — no-op today, just
    // acknowledged so the flag doesn't error as unrecognized.
    console.log("--skip-sqlite: no-op (no SQLite output step exists yet).");
  }

  for (const step of steps) {
    if (step.skip?.(flags)) {
      console.log(`\n=== ${step.name} (skipped) ===`);
      continue;
    }
    console.log(`\n=== ${step.name} ===`);
    await step.run();
  }

  console.log("\nIngest complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
