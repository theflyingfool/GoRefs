# Task 4 fix report — manifest false-negative + unused raidboss.json

## Finding 1: `--check`'s manifest write was a false-negative machine

**Root cause confirmed**: `write/manifest.ts`'s old `writeManifest()` always wrote
`ingestion-manifest.json` to disk as a side effect of building it. `ingest.ts`'s
`runCheckMode` called `writeManifest()` purely to get the in-memory return value for
its diff — the disk write was dead weight for `--check`, but `fetchedAt` differs on
every call, so the tracked manifest file's bytes changed on every `ingest:check` run
even with zero upstream change. If that ever got committed, the next `ingest:check`
would diff against a manifest describing a fetch that never produced a corresponding
`reference.json` rebuild.

**Fix**: split `write/manifest.ts` into three functions:
- `buildManifest(): Promise<IngestionManifest>` — fetches the GAME_MASTER commit SHA
  and reads cache hash sidecars, returns the manifest object, **no disk I/O**.
- `writeManifestToDisk(manifest, path = MANIFEST_PATH): void` — thin disk-write step.
  Takes an optional `path` override (added after advisor review) so tests can target a
  scratch file instead of the tracked one.
- `writeManifest(): Promise<IngestionManifest>` — convenience wrapper:
  `buildManifest()` + `writeManifestToDisk()`, used only by the real ingest/build
  path's `manifest` step.

`ingest.ts`'s `runCheckMode` now calls `buildManifest()` directly and never touches
`writeManifest`/`writeManifestToDisk`. The real build path (`manifest()` in
`ingest.ts`, run only from the non-`--check` pipeline) still calls `writeManifest()`
unchanged.

**Precise confirmation of the disk-write claim** (worded carefully per advisor
feedback, since an overbroad claim would be false): `--check` mode never writes
`ingestion-manifest.json` to disk, under any circumstance, including when a diff is
detected. It still populates the gitignored `scripts/ingest/.cache-v2/` source cache
via `fetchAll()` (cached source JSON files + their `.hash` sidecars) — that write is
required and unrelated; it's the same fetch step the real build path also runs, and
`buildManifest()` reads those sidecars to compute file hashes. Only
`ingestion-manifest.json` itself — the file this finding is about — is exempted from
disk writes in `--check` mode.

## Finding 2: `pgapi/raidboss.json` fetched/hashed but unconsumed

**Confirmed via grep** (see command output below) that no `transform/*.ts` module or
`ingest.ts` reads raid-boss data. `ingest.ts` hardcodes `raidBosses: []` and
`raidBossWeatherBoosts: []` in its `ReferenceData` output (Task 3 decision, referenced
in a comment at `ingest.ts:155-159`). `createRaidBossSource` in
`sources/pokemon-go-api.ts` exists but is never imported or called from `ingest.ts` or
any `transform/` module.

```text
$ grep -rn "raidboss\|RaidBoss\|raidBoss" scripts/ingest/ src/ --include="*.ts" -i
scripts/ingest/ingest.ts:158:    raidBosses: [],
scripts/ingest/ingest.ts:159:    raidBossWeatherBoosts: [],
scripts/ingest/sources/pokemon-go-api.ts: (only the module's own type/parser defs)
src/db/reference-data.ts, reference-sync.ts, schema/reference.ts, types.ts:
  (DB-layer RaidBoss types/tables for reference-sync.ts to write the empty
  arrays into — not ingestion-side consumers of raidboss.json)

$ grep -rn "createRaidBossSource|RaidBossSource" scripts/ src/ --include="*.ts"
scripts/ingest/sources/pokemon-go-api.ts:158: (interface def)
scripts/ingest/sources/pokemon-go-api.ts:167: (factory def)
(no call sites anywhere)
```

**Fix**: removed `"pgapi/raidboss.json": ...` from `PGAPI_FILES` in
`sources/pokemon-go-api.ts` — the single source of truth both `ingest.ts`'s `fetchAll`
and `write/manifest.ts`'s per-file hashing loop iterate over. This stops both the
fetch (`ingest.ts`'s `fetchAll` loop) and the hash/change-detection (`manifest.ts`'s
`for (const relPath of Object.keys(PGAPI_FILES))` loop) in one place, without needing
to touch either of those loops directly.

**Deliberate scope decision — dead code kept, not removed**: `createRaidBossSource`,
`RaidBossSource`, `RaidBossEntry`, `RaidBossListRaw`, `RaidBossTier`, and their test
(`test/pokemon-go-api-source.test.ts`'s `createRaidBossSource flattens currentList...`)
are left in place. The review's required fix was "stop fetching AND stop
hashing/including raidboss.json in the manifest's change-detection" — it did not ask
for the parser/type code to be deleted, and removing it was out of scope for this fix
pass. Flagging explicitly so it isn't re-raised as a new finding.

## Third item, found during self-review via advisor: stale committed manifest data

Not part of either finding's required code change, but a direct consequence of
Finding 2's fix: `scripts/ingest/.cache-v2/ingestion-manifest.json` at `HEAD` (the
*committed* manifest `--check` diffs against) still carried a
`"pgapi/raidboss.json": "4126bd1c"` hash from before this fix, written by the old
code. `diffManifests` unions the before/after key sets
(`allFileKeys = new Set([...Object.keys(before...), ...Object.keys(after...)])`), so
with `pgapi/raidboss.json` gone from `PGAPI_FILES` (and thus from every future
`buildManifest()` result), the very next `ingest:check` would have reported
`pokemon-go-api pgapi/raidboss.json: 4126bd1c -> (absent)` and exited non-zero — a
false positive.

Worse, Finding 1's fix makes this **permanent**: since `--check` no longer writes
`ingestion-manifest.json`, there is no longer any path by which running `--check`
itself clears the stale key. Only a full `npm run ingest` (real build path) followed
by a commit would refresh it.

**Fix**: hand-edited the tracked working-tree copy of
`scripts/ingest/.cache-v2/ingestion-manifest.json` to drop the
`"pgapi/raidboss.json"` line, verified the working tree matched `HEAD` byte-for-byte
before editing (`git status --porcelain` was empty for that path), left every other
field (`commitSha`, the other three file hashes, `contentHash`, all `fetchedAt`
values) untouched — they still honestly describe what built the currently-shipped
`reference.json`, and `raidboss.json` never contributed to that content, so dropping
its key doesn't falsify the record.

**Deliberately did NOT** teach `diffManifests` to ignore keys outside `PGAPI_FILES` —
that would also silently mask a genuine future source removal (or a real upstream
file going missing). The data was stale, not the diff logic, so only the data was
fixed.

## Tests added/changed

`test/write-manifest.test.ts`:
- `buildManifest never writes ingestion-manifest.json to disk, even though its result
  differs from what's already there (--check mode's use case)` — seeds a stale
  manifest on disk, stubs a GitHub response that would produce a genuinely different
  `commitSha`, calls `buildManifest()`, asserts the on-disk file is byte-identical
  before and after.
- `writeManifestToDisk writes exactly the manifest object it's given` — now targets a
  scratch path (`CACHE_V2_ROOT/ingestion-manifest.test-scratch.json`) via
  `writeManifestToDisk`'s new optional `path` param, so this test never touches the
  real tracked file, even on a hard process abort.
- `writeManifest (the real ingest/build path) still writes the manifest it computed to
  disk` — confirms the real build path's convenience wrapper still writes correctly
  and returns the same object it wrote.

`test/pokemon-go-api-source.test.ts`:
- Updated `PGAPI_FILES names all 4 cached pgapi files...` → renamed to reflect 3
  files, and the `raidboss.json` entry removed from the expected object.
- Left `createRaidBossSource flattens currentList...` test in place (parser code
  intentionally kept, see above).

## Verification run

- `npm test` — 209/209 pass (ran twice: once after the core fix, once after the
  advisor-flagged stale-manifest-data fix and the scratch-path test change).
- `npx tsc --noEmit` — clean.
- `npx eslint .` — clean.

## Files changed

- `scripts/ingest/write/manifest.ts` — split `writeManifest` into `buildManifest` +
  `writeManifestToDisk` (+ optional `path` param) + `writeManifest` wrapper; updated
  header comments.
- `scripts/ingest/ingest.ts` — `runCheckMode` now calls `buildManifest()` instead of
  `writeManifest()`; updated usage/header comments.
- `scripts/ingest/sources/pokemon-go-api.ts` — removed `pgapi/raidboss.json` from
  `PGAPI_FILES`; updated header/doc comments to explain the exclusion.
- `scripts/ingest/.cache-v2/ingestion-manifest.json` — dropped the stale
  `pgapi/raidboss.json` key (tracked file, hand-edited; see "third item" above).
- `test/write-manifest.test.ts` — 3 new tests, new imports (`buildManifest`,
  `writeManifestToDisk`, `MANIFEST_PATH`).
- `test/pokemon-go-api-source.test.ts` — updated `PGAPI_FILES` expectation/test name.
- `docs/architecture.md`, `docs/ingestion-runbook.md` — updated the ingest pipeline
  description to match: 3 pgapi files (not 4), `--check`'s manifest is in-memory-only,
  raidboss.json's exclusion rationale.
