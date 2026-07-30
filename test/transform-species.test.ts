import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSpecies, cleanSpeciesDisplayName, createShinyLookup, deriveRarity, gendersFor, gendersForSpecies, formTokenFromFormId, buildComparativeGaps, FAMILY_ROOT_GAP_NOTES } from "../scripts/ingest/transform/species";
import type { ReferenceData } from "../src/db/reference-data";
import { gameMasterFrom, genderSettings, pokedexEntry, pokedexFrom, pokemonSettings, shinySheetFrom } from "./transform-fixtures";

test("shiny availability comes from the sheet's debut date, not from a shiny image existing", () => {
  // Eternatus is the case that motivated the re-sourcing: pokemon-go-api
  // ships an `assets.shinyImage` for it, but the shiny has never been
  // released, and the sheet says so with a row carrying a blank debut.
  const pokedex = pokedexFrom([
    pokedexEntry({
      id: "ETERNATUS",
      dexNr: 890,
      assets: { image: "pm890.icon.png", shinyImage: "pm890.s.icon.png" },
    }),
    pokedexEntry({ id: "BULBASAUR", dexNr: 1, assets: { image: "pm1.icon.png", shinyImage: "pm1.s.icon.png" } }),
  ]);
  const gameMaster = gameMasterFrom([
    genderSettings("SPAWN_V0890_POKEMON_ETERNATUS", "ETERNATUS", { genderlessPercent: 1 }),
    genderSettings("SPAWN_V0001_POKEMON_BULBASAUR", "BULBASAUR", { malePercent: 0.875, femalePercent: 0.125 }),
  ]);
  const shinySheet = shinySheetFrom([
    { family_dex: "890", debut: "", pid: "pm890", group: "Eternatus" },
    { family_dex: "1", debut: "2018-03-25", pid: "pm1", group: "Bulbasaur" },
  ]);

  const { forms } = buildSpecies({ pokedex, gameMaster, shinySheet });

  const eternatus = forms.filter((f) => f.speciesSlug === "eternatus");
  assert.equal(eternatus.length, 1);
  assert.equal(eternatus[0].shinyAvailable, false);
  assert.equal(eternatus[0].shinyReleasedAt, null);

  const bulbasaur = forms.filter((f) => f.speciesSlug === "bulbasaur");
  assert.equal(bulbasaur.every((f) => f.shinyAvailable), true);
  assert.equal(bulbasaur[0].shinyReleasedAt, "2018-03-25");
  // shinyAvailable is derived, never independently set.
  assert.equal(
    forms.every((f) => f.shinyAvailable === (f.shinyReleasedAt !== null)),
    true,
  );
});

test("a species the shiny sheet has no row for at all is not shiny-available", () => {
  const pokedex = pokedexFrom([pokedexEntry({ id: "MISSINGNO", dexNr: 999, assets: { image: "i", shinyImage: "s" } })]);
  const gameMaster = gameMasterFrom([genderSettings("SPAWN_MISSINGNO", "MISSINGNO", { malePercent: 1 })]);

  const { forms } = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });

  assert.equal(forms[0].shinyAvailable, false);
  assert.equal(forms[0].shinyReleasedAt, null);
});

test("shiny lookup: form rows win, unknown forms fall back to the species answer, costume tokens are case-insensitive", () => {
  const lookup = createShinyLookup(
    shinySheetFrom([
      { family_dex: "19", debut: "2019-02-26", pid: "pm19" },
      { family_dex: "19", debut: "2019-06-28", pid: "pm19.fALOLA" },
      { family_dex: "133", debut: "2023-10-07", pid: "pm133.cMAY_2023" },
      // Unown-style: no base row at all, only per-form rows.
      { family_dex: "201", debut: "2020-08-07", pid: "pm201.fUNOWN_A" },
      { family_dex: "201", debut: "2020-07-25", pid: "pm201.fUNOWN_G" },
      { family_dex: "890", debut: "", pid: "pm890" },
    ]),
  );

  assert.deepEqual(lookup.formDebut(["pm19.fALOLA"]), { known: true, debut: "2019-06-28" });
  assert.deepEqual(lookup.formDebut(["pm19.fGALARIAN"]), { known: false, debut: null });
  // A tracked-but-unreleased row is "known" — that's what stops the caller
  // from falling back to the species-level answer.
  assert.deepEqual(lookup.formDebut(["pm890"]), { known: true, debut: null });
  assert.equal(lookup.formDebut(["pm133.cMay_2023"]).debut, "2023-10-07");
  assert.equal(lookup.speciesDebut(19), "2019-02-26");
  assert.equal(lookup.speciesDebut(890), null);
  // No base row: earliest across the species' own form rows.
  assert.equal(lookup.speciesDebut(201), "2020-07-25");
  assert.equal(lookup.speciesDebut(404), null);
});

test("shadow availability comes from pokemonSettings' shadow block, per form", () => {
  const pokedex = pokedexFrom([
    pokedexEntry({
      id: "RATTATA",
      dexNr: 19,
      regionForms: { RATTATA_ALOLA: pokedexEntry({ id: "RATTATA", formId: "RATTATA_ALOLA", dexNr: 19, names: { English: "Alolan Rattata" } }) },
    }),
    pokedexEntry({ id: "MEW", dexNr: 151 }),
  ]);
  const gameMaster = gameMasterFrom([
    genderSettings("SPAWN_V0019_POKEMON_RATTATA", "RATTATA", { malePercent: 0.5, femalePercent: 0.5 }),
    genderSettings("SPAWN_V0151_POKEMON_MEW", "MEW", { genderlessPercent: 1 }),
    pokemonSettings({ pokemonId: "RATTATA", form: "RATTATA_NORMAL", shadow: { purificationCandyNeeded: 3 } }),
    pokemonSettings({ pokemonId: "RATTATA", form: "RATTATA_ALOLA" }),
    pokemonSettings({ pokemonId: "MEW" }),
  ]);

  const { forms } = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });

  const standard = forms.filter((f) => f.speciesSlug === "rattata" && f.formName === "Standard");
  assert.equal(standard.length, 2);
  assert.equal(standard.every((f) => f.shadowAvailable), true);
  // The Alolan form has its own pokemonSettings record with no shadow block.
  assert.equal(forms.filter((f) => f.formName === "Alolan").every((f) => f.shadowAvailable === false), true);
  // Mew has no shadow block anywhere — the sanity check from the sourcing spike.
  assert.equal(forms.filter((f) => f.speciesSlug === "mew").every((f) => f.shadowAvailable === false), true);
});

test("gender is the union across a species' genderSettings records", () => {
  // Frillish declares a male-only base record and a separate 100%-female
  // record; the species genuinely has both.
  const gameMaster = gameMasterFrom([
    genderSettings("SPAWN_V0592_POKEMON_FRILLISH", "FRILLISH", { malePercent: 1 }),
    genderSettings("SPAWN_V0592_POKEMON_FRILLISH_FEMALE", "FRILLISH", { femalePercent: 1 }),
    genderSettings("SPAWN_V0592_POKEMON_FRILLISH_NORMAL", "FRILLISH", { malePercent: 1 }),
    genderSettings("SPAWN_V0081_POKEMON_MAGNEMITE", "MAGNEMITE", { genderlessPercent: 1 }),
  ]);

  assert.deepEqual(gendersForSpecies(gameMaster, "FRILLISH"), { hasMale: true, hasFemale: true });
  assert.deepEqual(gendersForSpecies(gameMaster, "MAGNEMITE"), { hasMale: false, hasFemale: false });
  // No record at all keeps the original both-genders fallback.
  assert.deepEqual(gendersForSpecies(gameMaster, "NOT_IN_GAME_MASTER"), { hasMale: true, hasFemale: true });

  assert.deepEqual(gendersFor(true, true), ["male", "female"]);
  assert.deepEqual(gendersFor(false, false), ["unknown"]);
});

test("Nidoran display names swap the gender symbol for the (F)/(M) suffix, and are still two species", () => {
  assert.equal(cleanSpeciesDisplayName("Nidoran♀"), "Nidoran (F)");
  assert.equal(cleanSpeciesDisplayName("Nidoran♂"), "Nidoran (M)");
  assert.equal(cleanSpeciesDisplayName("Bulbasaur"), "Bulbasaur");

  const pokedex = pokedexFrom([
    pokedexEntry({ id: "NIDORAN_FEMALE", formId: "NIDORAN", dexNr: 29, names: { English: "Nidoran♀" } }),
    pokedexEntry({ id: "NIDORAN_MALE", formId: "NIDORAN", dexNr: 32, names: { English: "Nidoran♂" } }),
  ]);
  const gameMaster = gameMasterFrom([
    genderSettings("SPAWN_V0029_POKEMON_NIDORAN", "NIDORAN_FEMALE", { femalePercent: 1 }),
    genderSettings("SPAWN_V0032_POKEMON_NIDORAN", "NIDORAN_MALE", { malePercent: 1 }),
  ]);

  const { species } = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });
  assert.deepEqual(
    species.map((s) => [s.slug, s.name, s.dexNumber, s.familySlug]),
    [
      ["nidoran-female", "Nidoran (F)", 29, "nidoran-female"],
      ["nidoran-male", "Nidoran (M)", 32, "nidoran-male"],
    ],
  );
});

test("baby Pokémon never become the family root, and region-form-only evolution edges still do", () => {
  const pokedex = pokedexFrom([
    pokedexEntry({ id: "PIKACHU", dexNr: 25, evolutions: [{ id: "RAICHU" }] }),
    pokedexEntry({ id: "RAICHU", dexNr: 26 }),
    // Pichu -> Pikachu is real in the source data; the exclusion list is what
    // keeps Pikachu's family rooted at Pikachu.
    pokedexEntry({ id: "PICHU", dexNr: 172, evolutions: [{ id: "PIKACHU" }] }),
    // Only the Galarian regionForm carries the edge into Obstagoon.
    pokedexEntry({
      id: "ZIGZAGOON",
      dexNr: 263,
      evolutions: [{ id: "LINOONE" }],
      regionForms: { ZIGZAGOON_GALARIAN: pokedexEntry({ id: "ZIGZAGOON", formId: "ZIGZAGOON_GALARIAN", dexNr: 263, names: { English: "Galarian Zigzagoon" }, evolutions: [{ id: "OBSTAGOON" }] }) },
    }),
    pokedexEntry({ id: "LINOONE", dexNr: 264 }),
    pokedexEntry({ id: "OBSTAGOON", dexNr: 862 }),
  ]);
  const gameMaster = gameMasterFrom([]);

  const { species } = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });
  const familyOf = (slug: string) => species.find((s) => s.slug === slug)?.familySlug;

  assert.equal(familyOf("pikachu"), "pikachu");
  assert.equal(familyOf("raichu"), "pikachu");
  assert.equal(familyOf("pichu"), "pichu");
  assert.equal(familyOf("obstagoon"), "zigzagoon");
  assert.equal(familyOf("linoone"), "zigzagoon");
});

test("duplicate form slugs are dropped, keeping the base Standard form", () => {
  // Darmanitan-style: the species' base form is also declared as its own
  // named regionForms entry, whose token slugifies back to "standard".
  const pokedex = pokedexFrom([
    pokedexEntry({
      id: "DARMANITAN",
      dexNr: 555,
      primaryType: { type: "POKEMON_TYPE_FIRE" },
      regionForms: {
        DARMANITAN_STANDARD: pokedexEntry({ id: "DARMANITAN", formId: "DARMANITAN_STANDARD", dexNr: 555, names: { English: "Darmanitan" }, primaryType: { type: "POKEMON_TYPE_ICE" } }),
      },
    }),
  ]);
  const gameMaster = gameMasterFrom([genderSettings("SPAWN_DARMANITAN", "DARMANITAN", { malePercent: 0.5, femalePercent: 0.5 })]);

  const result = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });

  assert.equal(result.duplicateFormsDropped, 2);
  assert.equal(new Set(result.forms.map((f) => f.slug)).size, result.forms.length);
  assert.equal(result.forms.filter((f) => f.slug === "darmanitan-standard-male").length, 1);
  assert.equal(result.forms.find((f) => f.slug === "darmanitan-standard-male")?.regionalExclusive, false);
});

test("costume, region and Gigantamax forms get their own shiny answers", () => {
  const pokedex = pokedexFrom([
    pokedexEntry({
      id: "PIKACHU",
      dexNr: 25,
      hasGigantamaxEvolution: true,
      assets: { image: "pm25.icon.png" },
      assetForms: [
        { form: null, costume: "HOLIDAY_2016", isFemale: false, image: "c.png", shinyImage: "c.s.png" },
        { form: null, costume: "NOT_RELEASED_SHINY", isFemale: false, image: "d.png", shinyImage: "d.s.png" },
        { form: "GIGANTAMAX", costume: null, isFemale: false, image: "g.png" },
      ],
    }),
  ]);
  const gameMaster = gameMasterFrom([genderSettings("SPAWN_V0025_POKEMON_PIKACHU", "PIKACHU", { malePercent: 0.5, femalePercent: 0.5 })]);
  const shinySheet = shinySheetFrom([
    { family_dex: "25", debut: "2017-08-09", pid: "pm25" },
    { family_dex: "25", debut: "2016-12-25", pid: "pm25.cHOLIDAY_2016" },
    { family_dex: "25", debut: "2024-10-26", pid: "pm25.fGIGANTAMAX" },
  ]);

  const { forms } = buildSpecies({ pokedex, gameMaster, shinySheet });
  const bySlug = (slug: string) => forms.find((f) => f.slug === slug)!;

  assert.equal(bySlug("pikachu-standard-holiday-2016-male").shinyReleasedAt, "2016-12-25");
  // A costume with a shinyImage but no sheet row is NOT shiny-available —
  // the old `Boolean(af.shinyImage)` rule is exactly what over-reported.
  assert.equal(bySlug("pikachu-standard-not-released-shiny-male").shinyAvailable, false);
  assert.equal(bySlug("pikachu-gigantamax-male").shinyReleasedAt, "2024-10-26");
  assert.equal(bySlug("pikachu-gigantamax-male").dynamaxAvailable, true);
  assert.equal(bySlug("pikachu-standard-male").shinyReleasedAt, "2017-08-09");
});

test("sprite manifest is returned, not mutated into module state", () => {
  const pokedex = pokedexFrom([pokedexEntry({ id: "BULBASAUR", dexNr: 1, assets: { image: "pm1.icon.png" }, megaEvolutions: { BULBASAUR_MEGA: { assets: { image: "mega.png" } } } })]);
  const gameMaster = gameMasterFrom([genderSettings("SPAWN_BULBASAUR", "BULBASAUR", { malePercent: 1 })]);

  const first = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });
  const second = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });

  assert.deepEqual(Object.keys(first.spriteManifest).sort(), ["bulbasaur", "bulbasaur-mega", "bulbasaur-standard-male"]);
  assert.deepEqual(first.spriteManifest, second.spriteManifest);
  assert.deepEqual(first.megaVariants, [{ slug: "bulbasaur-mega", speciesSlug: "bulbasaur", variant: null }]);
});

test("form types are emitted per form from the species' pokedex types", () => {
  const pokedex = pokedexFrom([
    pokedexEntry({ id: "BULBASAUR", dexNr: 1, primaryType: { type: "POKEMON_TYPE_GRASS" }, secondaryType: { type: "POKEMON_TYPE_POISON" } }),
  ]);
  const gameMaster = gameMasterFrom([genderSettings("SPAWN_BULBASAUR", "BULBASAUR", { malePercent: 0.875, femalePercent: 0.125 })]);

  const { forms, formTypes } = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });

  assert.equal(forms.length, 2);
  assert.equal(formTypes.length, 4);
  assert.deepEqual(
    formTypes.filter((ft) => ft.formSlug === "bulbasaur-standard-male").map((ft) => ft.typeSlug),
    ["grass", "poison"],
  );
});

test("comparative gaps still report the known family-root and Gigantamax mismatches", () => {
  assert.equal(formTokenFromFormId("RATTATA_ALOLA", "RATTATA"), "ALOLA");
  assert.equal(formTokenFromFormId("SOMETHING_ELSE", "RATTATA"), "SOMETHING_ELSE");
  assert.equal(deriveRarity("POKEMON_CLASS_MYTHIC"), "mythical");
  assert.equal(deriveRarity(null), "standard");

  const candidate = {
    species: [
      { slug: "hitmontop", dexNumber: 237, name: "Hitmontop", familySlug: "hitmontop", gen: 2, rarity: "standard", regionSlug: "johto", hasMale: true, hasFemale: true, canMegaEvolve: false, canGigantamax: false },
      { slug: "pikachu", dexNumber: 25, name: "Pikachu", familySlug: "pikachu", gen: 1, rarity: "standard", regionSlug: "kanto", hasMale: true, hasFemale: true, canMegaEvolve: false, canGigantamax: false },
    ],
  } as unknown as ReferenceData;

  const gaps = buildComparativeGaps(candidate, FAMILY_ROOT_GAP_NOTES);

  assert.equal(gaps.some((g) => g.kind === "missing-species" && g.speciesSlug === "dex-902"), true);
  assert.equal(gaps.some((g) => g.kind === "gigantamax-mismatch" && g.speciesSlug === "pikachu"), true);
  assert.equal(gaps.some((g) => g.kind === "family-root-mismatch" && g.speciesSlug === "hitmontop"), true);
});
