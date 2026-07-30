# Task 2 Report: sources/pokemon-go-api.ts, sources/shiny-sheet.ts, http-cache.ts always-fresh + hash-on-write

## What was implemented

1. **`scripts/ingest/sources/pokemon-go-api.ts`** (new) — parse-only, typed
   accessors over the four cached pgapi files, following game-master.ts's
   convention: each `createXSource(raw)` takes already-`JSON.parse()`d
   content, no file I/O in this module.
   - `PGAPI_FILES` — exported const map of the 4 cache-relative paths to
     their real URLs, moved here from `fetch-reference-data.ts` (which is
     scheduled for deletion) so this module is the durable source of truth
     for what pgapi data the pipeline consumes.
   - `createPokedexSource(raw: PokedexEntry[])` — `all()`, `byId(id)`.
     `PokedexEntry` shape matches `build-reference.ts`'s existing interface
     (id, formId, dexNr, generation, names, pokemonClass, primaryType,
     secondaryType, assets, assetForms, regionForms, megaEvolutions,
     hasGigantamaxEvolution, evolutions), plus an index signature escape
     hatch.
   - `createTypesSource(raw: TypeMatchup[])` — `all()`, `byType(englishName)`.
     Confirmed against the real cache: `types.json` is an 18-entry flat
     array keyed by English type name ("Fighting"), not the
     `POKEMON_TYPE_*` enum `pokedex.json`'s `primaryType.type` uses.
   - `createMegaSource(raw: PokedexEntry[])` — `all()`, `byId(id)` returning
     an **array**, not a single record: confirmed against the real cache
     that `mega.json` reuses the full `PokedexEntry` shape and duplicates a
     species' entry verbatim once per mega variant beyond the first (e.g.
     "CHARIZARD" appears twice, byte-identical, for Mega X/Y) rather than
     emitting one row per variant. Documented inline.
   - `createRaidBossSource(raw: RaidBossListRaw)` — `all()` (flattened
     across tiers), `byTier(tier)`. Confirmed `raidboss.json`'s shape:
     `{ currentList: { mega, lvl5, lvl3, lvl1, shadow_lvl5, shadow_lvl3,
     shadow_lvl1 }, graphics }` — only `currentList` is modeled; `graphics`
     is unused by this pipeline.
   - Note: `build-reference.ts` today does NOT consume
     `pgapi/raidboss.json`/`types.json`/`mega.json` at all (raid bosses
     currently come from pogoapi.net's `raid_bosses` instead) — these three
     getters exist because the brief asked for typed access to all 4 files
     pgapi fetches, presumably for a later task's use, not because current
     `build-reference.ts` logic needs them. `pgapi/pokedex.json` (via
     `createPokedexSource`) is the one actually load-bearing for current
     parity logic.
   - **Where loading is expected to live**: this module deliberately does
     no `readFileSync`/`JSON.parse`. A later task (presumably the one that
     deletes `build-reference.ts`/`fetch-reference-data.ts`) is expected to
     add a small loader — e.g. `JSON.parse(readFileSync(resolve(CACHE_V2_ROOT,
     "pgapi/pokedex.json"), "utf-8"))` — and hand the result to
     `createPokedexSource` etc. This mirrors how `game-master.ts` is used
     today (also not yet wired to any loader in this worktree).

2. **`scripts/ingest/sources/shiny-sheet.ts`** (new) — same convention.
   - `SHINY_SHEET_URL` — resolved, exported const (see "Resolved shiny
     sheet URL" below).
   - `ShinySheetRecord` — `{ family_dex, debut, pid, group, tag?, order?,
     suffix? }` plus an index signature. `tag`/`order`/`suffix` are kept as
     whatever opensheet returns, including empty string `""` (not coerced
     to `undefined`) — verified real rows have both "field absent" and
     "field present but empty string" as distinct cases; a transform layer
     may care about that distinction.
   - `createShinySheetSource(raw)` — `all()`, `byPid(pid)`. `pid` is the
     natural key (matches `pokemon-go-api/assets`' `pm{id}.f{FORM}`/
     `.c{COSTUME}` filename convention, e.g. `pm3.fMEGA`,
     `pm999.fCOIN_A1`). No conflict-warning machinery (unlike
     `game-master.ts`'s `indexByKey`) — verified zero duplicate `pid`
     values across all 1521 real rows, so a plain first-seen `Map` build is
     correct and YAGNI; documented inline why this differs from
     game-master.ts's approach.

3. **`scripts/ingest/http-cache.ts`** (modified) — behavior change plus new
   exports, see "http-cache.ts interface" section below for the exact
   contract later tasks need.

4. **`scripts/ingest/fetch-sprites.ts`** (modified, one line) — its
   `fetchToCache(url, resolve(SPRITES_DIR, basename(url)))` call now passes
   `{ skipIfExists: true }`, preserving the old skip-if-cached behavior for
   sprite binaries now that `fetchToCache`'s default flipped to
   always-fresh. This file is not in the "do not modify" list (only
   `fetch-reference-data.ts`/`build-reference.ts` are) and the brief
   explicitly calls for sprites to keep the old behavior via a parameter on
   the shared function, so this was necessary, in-scope, and minimal.

## NOT modified (per instructions)

`fetch-reference-data.ts` and `build-reference.ts` were left untouched.
One side effect worth flagging to whoever does the deletion task:
`fetch-reference-data.ts` calls `fetchToCache(url, path)` with no options
for both the pogoapi.net and pgapi files — under the new default this
silently makes every one of those fetches always-fresh (previously
skip-if-exists). This is consistent with the brief's intent ("the main
ingestion pipeline always re-fetches fresh") and doesn't break anything
(the script is deleted in a later task regardless), but it does mean if
anyone runs `npm run ingest:v2:fetch` again before that deletion, it will
now re-download all ~49 files every time instead of skipping cached ones.

## Resolved shiny sheet URL

**Resolved URL:** `https://opensheet.elk.sh/1l1CXHdge8_2F2ifjMY71f23DJ_98Ei2QNZ9rPdBd8jQ/'pm2026'`
(single quotes are part of the URL — required because "pm2026" unquoted is
parsed as Google Sheets A1-notation cell range `PM2026`, not a sheet name,
and 404s/errors with `Range (info!PM2026) exceeds grid limits`).

**Confidence: high.** This is not the index-4 fallback — I had live network
access and fully resolved it:
1. The sheet's own `info` tab (opensheet path `info`, gid 0) documents its
   canonical machine-readable data source as
   `https://opensheet.elk.sh/<id>/'pm2026'` verbatim.
2. Fetching that URL live returns 1521 rows shaped exactly like the brief's
   expected record (`family_dex`/`debut`/`pid`/`group`/`tag?`/`order?`/
   `suffix?`), zero duplicate `pid` values, and includes a 2026-07-04 entry
   (more current than the alternates below).
3. Downloaded the workbook (`.../export?format=xlsx`) and read
   `xl/workbook.xml`'s `<sheet>` list directly to see every tab, including
   hidden ones: `info` (visible), `pm2026` (visible), `_LastKnownGood`
   (hidden), `pmtest` (hidden), `pm` (hidden). This proved the previously
   "confirmed working" numeric index `4` is **not stable** — opensheet
   indexes by tab position including hidden tabs, so index 4 happened to
   land on `pmtest` (byte-identical to the old known-working dump, but a
   hidden test tab, not the intended source) purely by current tab order.
   Any tab insertion/reorder would silently repoint it.
4. Ruled out the other two candidates directly: `pm` (hidden) has an
   incompatible shape (`index` field, no `family_dex`, slash-delimited
   dates); `_LastKnownGood`/unquoted-`pm2026` return a garbled
   `{"undefined": "__SHEET__:pm2026"}` shape (a wide display sheet with
   merged cells, not tidy data).

Full resolution narrative and the fallback procedure (re-download the
workbook and re-read `xl/workbook.xml` if `pm2026` is ever renamed) is
documented in a comment directly above `SHINY_SHEET_URL` in
`shiny-sheet.ts`.

## http-cache.ts interface (exact, for later tasks)

```ts
export interface FetchToCacheOptions {
  skipIfExists?: boolean; // default false
}

export async function fetchToCache(
  url: string,
  cachePath: string,
  options: FetchToCacheOptions = {},
): Promise<void>;

export function hashPathFor(cachePath: string): string; // `${cachePath}.hash`

export function readCachedHash(cachePath: string): string | undefined;
```

- **Default (`fetchToCache(url, cachePath)`, no options, or `{}`)**:
  always re-fetches `url` and overwrites `cachePath`, regardless of
  whether it already exists. This is the new default and what the main
  ingestion pipeline's small-JSON-source callers (pgapi/pogoapi files)
  should use — i.e. call with no third argument.
- **`fetchToCache(url, cachePath, { skipIfExists: true })`**: restores the
  old behavior — if `cachePath` already exists on disk, the function
  returns immediately without calling `fetch` at all. This is what
  `fetch-sprites.ts` now passes, and what any other large-binary caller
  (sprite-shaped) should pass.
- **Hash-on-write**: on every *successful* fetch (regardless of which mode
  triggered it), after writing `cachePath`, the function computes
  `hashContent(buf.toString("utf-8"))` (from `src/db/content-hash.ts`) and
  writes it as plain text to a sidecar file at `hashPathFor(cachePath)`
  (i.e. `<cachePath>.hash`). **Encoding is UTF-8** — this matches every
  other `hashContent` caller in the codebase (`build-reference.ts` hashes
  UTF-8 JSON text) and is pinned by a test asserting
  `readCachedHash(p) === hashContent(readFileSync(p, "utf-8"))`. For
  binary payloads (sprites) the UTF-8 decode is lossy, so the sidecar there
  is a coarser signal, not a true content hash — acceptable since sprites
  are outside `ingestion-manifest.json`'s change detection and always use
  `skipIfExists: true` (so re-fetches, and therefore re-hashes, are rare
  anyway).
- **`readCachedHash(cachePath)`** is a pure read (existsSync + readFileSync
  on the sidecar, no re-hashing) — this is what a later manifest-writing
  step should call instead of re-hashing every cached file itself.
- **Failure behavior unchanged and verified by test**: a non-ok response
  throws before anything is written — an existing cached file (and its
  sidecar hash) are left completely untouched by a failed fetch, in both
  the always-fresh and skip-if-exists modes.

## Tests

- `test/http-cache.test.ts` (8 tests): default always-refetch over an
  existing file; `skipIfExists: true` skips fetch when file exists but
  still fetches when it doesn't; hash-on-write sidecar written and pinned
  equal to `hashContent(readFileSync(path, "utf-8"))` (non-ASCII content
  included to exercise real UTF-8 handling); sidecar overwritten when
  content changes on a re-fetch; `readCachedHash` returns undefined for an
  unfetched path; `hashPathFor` path derivation; non-ok response throws and
  leaves existing cached file + hash untouched. Uses `mkdtempSync(tmpdir())`
  per test (never touches `.cache-v2`) and stubs `globalThis.fetch`
  directly (no real network, no test server).
- `test/pokemon-go-api-source.test.ts` (5 tests): `PGAPI_FILES` matches the
  real URLs; pokedex/types/mega/raidboss source factories against small
  fixture objects modeled on the real cached shapes (including the
  Charizard mega-duplication case and an absent-tier lookup).
- `test/shiny-sheet-source.test.ts` (4 tests): `SHINY_SHEET_URL` value;
  `byPid` lookup; empty-string vs. absent field preservation; the
  `pm{id}.f{FORM}`/`.c{COSTUME}`-style pid lookup.
- Full suite: `npm test` — **144/144 passing** (all pre-existing tests
  still green, no regressions).
- `npx tsc --noEmit -p tsconfig.json` — clean, no errors (strict mode,
  covers `scripts` and `test`).

## Self-review findings

- Initially considered hashing the raw bytes via `latin1`/`binary` string
  encoding for hash-on-write; caught during review that this would diverge
  from every existing `hashContent` caller (which hash UTF-8 text) and
  break the "pure read" invariant a later manifest step depends on if it
  ever compares against a UTF-8-based hash computed elsewhere. Switched to
  UTF-8 and pinned the invariant with an explicit test using non-ASCII
  content (Japanese/Korean Pokémon names, representative of the real pgapi
  data).
- Initially resolved the shiny sheet via the numeric index-4 fallback
  (`pmtest`, a hidden tab); on closer investigation via the workbook's own
  `info` tab and `xl/workbook.xml`, found the quoted `'pm2026'` tab is the
  author-documented, visible, more-current source and switched to it
  instead of settling for the fallback.
- Considered adding `game-master.ts`-style conflict-warning machinery to
  `shiny-sheet.ts`'s `byPid` index; verified zero real duplicate `pid`
  values and skipped it as unwarranted complexity (YAGNI), per advisor
  input.
- Fixed stale comments in `http-cache.ts` (module header, `fetchToCache`
  doc comment, `withConcurrency`'s failure-warning string) that would have
  been wrong after the default flipped to always-fresh.

## Concerns

- None blocking. The one soft note is the `fetch-reference-data.ts`
  behavior-change-via-default mentioned above — informational for whoever
  does the deletion task, not something I judged worth deviating from
  "don't touch that file" to address.
