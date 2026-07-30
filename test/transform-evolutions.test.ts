import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSpeciesEvolutions } from "../scripts/ingest/transform/evolutions";
import type { Species } from "../src/db/types";
import { pokedexEntry, pokedexFrom } from "./transform-fixtures";

function species(slug: string, dexNumber: number): Species {
  return { slug, dexNumber, name: slug, familySlug: slug, gen: 1, rarity: "standard", regionSlug: "kanto", hasMale: true, hasFemale: true, canMegaEvolve: false, canGigantamax: false };
}

test("evolution edges are matched by id and collected from region forms too", () => {
  const pokedex = pokedexFrom([
    // Gloom's edge references formId VILEPLUME_NORMAL while the real entry's
    // formId is VILEPLUME — matching on `id` is what makes this resolve.
    pokedexEntry({ id: "GLOOM", dexNr: 44, evolutions: [{ id: "VILEPLUME", formId: "VILEPLUME_NORMAL", candies: 100 }] }),
    pokedexEntry({ id: "VILEPLUME", dexNr: 45 }),
    pokedexEntry({
      id: "ZIGZAGOON",
      dexNr: 263,
      evolutions: [{ id: "LINOONE", candies: 50 }],
      regionForms: { ZIGZAGOON_GALARIAN: pokedexEntry({ id: "ZIGZAGOON", formId: "ZIGZAGOON_GALARIAN", dexNr: 263, evolutions: [{ id: "OBSTAGOON", candies: 50 }] }) },
    }),
    pokedexEntry({ id: "LINOONE", dexNr: 264 }),
    pokedexEntry({ id: "OBSTAGOON", dexNr: 862 }),
  ]);
  const all = [species("gloom", 44), species("vileplume", 45), species("zigzagoon", 263), species("linoone", 264), species("obstagoon", 862)];

  const evolutions = buildSpeciesEvolutions(pokedex, all);

  assert.deepEqual(evolutions, [
    { fromSpeciesSlug: "gloom", toSpeciesSlug: "vileplume", candyRequired: 100, itemRequired: null },
    { fromSpeciesSlug: "zigzagoon", toSpeciesSlug: "linoone", candyRequired: 50, itemRequired: null },
    { fromSpeciesSlug: "zigzagoon", toSpeciesSlug: "obstagoon", candyRequired: 50, itemRequired: null },
  ]);
});

test("an edge declared identically on the base entry and a region form collapses to one row", () => {
  const pokedex = pokedexFrom([
    pokedexEntry({
      id: "RATTATA",
      dexNr: 19,
      evolutions: [{ id: "RATICATE", candies: 25 }],
      regionForms: { RATTATA_ALOLA: pokedexEntry({ id: "RATTATA", formId: "RATTATA_ALOLA", dexNr: 19, evolutions: [{ id: "RATICATE", candies: 25 }] }) },
    }),
    pokedexEntry({ id: "RATICATE", dexNr: 20 }),
  ]);

  const evolutions = buildSpeciesEvolutions(pokedex, [species("rattata", 19), species("raticate", 20)]);

  assert.equal(evolutions.length, 1);
});

test("a missing item is filled in from the more complete record without a warning", () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    const pokedex = pokedexFrom([
      pokedexEntry({
        id: "EEVEE",
        dexNr: 133,
        evolutions: [{ id: "SYLVEON", candies: 25 }],
        regionForms: { EEVEE_X: pokedexEntry({ id: "EEVEE", formId: "EEVEE_X", dexNr: 133, evolutions: [{ id: "SYLVEON", candies: 25, item: { id: "ITEM_LURE" } }] }) },
      }),
      pokedexEntry({ id: "SYLVEON", dexNr: 700 }),
    ]);

    const evolutions = buildSpeciesEvolutions(pokedex, [species("eevee", 133), species("sylveon", 700)]);

    assert.deepEqual(evolutions, [{ fromSpeciesSlug: "eevee", toSpeciesSlug: "sylveon", candyRequired: 25, itemRequired: "ITEM_LURE" }]);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = original;
  }
});

test("a genuinely conflicting candy cost keeps the first value and warns", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  try {
    const pokedex = pokedexFrom([
      pokedexEntry({
        id: "SINISTEA",
        dexNr: 854,
        evolutions: [{ id: "POLTEAGEIST", candies: 50 }],
        regionForms: { SINISTEA_ANTIQUE: pokedexEntry({ id: "SINISTEA", formId: "SINISTEA_ANTIQUE", dexNr: 854, evolutions: [{ id: "POLTEAGEIST", candies: 400 }] }) },
      }),
      pokedexEntry({ id: "POLTEAGEIST", dexNr: 855 }),
    ]);

    const evolutions = buildSpeciesEvolutions(pokedex, [species("sinistea", 854), species("polteageist", 855)]);

    assert.equal(evolutions[0].candyRequired, 50);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /species_evolution conflict sinistea -> polteageist/);
  } finally {
    console.warn = original;
  }
});

test("edges pointing at a species that isn't in the candidate set are skipped", () => {
  const pokedex = pokedexFrom([
    pokedexEntry({ id: "STANTLER", dexNr: 234, evolutions: [{ id: "WYRDEER", candies: 200 }] }),
    pokedexEntry({ id: "WYRDEER", dexNr: 899 }),
  ]);

  assert.deepEqual(buildSpeciesEvolutions(pokedex, [species("stantler", 234)]), []);
});
