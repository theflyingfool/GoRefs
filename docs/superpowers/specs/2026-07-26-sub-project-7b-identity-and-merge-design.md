# Sub-project 7b: Stable Identity & Merge-Gap Closure — Design

**Status:** Approved for spec write-up (verbal sign-off through iterative brainstorm — see conversation history). Pending: written-spec review gate.

**Precedes:** Sub-project 7c (compare view), which consumes everything this
spec builds but is specced separately (see
`2026-07-26-sub-project-7c-compare-view-design.md`) since 7c's exact needs
may shift once 7b is actually implemented.

## 1. Problem statement

Sub-project 7a made trainer identity per-profile (not per-device) and gave
`profile.id` a stable, cross-device-meaningful UUID. Two gaps remain before
any real merge/comparison feature is possible:

1. **`pokemon_instance` and `tag` still use local `AUTOINCREMENT` integers**
   as their only identity. Two devices' row #12 are unrelated individuals —
   `importPersonalData` already excludes both tables from merge for exactly
   this reason. Every other personal table merges via last-write-wins on
   `updatedAt`; these two can't participate at all today.
2. **There is no way to export "all trainers on this device," and no
   trainer-identity data in an export at all.** `PersonalDataExport` has no
   username/friendCode/profile-id field, and `SettingsPage.vue` only ever
   calls `exportPersonalData()` for the current profile. A user with two
   local accounts has no way to back up both without remembering to switch
   and export twice.

Closing both gaps is a prerequisite for 7c's compare view and for the
self-sync-across-devices use case, which turned out during brainstorming to
be **the same mechanism** as importing a friend's data — this spec's central
design decision.

## 2. Core architectural decision: one import mechanism, one export mechanism

The app never distinguishes "syncing myself across two devices" from
"merging a friend's data" from "comparing two local profiles" — in every
case it's just two independent trainer collections that need their identity
reconciled the same way. Concretely:

- **One export function**, `exportTrainer(profileId): TrainerExport`,
  called once per trainer being exported. "Export current" and "export all"
  (see §5) are both just this function called over a different set of
  profile ids and wrapped into one bundle file — never two code paths.
- **One import function**, extending the existing `importPersonalData`
  merge logic, run once per trainer found in an imported bundle.
- Reconciling whether an incoming trainer is "the same trainer" as a local
  one uses the same friend-code/name matching flow (§4) regardless of why
  the file was produced.

## 3. Stable identity for `pokemon_instance` and `tag`

### 3.1 `pokemon_instance`

Add a `uuid` column (`text`, unique, `crypto.randomUUID()` at creation) —
**not** a replacement for the existing `id` integer PK. Every existing
route, join, and FK (`pokemon_instance_tag`, `pokemon_instance_max_move`)
keeps using the integer `id` untouched. `uuid` exists solely so a specimen
can be recognized as "the same individual" across devices during merge.

Merge rule once both sides carry a specimen row for the same `uuid`: same
last-write-wins on `updatedAt` as every other personal table. A specimen
whose `uuid` exists only on one side is a plain add — this is what makes
`pokemon_instance` finally mergeable at all, closing gap 1 directly.

Two new columns, both agreed during brainstorming as genuinely part of this
sub-project since the schema is already being touched:

- **`originalTrainerName: text NOT NULL`** — user-facing, freely-typed at
  catch/edit time. Always populated (defaults to the current trainer's own
  name at creation, matching real Pokémon GO's "originally caught by" field
  showing yourself for untraded Pokémon).
- **`originalTrainerId: text NULL`** — a soft link into `referenced_trainer`
  (§4), **not** a foreign key. Deliberately non-FK: a specimen naming
  "Steve" as original trainer may travel to a device that has never heard
  of Steve (e.g. after exporting just one trainer to a third party) — a
  real FK would either block the write or (worse, per 7a's final-review
  precedent) get silently dropped by the write-queue on a constraint
  mismatch and vanish on reload. Resolved by name only when a UUID isn't
  linked yet; resolved/rewritten by UUID once it is (§4.3).

### 3.2 `status` rename + visibility (quick win, same migration)

`status` enum `kept/traded/released/evolved` becomes
`kept/traded/transferred/evolved` — `released` was being used to mean "sent
to the transfer machine," which is confusingly named next to `traded`
(receiving a Pokémon via trade, tracked by the existing `receivedViaTrade`
boolean — unrelated to `status` and unchanged by this rename). This is a
straight enum-value rename, not a new inference — a one-line data migration
(`UPDATE pokemon_instance SET status = 'transferred' WHERE status =
'released'`) plus updating the TS union.

**Deferred, not built now** (logged to roadmap, §8): actually hiding
`traded`/`transferred`/`evolved` specimens from Collection's default view
while keeping them queryable (for future trade-history/transfer-count
stats). This spec only does the free rename; the visibility filtering is
its own feature.

### 3.3 `tag`

Least-effort path, explicitly chosen over a trainer-scoped UUID scheme:
tags stay simple text rows, but the existing
`tag_profile_id_name_unique` constraint is dropped in favor of a single
device-wide `tag_name_unique` — tags become global across all local
profiles rather than per-trainer. `PokemonInstanceTag`'s FK is unaffected
(it already points at `tag.id`, unchanged). On export, all of a device's
tags are bundled (not scoped per trainer); on import, incoming tags are
added if their name doesn't already exist locally, matched case-sensitively
(simplest option — revisit if it proves annoying in practice, per the
owner's explicit "whichever is easier to switch away from" framing).
`profileId` stays on the `tag` row for now (removing it is a bigger,
separate migration not worth bundling here) but is no longer part of any
uniqueness constraint or filtering logic.

**Deferred, not built now**: a tag editor/management UI. Logged to roadmap
alongside the `referenced_trainer` cleanup UI (§8) as one future small
Settings-page feature.

## 4. `referenced_trainer`: the trainer identity registry

### 4.1 Why a separate table, not a flag on `profile`

Rejected: adding a boolean (`hidden`/`tradeOnly`) directly on `profile`.
7a's final-review fixed a real bug (`switchProfile`/`profileBuckets`
aliasing) caused by exactly this class of "should be automatic" reasoning —
a flagged-hidden row on `profile` would still have to satisfy every
existing profile invariant (`listProfiles`/boot-loading filtering it out
everywhere, the "exactly one profile is current" constraint, the
delete-guard's "don't delete the last profile" logic treating it correctly
as not-a-real-profile). A separate table needs none of that: it's a plain
`(uuid, name, friendCode)` registry with no invariants beyond "no duplicate
uuid," so a placeholder entry can never trip a real-profile code path.

### 4.2 Shape and the "complete registry" rule

```sql
CREATE TABLE referenced_trainer (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  friend_code TEXT
);
```

**Every real `profile` row also has a mirrored `referenced_trainer` row**
with the same `uuid`/`name`/`friendCode` — this table is the complete,
single directory of every trainer identity the device has ever known about,
real or placeholder. Kept in sync at exactly three points, all inside
existing atomic operations from 7a:

- `createProfile` — after inserting the new `profile` row, upsert a
  matching `referenced_trainer` row.
- `renameProfile` — after updating `profile.username`/`friendCode`, update
  the matching `referenced_trainer` row's `name`/`friendCode` too.
- `deleteProfile` — the `profile` row is deleted, but its
  `referenced_trainer` row is **not** — it lives on as a placeholder
  (already-agreed behavior: deleting a profile shouldn't erase the fact
  that this trainer identity once existed and might still be referenced by
  `originalTrainerId` on specimens elsewhere).

Rationale for taking on this sync cost (raised directly in review before
adoption): `originalTrainerId` and every reconciliation lookup then resolve
against exactly one table, with no dangling-reference case to handle
separately from "trainer was deleted." The alternative (query `profile` and
`referenced_trainer` separately, everywhere) duplicates that lookup at every
call site instead of once in three well-understood write paths.

Deferred: a Settings-page UI to browse/clean up stale `referenced_trainer`
placeholder rows (same shape of feature as the tags editor — bundle both
into one future small-Settings-UIs item, §8).

### 4.3 Reconciliation flow (import, and profile creation)

Whenever a trainer identity needs to be resolved — importing a bundle,
or manually creating a new profile by typing a name — check in this order:

1. **Friend code, both sides present, equal → same trainer, no prompt.**
   A GO friend code is a real-world unique identifier; this is the
   strongest possible signal and skips the name-match step entirely.
2. **Friend code, both sides present, different → definitely different
   trainers.** No merge offer shown at all — this positively rules out a
   name collision rather than just failing to confirm one (e.g. two real
   people both named "Ash").
3. **Otherwise, match by name against `referenced_trainer`** (which, per
   §4.2, covers real profiles and placeholders alike in one lookup):
   - **No match** → this is a new identity. Import: create a new real
     `profile` (with mirrored `referenced_trainer` row) using the incoming
     data as-is. Manual creation: same, a fresh `profile` + mirrored row
     with a freshly-generated uuid.
   - **Match found, against a placeholder (`referenced_trainer` row with no
     corresponding `profile`)** → **promote**: create a real `profile` row
     using the incoming data, with the **incoming** uuid (not a freshly
     generated one). Every existing `originalTrainerId` reference to the old
     placeholder uuid must be swept to the incoming uuid across every local
     profile's `pokemon_instance` rows (this is not scope-free — the
     placeholder's uuid may already be referenced by specimens on this
     device even though it never had its own profile). Manual creation
     against a name match works the same way: promote the placeholder,
     don't mint a new uuid.
   - **Match found, against a real profile** → ask the user "merge as one,
     or treat as separate?" On separate: proceed as "no match" (create a
     second, independent profile — this is the genuine "two different
     people happen to share a name" case). On merge: **incoming UUID
     always wins** — rewrite the local profile's `uuid`, every row's
     `profile_id`, and every `originalTrainerId` reference to the old local
     uuid (across all profiles on the device) to the incoming uuid, update
     the mirrored `referenced_trainer` row to match, then run the normal
     per-row last-write-wins merge (§2) between the now-uuid-matching local
     data and the incoming data.

The "incoming wins" rule is uniform across both merge sub-cases (promote,
and real-profile merge) specifically so there is one rewrite mechanism, not
two: a locally-minted uuid (whether a placeholder's or a since-reinstalled
local profile's) is always disposable in favor of the uuid actually present
in the file being imported, since that's the one that will keep matching
against everyone else's devices going forward.

## 5. Export: current vs. all vs. selected

`PersonalDataExport` gains three new fields:

```ts
export interface TrainerExport extends PersonalDataExport {
  trainerUuid: string;
  trainerName: string;
  trainerFriendCode: string | null;
  referencedTrainers: { uuid: string; name: string; friendCode: string | null }[];
}

export interface ExportBundle {
  exportedAt: string;
  schemaVersion: number;
  trainers: TrainerExport[];
  tags: { name: string }[];
}
```

`exportTrainer(profileId): TrainerExport` produces one trainer's full
export (everything `exportPersonalData` produces today, plus the three new
identity fields and its own `referenced_trainer` rows). `SettingsPage.vue`
gains two buttons: **Export current trainer** (existing behavior, now
calling `exportTrainer(currentProfileId)` wrapped as a one-trainer
`ExportBundle`) and **Export all trainers** (iterates `listProfiles()`,
calls `exportTrainer` per profile, wraps all of them plus the device's full
tag list into one `ExportBundle`). Both buttons call the same underlying
function per trainer — never two separate export code paths.

Import reads an `ExportBundle`, runs the reconciliation flow (§4.3) and the
existing per-table merge (§2) once per `TrainerExport` in `trainers`, then
merges `tags` by name (§3.3).

**Deferred, not built now**: "export selected trainers" (a multi-select
checklist instead of an all-or-current binary). Logged to roadmap (§8) —
straightforward to add once "all" exists, not worth the extra UI now.

## 6. Migration

One migration (`0005`), covering:

- `pokemon_instance`: add `uuid TEXT UNIQUE NOT NULL` (backfilled with a
  fresh `crypto.randomUUID()` per existing row), `original_trainer_name
  TEXT NOT NULL` (backfilled to that row's own profile's current
  `username` at migration time — matches real GO behavior for
  never-traded Pokémon), `original_trainer_id TEXT NULL` (backfilled to
  that row's own `profile_id` — every existing specimen's original trainer
  is itself, until proven otherwise by a future trade). `status` enum
  value `released` rewritten to `transferred` on existing rows.
- `tag`: drop `tag_profile_id_name_unique`, add `tag_name_unique` on
  `name` alone. Existing per-profile duplicate names (same name, two
  different profiles) get de-duplicated by keeping the lowest `id` and
  repointing `pokemon_instance_tag` rows from dropped duplicates to the
  survivor — a real possible collision given tags were profile-scoped
  until now.
- New table `referenced_trainer`, backfilled with one row per existing
  `profile` (mirroring §4.2's invariant from the moment this ships).

This is a straight additive/rebuild migration, same SQLite
table-rebuild-for-constraint-changes pattern used by 7a's `0004` — no new
migration mechanism needed.

## 7. Out of scope for 7b (belongs to 7c or later)

- The actual compare UI (side-by-side dex/collection/medal comparison) —
  7c.
- The future trade-flow UX from the compare screen (select a specimen on
  each side, hit "trade," prompt for new IVs/lucky/registration-on-first-
  trade) — noted during brainstorming as a real future feature, not
  scoped or built here. 7c's spec should reference it as a known follow-on
  even though it won't be built there either.

## 8. Roadmap items to log (this spec is the source of truth for these; add to `docs/roadmap.md` alongside this sub-project's entry)

- Export "selected trainers" (multi-select), once "export all" ships.
- A tag editor + `referenced_trainer` cleanup UI — bundle as one future
  small Settings-page management feature.
- Hiding `traded`/`transferred`/`evolved` specimens from Collection's
  default view while keeping them queryable for future trade-history
  stats (the rename in §3.2 ships now; the filtering does not).
- Evolution-lineage display ("this Venusaur started as a Bulbasaur") —
  unrelated to identity/merge, surfaced during this brainstorm, not
  scoped.
- The future compare-screen Trade UX described in §7.
- A placeholder note: a larger, currently-unscoped UI/UX refactor is
  planned at some point after 7b/7c — no shape yet, just don't let it be
  silently forgotten.
