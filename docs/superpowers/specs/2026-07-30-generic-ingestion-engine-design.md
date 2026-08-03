# Design: generic, template-driven ingestion engine

**Status:** approved by project owner, pending spec self-review and final read-through.
**Supersedes:** the uncommitted implementation on `feat/generic-ingestion-engine` (kept as a reference branch, not deleted — see "Branch hygiene").
**Feeds into:** an implementation plan via the `writing-plans` skill, executed as a phased migration.

## Context

`GoRefsMasterEngine` (`src/builder.py`) currently has one hand-written Python
function per raw source/domain, each hardcoding assumptions about that
source's JSON shape and field names. Every bug found across three prior
evaluation passes (documented in `KNOWN_ISSUES.md` and
`EVALUATION_REPORT_FROM_GOBUDDY.md`) traces back to a hardcoded assumption
that didn't match reality, undetected because verification
(`scripts/user_source_coverage_test.py`) didn't actually check that raw
values survive into the canonical tables correctly.

A first implementation attempt (`feat/generic-ingestion-engine`, uncommitted)
built the right pieces in isolation — a profiler, a generic engine, a claims
ledger — but never wired them into the actual build, and only patched the
gender bug directly with more hardcoded logic. This design specifies the
same overall architecture with concrete integration points, so that
half-finished result can't recur, plus several additional pieces (an
independent paranoid test mode, fetch freshness/versioning, and repo
hygiene) surfaced during design review.

## Non-goals

- **No `reference.json`, sqlite export, or any consumer-specific output
  format.** Consuming projects pull `output/GoRefs_Master.duckdb` directly.
- **No positive "male" gender assertion.** No upstream source has an
  `isMale`-equivalent signal; `"unknown"` remains legitimate for anything
  that isn't a confirmed female variant.
- **No fix for `quests`/`max_battles` being empty** — both are confirmed
  correct reflections of an empty upstream endpoint.
- **No `pokeapi` fetcher enhancement in this design** — see "Deferred work"
  below.

## Architecture overview

```
raw_dumps/<source>/<timestamp>/*.json
        │
        ▼ (freshness-checked against remote first — "Fetch freshness + versioning")
┌───────────────────────┐   (new/changed shape, or --deep-dive)
│  Source Profiler       │──────────────────────────────┐
│  (src/profiler.py)     │                               │
└───────────┬───────────┘                               │
            │ writes/updates                             │
            ▼                                            │
config/source_templates/<source>.yml  ◄───────────────────┘
            │ read by
            ▼
┌───────────────────────┐
│  engine.run_source()   │  the ONLY thing that reads a template
│  (src/engine.py)       │  → returns list[Claim], never writes DB directly
└───────────┬───────────┘
            │
            ▼                                    ┌─────────────────────┐
┌───────────────────────┐                        │ Not-yet-cut-over     │
│  Claims Ledger          │ ◄──────────────────── │ sources: legacy      │
│  (entity, attribute,    │   wrapped as claims   │ hardcoded fn, output │
│   source, value,        │   too (see "Cutover   │ wrapped as claims    │
│   priority)              │   order")             └─────────────────────┘
└───────────┬───────────┘
            │ grouped by (entity, attribute)
            ▼
┌───────────────────────┐
│  resolve_attribute_     │  existing function, now reachable from every
│  claim() (unchanged)    │  domain instead of one hardcoded call site
└───────────┬───────────┘
            │ writes canonical rows + discrepancies
            ▼
   output/GoRefs_Master.duckdb
            │
            ├──► --test            (replays ledger vs. canonical tables)
            └──► --test-paranoid   (re-runs engine fresh vs. canonical tables,
                                     independent of the cached ledger)
```

The rule that fixes the disconnection bug from the last attempt: **there is
exactly one path from a source's raw data into the claims ledger.** For a
cut-over source, that path is `engine.run_source()`. For a not-yet-cut-over
source, it's that source's existing hardcoded function, with its output
wrapped into the same claim shape before joining the ledger — never a direct
write to canonical tables. This decouples two previously-conflated fixes:
*"discrepancy coverage for every domain"* is achieved on day one (every
source, converted or not, feeds the same ledger), while *"remove hardcoded
per-source parsing"* happens gradually and safely across the phased
migration.

## Component: storage format & remote/API-style consumption

The project owner flagged that consuming projects shouldn't be limited to
"download the whole `.duckdb` file" — pulling data in an API-like way
(partial/remote queries) should be a real, working option. An independent
research pass (web-verified, not just priors) confirmed this is currently
**broken**, and gave a concrete fix:

- **Format decision: keep DuckDB as the canonical build artifact.** It's
  the only contender that satisfies the relational shape (many domain
  tables, native JSON columns, join/FK modeling) *and* has a mature remote
  read path for non-browser consumers (Python, a Rust/Tauri app) via the
  `httpfs` extension's `ATTACH '<url>' AS db` over HTTPS — a documented,
  stable, read-only remote-attach that only needs correct HTTP Range
  support from the server (see next point). Alternatives considered and
  rejected for this specific use case:
  - **SQLite** (+`sql.js-httpvfs`) — actually has the more battle-tested
    *browser* remote-partial-read story of anything evaluated, but its
    JSON support is function-based over TEXT (not a real JSON type) and
    its query engine is weaker for the ad hoc analytical SQL the web
    explorer already relies on. Adopting it means running two engines or
    rewriting the ingestion pipeline, for a browser-only win.
  - **Parquet + a manifest** — the most mature "remote partial read" story
    of anything evaluated (real predicate pushdown over HTTP, on any
    static host), but it isn't a relational database (no FK modeling, no
    single distributable artifact, joins need a manifest describing
    relationships by hand). Ends up complementing DuckDB as an export
    target, not replacing it.
  - **Hosted Postgres** — rejected on the project's own local-first
    constraints (no hosting exists today; GoBuddy's own invariants are
    explicitly local-first). Doesn't improve the browser "pull without
    downloading" story either without a REST/GraphQL layer in front.
  - **Arrow/DataFusion** — technically interesting for a Rust consumer,
    but its WASM/browser story is less mature than DuckDB-WASM's, and
    DuckDB already Arrow-interops internally — not a distinct alternative
    so much as a partial reimplementation for one consumer.
- **Add a Parquet export specifically for the browser/WASM leg.** DuckDB's
  own `httpfs` isn't available inside DuckDB-WASM (which has a more
  limited, CORS-constrained HTTP shim), and whether DuckDB-WASM can
  usefully `ATTACH` a whole remote `.duckdb` file is still unclear/unproven
  per DuckDB's own community discussions. DuckDB-WASM reading **remote
  Parquet** with predicate pushdown, by contrast, is well-established. So:
  each `--build` also runs `COPY <table> TO '<table>.parquet'` for the
  canonical domain tables (not the 200+ raw exploration tables, which don't
  need a browser story) into a new `output/parquet/` directory — cheap to
  add, gives the browser explorer a genuinely working remote-query path
  without touching the pipeline's primary format.
- **Fix the Range-request bug — this blocks every remote-read pattern
  above regardless of format.** Verified directly: Python's
  `http.server.SimpleHTTPRequestHandler` (confirmed via the standard
  library source on this system, Python 3.14) has **no HTTP Range/206
  support at all**, despite `GoRefsHTTPRequestHandler`'s own docstring
  claiming CORS support "for cross-origin WASM SQL queries and range
  requests." Today, any remote client attempting a partial read against
  `--serve` silently falls back to downloading the entire file on first
  byte access — every pattern above (`httpfs` ATTACH, Parquet
  predicate-pushdown reads, a future SQLite/`sql.js-httpvfs` path) depends
  on the server correctly returning `206 Partial Content` for a `Range:`
  header. `GoRefsHTTPRequestHandler.do_GET`/`send_head` needs a real Range
  implementation (well-known recipes exist, e.g. the `rangehttpserver`
  PyPI package's approach) before "pull from an API instead of downloading
  the whole file" is true for anyone, in any format.

## Cutover order

Ascending by `TRUST_HIERARCHY` priority number (lowest-trust first), so each
step after the first has a growing pool of already-converted lower-priority
claims to visibly override:

1. **`pokeapi`** (tier 7) — pure plumbing smoke test. Not currently mapped
   to any canonical field (confirmed: it's fetched and dumped into raw
   exploration tables, but nothing in `builder.py` reads it back out today).
   No override is expected at this step. Giving it a real canonical mapping
   requires a fetcher enhancement (per-resource detail fetching for flavor
   text/category — the list endpoints it fetches today only return
   `{name, url}` pairs) that's explicitly deferred — see "Deferred work."
2. **`pogoapi_net`** (tier 6) — many simple list endpoints. First source
   with genuinely mappable data; still low override-risk since
   `alexelgt_game_masters` (its usual base-stats counterpart) isn't
   converted yet.
3. **`pvpoke`** (tier 5) — single gamemaster file, moderate nesting.
4. **`pokemon_go_api`** (tier 4) — the highest-value cutover: pokedex/forms
   (gender signals, costumes), raid bosses, badges, quests. By this point
   it's overriding claims from three already-converted lower-priority
   sources — first real multi-source conflict resolution to observe.
5. **`rplus_shiny`** (tier 3) — shiny dates, overrides `pokemon_go_api`'s
   shiny guesses.
6. **`alexelgt_game_masters`** (tier 2) — largest, most authoritative.
   Converting this source requires resolving the shared-block nuance below.
7. **`local_authoring`** (tier 1) — smallest, highest trust, last cutover.

**Shared-block nuance:** today's base-stats resolution is one hardcoded
block reading both `alexelgt_game_masters` and `pogoapi_net` together. It
can't be split cleanly per source. When `pogoapi_net` (step 2) converts,
that block is refactored to route `pogoapi_net`'s half through
`engine.run_source()` while `alexelgt_game_masters`'s half stays unchanged
until its own cutover (step 6) — full deletion of the legacy block only
happens once both sides are converted.

## Component: `engine.run_source()`

One function is the entire contract:

```python
def run_source(source_key: str) -> list[Claim]
```

It loads `config/source_templates/<source_key>.yml`, loads that source's
latest verified-fresh raw snapshot (see "Fetch freshness + versioning"), extracts records per the
template's `record_extraction` spec, applies `field_mappings` and
`gender_signals`, and returns claims. It never writes to canonical tables.

**Shape normalizer:** one shared utility interprets `record_extraction`
(`top_level_list`, `dict_of_lists`, `list_of_dicts_with_subkey`,
`single_object`) instead of scattered `isinstance` checks — this directly
targets the class of bug that broke `raid_bosses` (a dict-of-dict-of-list
one level deeper than assumed).

**Transform library** (referenced by name from templates): `direct`,
`nested_path` (dot-path with optional fallback field), `boolean`,
`list_index` (splits range-pair fields like `cpRange` into `min_x`/`max_x`),
`slugify`. New transforms are added to this table as new sources need them —
this is the extension point, not new per-source Python.

**Gender/variant signals:** a template's `gender_signals` list can contain
multiple OR'd signals (boolean field, value pattern, dict-key pattern) —
any one firing marks the record `gender="female"`. This generalizes the
Frillish fix: it doesn't matter which of three ways a source encodes "this
is the female variant," all are checked.

**Identity & deduplication:** canonical form identity is a normalized tuple
`(species_dex, normalized_form_token, normalized_costume_token, gender)`,
not a raw slug string — normalization strips a leading repeat of the
species' own name/slug and treats the token that produced the gender signal
as consumed (not also a distinct "form name"). Two raw entries resolving to
the same identity tuple become two claims on one record, not two rows —
fixing the duplicate-row class of bug by construction via the same
mechanism that resolves disagreeing base-stat claims today.

## Component: Claims Ledger + Universal Resolver

- Every claim — from `engine.run_source()` or a wrapped legacy function —
  is `(entity_id, attribute, source, value, priority)`, appended to one flat
  ledger for the build.
- After all sources have contributed, group by `(entity_id, attribute)` and
  call the existing `resolve_attribute_claim()` once per group. Single-claim
  groups resolve trivially; agreeing multi-claim groups resolve with no
  discrepancy; disagreeing groups log a discrepancy (field, both values,
  winning source and why) — exactly the mechanism that already exists for
  base stats, now reachable from every domain.
- Canonical row assembly reads resolved values out of the ledger by
  attribute name — it doesn't know or care which source won. This keeps
  row-assembly code source-agnostic, so a new source needs only to emit
  claims with attribute names the assembler already expects.

## Component: `--test` (ledger replay)

Rewrite of `scripts/user_source_coverage_test.py`. For every
`(entity_id, attribute)` group already in the ledger, recompute the expected
winner via the same priority rule the resolver used, and assert the
canonical table holds that value. No independent re-parsing of raw JSON —
that's what degraded the old suite into a tautology. Coverage grows
automatically as more sources join the ledger; nothing about the test
itself needs to change when a new domain starts contributing claims.

## Component: `--test-paranoid` (independent, engine-bypassing cross-check)

A second, opt-in, slower mode that closes a blind spot neither `--test` nor
the original design of this section can fully close: `--test` trusts that
the ledger was built correctly, so it can't catch a bug where the engine
*fails to extract* a claim at all. Re-running `engine.run_source()` (the
earlier draft of this section) closes that gap partially, but still shares
code with the production path — a bug in the engine's own transform/mapping
logic would be reproduced identically by both the real build and its
"independent" check. Per project owner feedback, `--test-paranoid` should
not depend on our own Python extraction code at all.

**Revised design — DuckDB-native, bypasses `engine.py` entirely:**

1. Open `output/GoRefs_Master.duckdb` **read-only** as one connection (the
   canonical, already-resolved data).
2. For each source, load its latest raw snapshot directly into a *separate*
   in-memory (or temp-file) DuckDB instance using DuckDB's own native JSON
   ingestion (`read_json_auto`), not our Python parser — this is what makes
   the check genuinely independent: a bug in `src/engine.py`'s transform
   library cannot also corrupt DuckDB's own built-in JSON reader.
   `read_json_auto` handles nested structs/arrays and infers a schema on its
   own; the only thing borrowed from a source's template is
   `record_extraction`'s unwrap path, used purely to know *where* in the
   JSON the records live (a navigation hint, not a value transform) —
   reusing that is fine because a wrong unwrap path is a loud, obvious
   failure (zero or wildly wrong row count), not a silent value bug.
3. For every row in that raw table, and every column the source's template
   claims to map, look up the corresponding canonical value in the
   read-only master DB:
   - **Match** → row/column verified, move on.
   - **No match** → check the *other* sources' raw DuckDB-loaded tables
     (built the same way) for a value matching what's actually stored
     canonically. If a higher-priority source's raw value matches, report
     `overridden by <source_name>` — expected, not a failure.
   - **No match anywhere** → hard failure: this canonical value doesn't
     trace back to any raw source at all, printed with the entity, column,
     and what's actually stored.
4. Don't stop at the first source's mismatch — per the project owner's
   note, check **all** sources' raw tables for an explaining value before
   concluding "unexplained," since the true winning source for a given
   field isn't always the one you'd first suspect.
5. Only covers sources already cut over (needs a template's
   `record_extraction` hint to know where records live in the raw JSON).
   Not-yet-cut-over sources are explicitly skipped with a note.
6. `tqdm` progress bar per source. Pandas/DuckDB's own DataFrame interop is
   a reasonable implementation choice for the row/column comparison step,
   not a constraint.

This is slower and more resource-intensive than the ledger-replay `--test`
(spinning up per-source DuckDB instances and doing native JSON loads for
every run), which is exactly why it stays a separate, opt-in flag rather
than folded into the default `--test`.

## Component: Source Profiler (`src/profiler.py`)

Runs automatically on first sight of an unmapped source, automatically on
detected shape drift, or on demand via `--deep-dive <source>` /
`--deep-dive` (all sources).

Per source: shape detection (finds the path to the first list of
record-shaped dicts), identity-field ranking, field cataloging (types,
examples, sparsity), gender/variant signal detection (proposes every
plausible signal, not one), range-pair detection (`cpRange`-style →
`min_x`/`max_x`), and a shape fingerprint (hash of sorted key paths + types)
used for drift detection.

Output: `config/source_templates/<source>.yml`, auto-applied immediately,
with auto-detected sections kept separate from a permanent `overrides:`
block a human can edit — the profiler never touches `overrides` on re-run,
and at mapping time `overrides` always wins over the same key in
`field_mappings`.

**Stale-override handling on drift:** before regenerating a template after
detected drift, the profiler validates every `overrides` entry against the
*new* shape. Any override whose referenced path no longer resolves (or
whose type changed) is added to `needs_review` with a specific reason, and
**that one field falls back to the auto-detected mapping** until a human
edits the template — other, still-valid overrides on the same source are
unaffected. The profiler run prints a named warning, and `--check` also
flags it, so it can't be missed by someone who only runs `--build`.

## Profiler dry-run findings (spike, discarded — not wired in)

Before committing to the profiler's design above, a throwaway prototype
implementing its core detection logic (shape-finding, identity-field
ranking, field cataloging, gender-signal detection, range-pair detection)
was run against two real sources' latest raw snapshots. Neither run's
output was wired into the pipeline or written to `config/source_templates/`
— purely exploratory, to sanity-check the design against real data before
implementation.

**`pokeapi` (quick check, per its currently-unmapped status):** confirms
what was already suspected. The only record list detected is at
`results` (1,025 entries), with exactly two fields on every record: `name`
and `url`. No gender signals, no range-pair candidates — there is nothing
else there to detect. This is fully consistent with "give it a real
purpose" being fetcher-layer work (deferred), not a profiler/template gap.

**`pvpoke` (detailed check, new source):**
- Six record-list candidates found in one file: `pokemon` (1,736 rows, the
  primary one), `moves` (334), `cups` (27), `formats` (14),
  `pokemonRegions` (10), `rankingScenarios` (5). A real future template for
  this source likely needs more than one `record_extraction` target — this
  file bundles several logically distinct domains together.
- **Important structural finding:** `dex` looked like an obvious identity
  candidate but isn't one — 523 of the ~1,024 dex numbers have *multiple*
  `pokemon` entries. pvpoke represents shadow/mega/regional/gender variants
  as fully separate flat top-level records (e.g. `bulbasaur`,
  `bulbasaur_shadow` both carry `dex: 1`), distinguished only by a
  `speciesId` suffix (`_shadow`: 474 records, `_mega`: 49, `_alolan`: 18,
  `_galarian`: 18, `_hisuian`: 14, `_female`: 5, `_therian`: 4, `_origin`:
  3, plus one-off `_black`/`_white`). This is structurally different from
  `pokemon_go_api`'s nested `regionForms`/`assetForms` shape, where variants
  live *inside* one species record. **`speciesId` is the correct identity
  field** — confirmed 100% unique across all 1,736 records — not `dex`.
  Whoever builds this source's real template needs to know pvpoke's
  variant-as-separate-record shape going in, rather than reusing
  `pokemon_go_api`'s nested-nested mental model.
- The prototype's own identity-detection heuristic (a fixed candidate list:
  `id`, `dexNr`, `dex_number`, `pokemon_id`, `templateId`, `slug`, `name`)
  **missed `speciesId` entirely**, reporting zero identity candidates for
  this source. That's a real lesson for the actual profiler, not just this
  source: identity-field detection should rank *any* field by
  uniqueness-within-sample (already part of the design), not only check a
  hardcoded shortlist of common names — the shortlist approach is exactly
  the kind of hardcoding this whole project is trying to move away from,
  and it already failed on the very first new source tried against it.
- The gender-signal detector correctly flagged `speciesId`/`speciesName` as
  a `value_pattern` signal (matching `_female`/`(Female)` substrings) — a
  correct positive in this case, not a false one, since pvpoke really does
  encode gender directly in those fields for the 5 records where it applies.
- Notable sparse fields worth a template author's attention: `family`
  (196/200 sampled), `eliteMoves` (90/200), `level25CP` (88/200),
  `tags` (182/200), several `defaultIVs.cp*l40` variants (4-33/200) — none
  are on every record, so a real template needs to treat them as optional.

## Component: Manifest & `--check`

- `--build` remains a full rebuild from `raw_dumps/` every time — no
  incremental caching to invalidate.
- Each `--build` writes `output/build-manifest.json`: per source, the raw
  snapshot timestamp used, the template's shape fingerprint, and a content
  hash of the template file itself (catches human edits to mappings, not
  just upstream shape changes).
- `--check` recomputes current fingerprints/hashes and diffs against the
  last committed manifest — reports drift (including stale overrides)
  without a full rebuild. Mirrors GoBuddy's own `ingest:check` pattern.

## Fetch freshness + versioning

**Correction found during implementation planning:** this mechanism mostly
already exists. `BaseFetcher.is_remote_unchanged()` (a pre-flight HEAD/ETag
check against the latest local snapshot) is already implemented and already
wired into 4 of 6 remote fetchers' `fetch()` methods — `game_master`,
`pokemon_go_api`, `pvpoke`, and `rplus_shiny` all call it before deciding
whether to download. There's also a post-hoc backstop,
`finalize_snapshot()`, which content-hashes a freshly-downloaded snapshot
against the previous one and deletes the new directory if identical,
called by every fetcher including the two below. The actual gaps are
narrower than originally scoped:

- **`pogoapi_net` and `pokeapi` don't call `is_remote_unchanged()`** — they
  fetch unconditionally every time, relying solely on the post-hoc content
  hash to avoid keeping a redundant snapshot. For a live third-party API,
  byte-identical JSON across two separate fetches isn't a safe assumption
  (key ordering, incidental formatting, etc.), so this fetch-then-maybe-undo
  approach is less reliable than a pre-flight check — and `pokeapi`
  specifically is the source observed keeping a genuinely redundant new
  snapshot directory during this investigation. Fix: add the same
  `is_remote_unchanged()` call these two fetchers are missing, matching the
  pattern the other four already use — not a new mechanism.
- **`--build` alone never fetches or checks anything today** — only
  `--fetch`/`--all` call `run_fetching()`; `--build` reads whatever's
  already in `raw_dumps/` with no freshness check at all. This is the part
  that actually needs new behavior per the project owner's request: `--build`
  needs to run the freshness check (not necessarily a full re-download,
  just each fetcher's cheap pre-flight check) for every source before
  building, regardless of whether `--fetch` was also passed.
- **Parsed dumps get the same versioning treatment**, tied to the raw
  snapshot they were derived from: each time `engine.run_source()` actually
  re-runs against a (new) raw snapshot, its extracted claims are written to
  a timestamp-matched location (e.g. `output/parsed_dumps/<source>/<raw
  snapshot timestamp>/claims.jsonl` — exact path/format flexible). Gives a
  versioned raw → parsed → resolved trail, useful for `--test-paranoid` and
  for diffing extraction behavior over time independent of the final
  merged DB.

## Branch hygiene

1. ~~Commit the current uncommitted work on `feat/generic-ingestion-engine`
   as-is~~ — **done.** (It turned out to already be committed — the
   Antigravity attempt landed its own commit, `633ad1d`, independent of
   this session — so the reference branch is preserved as intended.)
2. Start the new implementation on a fresh branch cut from `main` — `main`
   (`91875bf`) has zero commits containing any of the old scaffolding
   (confirmed via `git log main..feat/generic-ingestion-engine`), so the
   new branch starts clean with nothing to remove.
3. The one thing deleted up front rather than patched incrementally:
   `scripts/user_source_coverage_test.py`'s current tautological logic,
   since it's wholesale replaced (Section: `--test`), not evolved
   piece-by-piece. `src/builder.py`'s per-source functions are the opposite
   case — deleted one at a time, only as each source cuts over (Cutover
   order, above), since not-yet-converted sources still need them.

**Baseline captured for cross-check** (per project owner's request): before
any implementation work, `main` (`91875bf`, pre-Antigravity-attempt,
pre-this-redesign) was built and tested fresh, and its output committed to
a dedicated `baseline/pre-generic-engine` branch (commit `d61fa73`) — the
`.duckdb` file, both coverage reports, and generated docs at that exact
state. Species/forms/moves/discrepancies at this baseline: 1024/2205/317/3.
The `--test` report on this branch is the already-known tautological
210,046-claim/100% result — kept as a literal snapshot for diffing, not as
a claim it's correct. Once the new implementation is complete, its output
should be diffed against this branch to see the full delta, not just the
per-step spot checks already covered by "Acceptance criteria" below.

## Post-cutover, pre-testing audit

New phase, positioned after all seven sources are cut over (end of the
Cutover order migration) and before implementing `--test`/`--test-paranoid`:
review every script/function in the repo *not* touched by this redesign
(doc generation, the web server, any fetchers not otherwise modified) and
report what's wrong and how to fix it; fix inline anything trivial.

`scripts/generate_docs.py` is first on this list per the project owner's
suspicion that "the build isn't calling docs correctly." A static read
during design review didn't find a concrete bug — the CLI wiring
(`--build` → `run_doc_generation()`; `--docs` alone also works; file
discovery via `rglob` correctly picks up new files, confirmed by the module
count changing when `engine.py`/`profiler.py` were added during the last
evaluation pass) looks correct — but this needs verifying at runtime during
the audit, not just by reading the code, since the suspicion may point at
something only visible when actually exercised (e.g. specific docstring
formats not rendering, or output going somewhere unexpected).

## Deferred work

Tracked in `TODO.md` (new file), not part of this design:

- **`pokeapi` fetcher enhancement.** Its current fetcher only pulls list
  endpoints (`{name, url}` pairs) — genuinely mappable data (flavor text,
  genera/category) requires per-resource detail fetching (~1000+ additional
  HTTP calls across species/moves). Explicitly out of scope here; revisit
  once the engine exists to receive the mapped output.

## Acceptance criteria

- Every spot check already documented in `KNOWN_ISSUES.md` still holds
  after full cutover: Frillish resolves to exactly 2 correct rows, 0 rows
  have "female" in their name while tagged `unknown`, 0 true duplicate
  `(dex, form_name, costume_name, gender)` tuples anywhere, `raid_bosses`
  row count/fields correct.
- `discrepancies` shows real, non-base-stat conflicts once at least two
  sources sharing a non-base-stat field (e.g. `pokemon_go_api` and
  `rplus_shiny` on shiny data) are both cut over.
- `--test` passes cleanly on the fully cut-over pipeline, with claim counts
  reflecting every domain, not just the original 8 base-stat-adjacent
  attributes.
- `--test-paranoid`, run against a deliberately reintroduced version of the
  old `badges.type` bug, fails with a clear, correctly-attributed error —
  proof the independent check mechanism actually works, not just that it
  runs.
- No new raw snapshot directories appear in `raw_dumps/` across repeated
  `--build` runs when nothing upstream has changed.
- A diff between the finished implementation's build output and the
  `baseline/pre-generic-engine` branch is reviewed explicitly — every
  difference should be traceable to an intended fix from this design (not
  an unexplained regression).
- `--serve` correctly returns `206 Partial Content` for a `Range:` header
  against the `.duckdb` file, and a remote DuckDB `ATTACH ... OVER HTTPS`
  against a locally-served instance succeeds without downloading the full
  file. `output/parquet/` exists and is queryable by DuckDB-WASM over HTTP
  without a full download after `--build`.
