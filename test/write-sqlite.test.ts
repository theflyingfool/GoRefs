import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { writeReferenceSqlite } from "../scripts/ingest/write/sqlite";
import { CACHE_V2_ROOT } from "../scripts/ingest/http-cache";
import type { ReferenceData } from "../src/db/reference-data";

// Under the gitignored ingestion cache root, not the repo root -- so this
// test can't leave a stray untracked file at the repo root on a hard abort
// (same reasoning as write-manifest.test.ts's scratch-path tests).
const SCRATCH_PATH = resolve(CACHE_V2_ROOT, "reference.test-scratch.sqlite");

function minimalReferenceData(overrides: Partial<ReferenceData> = {}): ReferenceData {
  return {
    regions: [{ slug: "kanto", name: "Kanto" }],
    types: [{ slug: "normal", name: "Normal" }],
    backgrounds: [],
    species: [
      {
        slug: "bulbasaur",
        dexNumber: 1,
        name: "Bulbasaur",
        familySlug: "bulbasaur",
        gen: 1,
        rarity: "standard",
        regionSlug: "kanto",
        hasMale: true,
        hasFemale: true,
        canMegaEvolve: false,
        canGigantamax: false,
      },
    ],
    forms: [
      {
        slug: "bulbasaur-standard",
        speciesSlug: "bulbasaur",
        formName: "Standard",
        costumeName: null,
        gender: "male",
        evolves: true,
        shinyAvailable: true,
        shinyReleasedAt: "2018-03-22",
        shadowAvailable: true,
        dynamaxAvailable: false,
        regionalExclusive: false,
        imageRef: "1",
      },
    ],
    formTypes: [{ formSlug: "bulbasaur-standard", typeSlug: "normal" }],
    megaVariants: [],
    moves: [],
    formMoves: [],
    speciesEvolutions: [],
    typeEffectiveness: [],
    weatherBoosts: [],
    playerLevels: [],
    playerLevelRewards: [],
    medals: [],
    medalTiers: [],
    friendshipLevels: [],
    pvpRankRewards: [],
    pvpRankRequirements: [],
    raidBosses: [],
    raidBossWeatherBoosts: [],
    communityDays: [],
    communityDayBonuses: [],
    communityDaySpecies: [],
    communityDayEventMoves: [],
    ...overrides,
  };
}

test("writeReferenceSqlite produces a valid, queryable SQLite file with the expected reference tables and rows", () => {
  rmSync(SCRATCH_PATH, { force: true });
  try {
    const outPath = writeReferenceSqlite(minimalReferenceData(), SCRATCH_PATH);
    assert.equal(outPath, SCRATCH_PATH);
    assert.ok(existsSync(SCRATCH_PATH));

    const db = new DatabaseSync(SCRATCH_PATH);
    try {
      const region = db.prepare("SELECT slug, name FROM regions").get() as { slug: string; name: string };
      assert.deepEqual({ ...region }, { slug: "kanto", name: "Kanto" });

      const species = db.prepare("SELECT slug, dex_number, has_male FROM species").get() as { slug: string; dex_number: number; has_male: number };
      assert.equal(species.slug, "bulbasaur");
      assert.equal(species.dex_number, 1);
      assert.equal(species.has_male, 1);

      const form = db.prepare("SELECT slug, species_slug, shiny_released_at FROM form").get() as {
        slug: string;
        species_slug: string;
        shiny_released_at: string;
      };
      assert.equal(form.slug, "bulbasaur-standard");
      assert.equal(form.species_slug, "bulbasaur");
      assert.equal(form.shiny_released_at, "2018-03-22");

      const formType = db.prepare("SELECT form_slug, type_slug FROM form_types").get() as { form_slug: string; type_slug: string };
      assert.deepEqual({ ...formType }, { form_slug: "bulbasaur-standard", type_slug: "normal" });

      // Empty reference-table arrays still produce their tables (just with 0 rows) --
      // the schema is created wholesale via REFERENCE_SCHEMA_SQL regardless of which
      // arrays have data, so downstream tools (drizzle-kit studio, an external
      // SQLite browser) always see every reference table.
      const moveCount = (db.prepare("SELECT count(*) as c FROM move").get() as { c: number }).c;
      assert.equal(moveCount, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(SCRATCH_PATH, { force: true });
  }
});

test("writeReferenceSqlite overwrites a pre-existing file at the same path rather than erroring", () => {
  rmSync(SCRATCH_PATH, { force: true });
  try {
    writeReferenceSqlite(minimalReferenceData(), SCRATCH_PATH);
    // Second run with different data -- must not throw "file exists", and the
    // old data must be gone (not appended to). Species/forms/formTypes are
    // cleared too since the default fixture's species references the
    // "kanto" region -- leaving them in while dropping "kanto" from regions
    // would trip the FK constraint this same module enforces.
    const second = minimalReferenceData({
      regions: [{ slug: "johto", name: "Johto" }],
      species: [],
      forms: [],
      formTypes: [],
    });
    writeReferenceSqlite(second, SCRATCH_PATH);

    const db = new DatabaseSync(SCRATCH_PATH);
    try {
      const regions = db.prepare("SELECT slug FROM regions").all() as { slug: string }[];
      assert.deepEqual(
        regions.map((r) => r.slug),
        ["johto"],
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(SCRATCH_PATH, { force: true });
  }
});

test("writeReferenceSqlite rejects a row that violates the reference schema's constraints (foreign_keys enforced)", () => {
  rmSync(SCRATCH_PATH, { force: true });
  try {
    const badData = minimalReferenceData({
      // References a region slug that was never inserted -- should trip the
      // FK constraint (foreign_keys is turned ON before load) rather than
      // silently writing an orphaned row.
      species: [
        {
          slug: "bulbasaur",
          dexNumber: 1,
          name: "Bulbasaur",
          familySlug: "bulbasaur",
          gen: 1,
          rarity: "standard",
          regionSlug: "does-not-exist",
          hasMale: true,
          hasFemale: true,
          canMegaEvolve: false,
          canGigantamax: false,
        },
      ],
    });
    assert.throws(() => writeReferenceSqlite(badData, SCRATCH_PATH));
  } finally {
    rmSync(SCRATCH_PATH, { force: true });
  }
});
