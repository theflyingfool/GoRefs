// Hand-written personal-table demo overlay — there's still no real personal
// progress data anywhere (confirmed: the source CSVs are blank trackers).
// This just seeds a handful of toggles on real species/forms (now sourced
// from the real ingested src/data/reference.json) so a generated dummy.sqlite
// (scripts/build-dummy-db.ts, for manual DB inspection) has something to look
// at. A fresh real on-device install never sees any of this — sqlite-repository.ts
// doesn't import it (it seeds fresh installs from DEFAULT_APP_SETTINGS in
// db/defaults.ts instead, which is real config, not demo data).

import { emptyFormPersonal } from "../db/defaults";
import type { FormBackgroundPersonal, FormPersonal, MegaPersonal, SpeciesPersonal } from "../db/types";

// Any fixed value works for demo data — real rows get a real
// updatedAt from applyXPersonalField, this is only for dummy.sqlite.
// Epoch milliseconds, matching the INTEGER column this is stored in.
const DEMO_UPDATED_AT = new Date("2024-01-01T00:00:00.000Z").getTime();

// SpeciesPersonal/FormPersonal/MegaPersonal don't carry a profileId field in
// db/types.ts — production code (sqlite-repository.ts) threads profileId as
// a separate parameter instead of embedding it in these row shapes. This
// demo-seed module is the one place that needs the id embedded per-row (so
// build-dummy-db.ts can substitute the real seeded profile id uniformly via
// withDemoProfileId), so it's added here as a local augmentation rather than
// widening the shared types used throughout the real app.
type WithProfileId<T> = T & { profileId: string };

export const speciesPersonal: WithProfileId<SpeciesPersonal>[] = [
  { speciesSlug: "bulbasaur", profileId: "__DEMO_PROFILE_ID__", registered: true, xxl: false, xxs: false, purified: false, updatedAt: DEMO_UPDATED_AT },
  { speciesSlug: "charizard", profileId: "__DEMO_PROFILE_ID__", registered: true, xxl: true, xxs: false, purified: false, updatedAt: DEMO_UPDATED_AT },
  { speciesSlug: "snorlax", profileId: "__DEMO_PROFILE_ID__", registered: true, xxl: true, xxs: false, purified: false, updatedAt: DEMO_UPDATED_AT },
  { speciesSlug: "eevee", profileId: "__DEMO_PROFILE_ID__", registered: true, xxl: false, xxs: true, purified: false, updatedAt: DEMO_UPDATED_AT },
];

export const formPersonal: WithProfileId<FormPersonal>[] = [
  { ...emptyFormPersonal("bulbasaur-standard-male", { caught: true, floor: true, lucky: true, updatedAt: DEMO_UPDATED_AT }), profileId: "__DEMO_PROFILE_ID__" },
  { ...emptyFormPersonal("charizard-standard-male", { caught: true, fourStar: true, shiny: true, updatedAt: DEMO_UPDATED_AT }), profileId: "__DEMO_PROFILE_ID__" },
  { ...emptyFormPersonal("snorlax-standard-male", { caught: true, shundo: true, shiny: true, updatedAt: DEMO_UPDATED_AT }), profileId: "__DEMO_PROFILE_ID__" },
  { ...emptyFormPersonal("eevee-standard-female", { caught: true, lucky: true, updatedAt: DEMO_UPDATED_AT }), profileId: "__DEMO_PROFILE_ID__" },
  { ...emptyFormPersonal("growlithe-standard-male", { caught: true, updatedAt: DEMO_UPDATED_AT }), profileId: "__DEMO_PROFILE_ID__" },
];

export const formBackgroundPersonal: FormBackgroundPersonal[] = [
  { formSlug: "bulbasaur-standard-male", profileId: "__DEMO_PROFILE_ID__", achievementField: "caught", backgroundSlug: "spring-2024", updatedAt: DEMO_UPDATED_AT },
  { formSlug: "bulbasaur-standard-male", profileId: "__DEMO_PROFILE_ID__", achievementField: "lucky", backgroundSlug: "anniversary-2016", updatedAt: DEMO_UPDATED_AT },
];

export const megaPersonal: WithProfileId<MegaPersonal>[] = [
  { megaVariantSlug: "charizard-mega-x", profileId: "__DEMO_PROFILE_ID__", evolved: true, shinyEvolved: false, updatedAt: DEMO_UPDATED_AT },
];
