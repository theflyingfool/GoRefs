import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInstanceAchievementField } from "../src/db/cascades";

function instance(overrides: Partial<{ shiny: boolean; lucky: boolean; shadow: boolean; dynamax: boolean; ivPercent: number | null }> = {}) {
  return { shiny: false, lucky: false, shadow: false, dynamax: false, ivPercent: null, ...overrides };
}

test("plain catch with no flags resolves to caught", () => {
  assert.equal(resolveInstanceAchievementField(instance()), "caught");
});

test("shiny (no other flags) resolves to shiny", () => {
  assert.equal(resolveInstanceAchievementField(instance({ shiny: true })), "shiny");
});

test("100% IV (no shiny) resolves to fourStar", () => {
  assert.equal(resolveInstanceAchievementField(instance({ ivPercent: 100 })), "fourStar");
});

test("shiny + 100% IV resolves to shundo", () => {
  assert.equal(resolveInstanceAchievementField(instance({ shiny: true, ivPercent: 100 })), "shundo");
});

test("99% IV (not exactly 100) does not resolve to fourStar", () => {
  assert.equal(resolveInstanceAchievementField(instance({ ivPercent: 99 })), "caught");
});

test("lucky resolves to lucky-group fields", () => {
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true })), "lucky");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, shiny: true })), "luckyShiny");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, ivPercent: 100 })), "luckyFourStar");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, shiny: true, ivPercent: 100 })), "luckyShundo");
});

test("shadow resolves to shadow-group fields", () => {
  assert.equal(resolveInstanceAchievementField(instance({ shadow: true })), "shadow");
  assert.equal(resolveInstanceAchievementField(instance({ shadow: true, shiny: true })), "shadowShiny");
  assert.equal(resolveInstanceAchievementField(instance({ shadow: true, ivPercent: 100 })), "shadowFourStar");
  assert.equal(resolveInstanceAchievementField(instance({ shadow: true, shiny: true, ivPercent: 100 })), "shadowShundo");
});

test("dynamax resolves to dynamax-group fields", () => {
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true })), "dynamax");
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true, shiny: true })), "dynamaxShiny");
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true, ivPercent: 100 })), "dynamaxFourStar");
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true, shiny: true, ivPercent: 100 })), "dynamaxShundo");
});

test("lucky + dynamax resolves to lucky-dynamax-group fields", () => {
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, dynamax: true })), "luckyDynamax");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, dynamax: true, shiny: true })), "luckyDynamaxShiny");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, dynamax: true, ivPercent: 100 })), "luckyDynamaxFourStar");
  assert.equal(
    resolveInstanceAchievementField(instance({ lucky: true, dynamax: true, shiny: true, ivPercent: 100 })),
    "luckyDynamaxShundo",
  );
});

test("dynamax takes priority over shadow when both are true", () => {
  // Not a realistic combination in practice, but the function must resolve
  // to exactly one field rather than throwing — dynamax is checked first.
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true, shadow: true })), "dynamax");
});
