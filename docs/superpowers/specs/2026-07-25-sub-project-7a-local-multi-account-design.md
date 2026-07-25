# Sub-project 7a: Local Multi-Account — Design

> Part of the [V2 consolidation roadmap](2026-07-23-v2-consolidation-roadmap.md)'s
> Sub-project 7 ("Full multi-account"). That sub-project was split in two during
> this brainstorm: **7a (this doc)** covers local multi-account support only;
> **7b** (not yet brainstormed) covers cross-device comparison and real merge
> semantics for `pokemon_instance`/`tag` records. 7a is a prerequisite for 7b,
> not a duplicate of it.

## Goal

Real local multi-account support: create/switch/rename/delete profiles, each
with its own fully independent Dex progress, collection, tags, and player
progress. Single on-disk SQLite file (no per-profile DB files) — every
profile's data loads into memory at boot, and switching is an instant
in-memory pointer flip, no reload. `profile.id` becomes a stable UUID now,
since this sub-project's migration already touches every table that
references it — this means Sub-project 7b never has to re-migrate `profile.id`
later. `pokemon_instance.id`/`tag.id` deliberately stay local
`AUTOINCREMENT` integers; giving those tables a stable cross-device identity
is 7b's problem, not touched here.

## Scope decisions (from brainstorm)

- **Delete is in scope**, despite the roadmap's original wording only listing
  "create/switch/rename" — a basic CRUD set felt incomplete without it.
  Blocked on the last remaining profile (there must always be at least one).
- **New profiles always start blank** — no Dex progress, no collection, no
  tags, fresh player progress. A copy/duplicate-existing-profile option was
  considered and explicitly deferred, flagged to revisit after real-world use
  once the owner has a better sense of whether it's actually wanted.
- **`app_settings` becomes per-profile** (theme, grid badge picks, indicator
  selection, etc.) — not shared/global as originally assumed. This raised a
  circularity concern (if "which profile is current" were itself a setting,
  looking it up would require already knowing which profile's settings to
  read) — resolved by tracking "current" as a marker on the `profile` table
  itself, not as a setting.
- **Switching lives on the Trainer page only** for now; a **read-only current
  trainer indicator** is added to the header, visible from every page. A
  quick-switch control elsewhere (header dropdown, etc.) was explicitly
  deferred — to revisit once the app has been used for a while and it's
  clearer whether switching needs to be available everywhere.
- **This closes out the Sub-project 2 carry-forward item**: "live-confirm the
  `profile.id` FK-read fix on a real device" gets folded into this
  sub-project's own migration verification, since `profile.id` is being
  touched directly here anyway.

## Data model changes

### `profile` table

- `id`: `INTEGER AUTOINCREMENT` → `TEXT` (a UUIDv4, generated at profile
  creation — including for the migrated single existing profile).
- New column: `isCurrent INTEGER` (boolean). Invariant: exactly one profile
  row has this `true` at any time. This is the mechanism for tracking the
  active profile without the circularity `app_settings`-based tracking would
  have created.

### Tables needing a PK-widening rebuild

Each of these currently has a primary key that doesn't include `profile_id`
at all — meaning a second profile literally cannot hold its own row for the
same slug/key today. Widen the PK to include `profile_id`, and change every
`profile_id` column from `INTEGER` to `TEXT` to match the new `profile.id`
type:

| Table | Old PK | New PK |
|---|---|---|
| `species_personal` | `species_slug` | `(profile_id, species_slug)` |
| `form_personal` | `form_slug` | `(profile_id, form_slug)` |
| `mega_personal` | `mega_variant_slug` | `(profile_id, mega_variant_slug)` |
| `form_background_personal` | `(form_slug, achievement_field, background_slug)` | adds `profile_id` |
| `app_settings` | `key` | `(profile_id, key)` |

### Tables needing only the `profile_id` column type changed

These already have `profile_id` in a way that correctly scopes them per
profile (either it's already part of a composite PK, or the table's PK is
`profile_id` alone) — only the column type changes from `INTEGER` to `TEXT`,
no PK shape change:

- `pokemon_instance` (PK is its own `id`; `profile_id` is a plain column,
  already correctly one-row-per-specimen — no widening needed, just retype)
- `tag` (same — PK is its own `id`, already unique on
  `(profile_id, name)` via a separate constraint, not the PK itself)
- `player_progress_personal` (PK is `profile_id` alone — already
  one-row-per-profile)
- `player_progress_log` (plain `profile_id` column, not part of any PK — just
  retype)
- `medal_progress_personal` (PK already composite `(medal_slug, profile_id)`
  — just retype)

### `pokemon_instance.id` / `tag.id` — explicitly NOT changed here

Both stay local `AUTOINCREMENT` integers. Sub-project 7a's migration doesn't
touch either table's own primary key at all — giving these tables a stable,
cross-device-meaningful identity (so two different installs' "specimen #12"
can be told apart) is Sub-project 7b's job, once its actual merge-comparison
requirements are known. Converting these now would be real scope creep:
`pokemon_instance` is the busiest, most complex table in the schema
(generated `iv_percent` column, CHECK constraints, FK'd by
`pokemon_instance_tag`/`pokemon_instance_max_move`), and every existing
integer-`id` reference in the UI (Collection's action menu, the
`edit-instance/:id` route, TagsPage) would need updating for no benefit to
this sub-project's actual purpose.

### Migration for existing single-profile installs

One-time migration, same "table rebuild preserving data" pattern already
established in this project (e.g. the IV-column and dynamax/trade
migrations):

1. Generate a real UUID for the existing single profile row.
2. Rewrite that profile's `id` to the new UUID, set `isCurrent = true`.
3. Rebuild each PK-widening table (above) with the new composite PK,
   preserving every existing row's data.
4. Rewrite every `profile_id = 1` reference (now a plain type change) across
   `pokemon_instance`, `tag`, `player_progress_personal`,
   `player_progress_log`, `medal_progress_personal` to the new UUID.

## Repository & in-memory caching architecture

### New `Repository` methods

```ts
listProfiles(): Profile[];
createProfile(username: string, friendCode: string | null): Promise<Profile>;
switchProfile(profileId: string): void; // flips isCurrent, no reload
renameProfile(profileId: string, username: string, friendCode: string | null): Promise<void>;
deleteProfile(profileId: string): Promise<void>; // blocked if it's the only profile
getCurrentProfile(): Profile; // replaces today's getProfile()
```

### Every existing method's signature stays unchanged

This is the load-bearing decision for keeping this sub-project's blast radius
contained: `getSpecimenStateCounts()`, `listTags()`,
`setPokemonInstanceStatus()`, `exportPersonalData()`, and every other
existing `Repository` method keep reading/writing "the current profile"
implicitly — none of them gain a `profileId` parameter. Callers throughout
the UI (every page, every component) never need to know multi-account
exists; only the new profile-management methods above and the Trainer page's
UI need to be aware of it.

### In-memory store shape

`src/data/in-memory-store.ts`'s `state.speciesPersonal`/`state.formPersonal`/
etc. become nested by profile — e.g. `state.profiles[profileId].speciesPersonal[slug]`
— with every local profile's full personal dataset loaded from disk at boot
(cheap: this is a single-device app, realistically a handful of profiles at
most, not a multi-tenant concern). A new `state.currentProfileId` pointer
determines which profile's slice every existing method reads/writes.
`switchProfile()` updates that pointer in memory and persists the
`isCurrent` flip to disk (a small transaction: clear the old profile's flag,
set the new one's) — no re-fetch of any data, no app reload.

## UI

### Trainer page (`TrainerPage.vue`)

The existing username/friend-code edit form now applies to whichever profile
is currently selected in a new profile list rendered above it. Each row
shows username + friend code, with:
- **Switch to** — no-op if already the current profile.
- **Rename** — opens the existing edit form, scoped to that row (same fields
  as today, just parameterized by which profile is being edited rather than
  always "the" profile).
- **Delete** — confirmation prompt, then `deleteProfile()`; hidden or
  disabled when it's the only remaining profile. If the deleted profile was
  the current one, `deleteProfile()` automatically switches to another
  remaining profile (the invariant "exactly one profile is current" must
  never be violated, even transiently) — arbitrarily the next one in
  `listProfiles()`'s order, since there's no meaningful "which one should
  become current" preference to apply here.

A **"+ New profile"** control prompts for a username (friend code optional,
same validation as today's single-profile form) and creates a blank profile
via `createProfile()`.

### Header (`header.ts`)

A small, read-only **current trainer indicator** (the current profile's
username) is added alongside the existing search/title content, present in
every `HeaderMode` variant (`filter`, `jump`, `none`) — so which account is
active is visible from every page, without needing to visit the Trainer
page. This is display-only; it is not a switcher.

## Testing approach

- **Migration test**: seed pre-migration single-profile fixture data (the
  same fixture pattern used by prior migration tests in this project), run
  the migration, assert: a real UUID was generated, `isCurrent = true` on
  that profile, and every `profile_id` reference across all affected tables
  was correctly rewritten to the new UUID (not left as `1` or a stale type).
- **Repository unit tests** for `createProfile`/`switchProfile`/
  `renameProfile`/`deleteProfile` against the in-memory store:
  - Two profiles' data stays isolated — writing to profile A's
    `speciesPersonal` never affects profile B's.
  - `switchProfile` correctly flips which profile's data every existing
    method (e.g. `listTags()`, `getSpecimenStateCounts()`) reads from.
  - `deleteProfile` is blocked (throws or returns an error) when called on
    the only remaining profile.
  - `deleteProfile` on a non-last profile cascades to remove all of that
    profile's `species_personal`/`form_personal`/`mega_personal`/
    `pokemon_instance`/`tag`/`app_settings`/progress rows, and correctly
    leaves every other profile's data untouched.
  - Deleting the *current* profile automatically switches `isCurrent` to
    another remaining profile — the invariant "exactly one profile is
    current" holds immediately after the call, never zero.
- **Manual verification** for the Trainer-page switch/create/rename/delete
  flow and the header indicator, since e2e coverage is currently a known gap
  (Sub-project 6 retired the Playwright suite pending a `tauri-driver`
  rebuild — logged in `docs/roadmap.md`, not yet done).

## Out of scope / deferred (log to `docs/roadmap.md`)

- Copy/duplicate-an-existing-profile option at profile-creation time —
  explicitly deferred by the owner, to revisit after real-world use.
- A quick-switch UI outside the Trainer page (header/nav dropdown or
  similar) — deferred; the header only gets a read-only indicator for now.
- Everything in Sub-project 7b: stable `pokemon_instance`/`tag` identity,
  cross-device comparison UI, real merge semantics for specimen/tag records
  on import. This sub-project only makes local multi-account work; it does
  not touch any cross-device concern.
