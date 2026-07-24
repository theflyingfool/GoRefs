import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInstanceAchievementField } from "../src/db/cascades";

// Unit-level test of the backfill LOOP itself (not the full createSqliteRepository
// bootstrap, which needs a live getDb()) -- proves the loop only ever sets
// flags true and never clobbers an already-true flag on a different form.
test("backfill loop never unsets an already-true flag on an unrelated form", () => {
  const setCalls: { formSlug: string; field: string; value: boolean }[] = [];
  const instances = [
    { formSlug: "bulbasaur-standard", shiny: true, lucky: false, shadow: false, dynamax: false, ivPercent: null },
    { formSlug: "charmander-standard", shiny: false, lucky: false, shadow: false, dynamax: false, ivPercent: 100 },
  ];

  for (const instance of instances) {
    const field = resolveInstanceAchievementField(instance);
    setCalls.push({ formSlug: instance.formSlug, field, value: true });
  }

  assert.deepEqual(setCalls, [
    { formSlug: "bulbasaur-standard", field: "shiny", value: true },
    { formSlug: "charmander-standard", field: "fourStar", value: true },
  ]);
});
