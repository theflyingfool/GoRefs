// Extracted out of sqlite-repository.ts so it can be exercised directly in
// tests against a createInMemoryRepository-backed state/repo pair.
// sqlite-repository.ts itself can't be imported from a plain Node test: it
// transitively pulls in src/db/sqlite-client.ts's browser-only jeep-sqlite
// loader, which throws at import time outside a DOM environment. This file
// deliberately imports nothing from sqlite-client.ts (or anything else that
// touches Capacitor/jeep-sqlite) so it stays test-importable in isolation.
import type { PersonalState } from "./in-memory-store";
import type { Repository } from "./repository";
import { resolveInstanceAchievementField } from "../db/cascades";

// App-settings marker key gating the one-time Dex-achievement backfill.
// Devices that logged catches before Task 3's live-catch cascade wiring have
// pokemon_instance rows whose corresponding form_personal achievement flag
// was never set, leaving the Dex grid showing them as not-caught.
export const DEX_ACHIEVEMENT_BACKFILL_KEY = "dexAchievementBackfillV9Complete";

// Core backfill logic: gated by the app_settings marker above so it only
// ever does real work once per device; a fresh install has zero
// pokemon_instance rows so this is a no-op there but still marks the key
// complete. Returns true if the backfill ran, false if it was already
// marked complete and short-circuited.
export function applyDexAchievementBackfillIfNeeded(
  state: PersonalState,
  repo: Pick<Repository, "setFormPersonalField" | "setAppSetting">,
): boolean {
  if (state.appSettings[DEX_ACHIEVEMENT_BACKFILL_KEY] === "1") return false;
  for (const instance of state.pokemonInstances) {
    repo.setFormPersonalField(instance.formSlug, resolveInstanceAchievementField(instance), true);
  }
  repo.setAppSetting(DEX_ACHIEVEMENT_BACKFILL_KEY, "1");
  return true;
}
