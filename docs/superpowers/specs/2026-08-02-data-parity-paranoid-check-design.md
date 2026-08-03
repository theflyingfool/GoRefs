# Data Parity via Rebuilt `--test-paranoid` — Design

> **For agentic workers:** this spec is the source of truth for what to build. See
> `docs/superpowers/plans/2026-07-30-generic-ingestion-engine.md` for the original
> cutover plan this supersedes Tasks 25-26 of.

## Background and motivation

The 26-task generic-ingestion-engine plan cut over all 7 configured sources
(`pokeapi`, `pogoapi_net`, `pvpoke`, `pokemon_go_api`, `rplus_shiny`,
`alexelgt_game_masters`, `local_authoring`) to a template-driven engine
(Tasks 1-23, complete). A user-requested side investigation (a
`reference.json`-vs-`GoRefs_Master.duckdb` coverage check, comparing GoRefs'
output against a real consuming app's — GoBuddy's — data needs) found real,
previously-invisible gaps: entire domains with no canonical representation
at all (movesets, species evolutions, PVP rank rewards), a known identity-key
bug collapsing 597 real badges down to 184, and a confirmed missing-species
gap in `mega_species` (Mewtwo X/Y). Full findings:
`.superpowers/sdd/2026-07-30-generic-ingestion-engine/reference-json-coverage-report.md`.

This revealed that "cut over to the generic engine" and "capture 100% of
every source's data" are different goals — the cutover made ingestion
uniform and template-driven, but a template's `field_mappings` only include
whatever fields someone thought to map. Nothing previously checked whether
every field *available* in a source's raw data was actually *decided about*
— mapped, or explicitly and deliberately excluded. Fields nobody thought to
map are silently absent, with no signal that they're missing.

**The actual goal, restated by the project owner**: GoRefs should be usable
as a 100% replacement data source for any Pokémon GO companion app — not
just GoBuddy, and not just the fields GoBuddy's `reference.json` happens to
use today. Full automation of source-onboarding (the original vision) has
proven harder than expected; that goal isn't abandoned, but it's now
explicitly *lower priority* than reaching data parity, since the project
owner's primary project (GoBuddy) is blocked on GoRefs reaching parity, and
this project (GoRefs) is expected to go back-burnered for a while once
parity is reached.

## Scope of this plan

This plan supersedes Tasks 25 and 26 of the original cutover plan. It does
NOT re-open Tasks 1-24 (all complete and reviewed). It covers:

1. A rebuilt `--test-paranoid` (Task 25 was spec'd to only check
   already-mapped fields' *values* — this rebuild instead checks *field
   coverage*: is every raw field accounted for anywhere, at any fidelity).
2. Running it (by the project owner, not as part of this plan's own
   task-completion criteria) to produce an authoritative gap list across 6
   of the 7 sources (`local_authoring` excluded for now — its own data
   format is expected to change soon, making a paranoid check of it
   premature work).
3. A source-by-source override pass closing whatever gaps that report
   surfaces.
4. `AUTOMATION_NOTES.md` — a new, permanent pointer file for
   automation-improvement insights found along the way.
5. Explicitly deferred, done only after parity: investigating *why* the
   profiler/`--deep-dive` didn't surface these gaps on its own. This is
   root-cause/automation work, valuable but not blocking.

Task 26 (build manifest and `--check`) is not addressed here — revisit
after parity, bundled with the deferred profiler root-cause work in item 5
above, since both are automation-quality-of-life work rather than parity
work.

## Component: rebuilt `--test-paranoid`

### What it checks

For each of `pokeapi`, `pogoapi_net`, `pvpoke`, `pokemon_go_api`,
`rplus_shiny`, and `alexelgt_game_masters` (NOT `local_authoring`):

For every distinct field path observed anywhere across that source's raw
records (flattened recursively — nested objects become dotted paths, e.g.
`assetForms.form`; list-of-dicts fields are walked per-item the same way
the profiler's own field cataloger already does), classify it into exactly
one of three tiers:

- **`CANONICAL`** — the field is mapped in a template's `field_mappings`
  (however transformed — combined with another field, renamed,
  boolean-coerced, etc. all count) AND its resolved claim reaches an actual
  column in a canonical domain table (`species`, `forms`, `moves`, etc.).
- **`CLAIMS_ONLY`** — the field is mapped and its claim reaches
  `_claims_ledger` (or a full raw-passthrough table, e.g.
  `game_master_templates`), but was never promoted into a canonical domain
  table column. Data is preserved, not lost — just not yet modeled.
- **`MISSING`** — the field appears in neither `_claims_ledger` nor any
  canonical table. Nobody has decided anything about this field; it is
  silently absent.

**No relevance judgment is made by the check itself.** It does not
pre-guess which fields are "probably unimportant" — the project owner
explicitly rejected that framing, since GoRefs' goal is to be usable by any
consumer, not just GoBuddy. The check reports facts (which tier each field
falls into); a human decides afterward what to do about each `MISSING` or
`CLAIMS_ONLY` finding.

### Two independent extraction methods, cross-checked

DuckDB's `read_json_auto` does schema inference via **sampling**, but real
behavior (verified empirically, not assumed) is not "silently miss a rare
field" — it's stricter and messier than that: (1) a field appearing only
after the sample window makes `read_json_auto` **raise an exception**
(it validates the whole file strictly against the sampled schema), and
(2) heterogeneous nested content (e.g. real GAME_MASTER.json's `data`
field, a different shape per template type) gets collapsed into a generic
`MAP(VARCHAR, JSON)` type rather than a descendable `STRUCT`, hiding
everything beneath that path from this method. Both are handled explicitly
(a caught-and-reported parse failure, and a single "collapsed here" note
per path) rather than left to crash the check or flood the report with
noise. Either way, the underlying reason for using two methods stands:
don't trust one parser's view of a source's real shape. To catch these
blind spots, the check uses two independent methods and cross-checks their
results:

1. **DuckDB's `read_json_auto`** — fast, general-purpose, already used
   elsewhere in this codebase.
2. **Plain Python `json.load` + a manual recursive walk over every record,
   unconditionally** (no sampling) — a completely separate parser and
   type-inference path.

If the two methods disagree on a source's field inventory (one finds a
field path the other didn't), that disagreement is itself reported as a
distinct finding — e.g. `METHOD_MISMATCH: field "assetForms.formName" found
by python_walk but not by duckdb_read_json_auto (likely a sampling miss)`.
This is flagged separately from the three-tier classification above, since
it indicates a blind spot in the check's own tooling, not a gap in GoRefs'
ingestion.

### Interface

```
uv run go_refs.py --test-paranoid [--source <source_key>]
```

Without `--source`, runs against all 6 in-scope sources. Explicitly slow —
this is a full, unsampled, dual-method scan of every record of every
source. Never invoked as part of `--build` or the regular `--test`; it is a
manually-triggered, occasional deep-audit tool, run when there's a specific
reason to suspect a gap (as there is now).

**Progress bar required** (`tqdm`, already an existing dependency —
imported in the original Task 25 draft code) — both because the scan is
slow by design and because visibility into per-source progress matters for
a tool meant to be run rarely and trusted when it does run.

### Output

A markdown report at `output/paranoid_check_report.md`, following this
repo's existing `output/source_coverage_report.md` convention, plus the
same data returned as a dict from `run_paranoid_check()` for programmatic
use / testing.
Grouped by source, sorted worst-first within each source
(`MISSING` → `CLAIMS_ONLY` → `CANONICAL` is not itself worth listing in
the report — only `MISSING` and `CLAIMS_ONLY` need reporting; `CANONICAL`
fields are working as intended and would just be noise). `METHOD_MISMATCH`
findings get their own section per source.

### What the implementer must NOT do

Do not run `--test-paranoid` against real `raw_dumps/` data as part of
building this. Build it, unit-test it thoroughly against synthetic
fixtures (a fixture source with at least one `CANONICAL`, one
`CLAIMS_ONLY`, one `MISSING`, and one deliberately-engineered
`METHOD_MISMATCH` case — e.g. a field with inconsistent types across
records that might make DuckDB's sampled inference miss it), and confirm
those tests pass. The actual real-data run against `raw_dumps/` is the
project owner's to execute themselves once this is built and reviewed.

## Component: source-by-source override pass

After the project owner runs the rebuilt `--test-paranoid` and has a real
report in hand, this plan continues with one task per source (the same 6
in scope for the check), each:

1. Reading that source's slice of the paranoid-check report.
2. For each `MISSING` field: investigate the raw data, decide whether it
   should be mapped into an existing canonical table (new column) or needs
   a new canonical table entirely (e.g. `formMoves`/movesets,
   `speciesEvolutions` — both already flagged as gaps in the
   `reference.json` coverage report and already present in raw form via
   `alexelgt_game_masters`'s GAME_MASTER passthrough). Add the mapping via
   the template's `overrides` block (never touched by profiler re-runs) or
   a new template, per the existing established pattern from Tasks 17-23.
3. For each `CLAIMS_ONLY` field: decide whether to promote it to a real
   canonical column now, given it's already safely captured.
4. Only if, after real inspection, a field is judged truly not worth
   modeling (a case the project owner is skeptical will occur often, given
   GoRefs' "usable by any consumer" goal) — add an explicit
   `excluded: <reason>` annotation to the template, with a real,
   specific, human-written reason. This must never be a rubber-stamp; the
   default assumption is that a field should be captured, not excluded.
5. Re-run the paranoid check for that source (spot-check, not necessarily
   the full dual-method scan every time) to confirm the gap closed.

The exact number and boundaries of these per-source tasks, and how the
already-known findings from the `reference.json` coverage report (badge_id
collision, `mega_species` missing Mewtwo X/Y, missing moveset/evolution
tables, etc.) map onto them, is left to the implementation plan
(`superpowers:writing-plans`), not fully enumerated here — the paranoid
check's real report is the authoritative input to that plan, not this
design doc's guesses.

## Component: `AUTOMATION_NOTES.md`

A new, permanent file at the repo root. Purpose: a fast, skimmable index of
"insights that would make future automated source-onboarding easier,"
written specifically so a much-later return to this project (after
whatever back-burner period) can find them without re-deriving anything.

**Format**: each entry is a short blurb (1-3 sentences: what was noticed,
why it matters for automation) plus a link to the *real*, detailed writeup
in `KNOWN_ISSUES.md` or `TODO.md` — wherever that content actually and
substantively belongs by its own established topic (data-quality issue vs.
deferred idea/task). `AUTOMATION_NOTES.md` itself never holds the
substantive content — it is purely a curated, automation-tagged index
across the two files that do.

Populate it opportunistically throughout the source-by-source override
pass — anything noticed about *why* a field was missed by the profiler, a
shape the profiler's heuristics don't handle well, a pattern that
recurred across multiple sources' gaps, etc. This is not itself a task
with defined completion criteria; it's an ongoing habit for the rest of
this plan's execution.

## Testing

- `--test-paranoid`'s new implementation: TDD as established throughout
  this project (failing test first, against synthetic fixtures, for each
  of the three tiers plus the `METHOD_MISMATCH` case).
- No new automated tests are expected for the source-by-source override
  tasks beyond what each task's own cutover-style verification already
  requires (a failing-test-first regression guard per new/changed
  mapping, full build + `uv run go_refs.py --test` showing 0 gaps,
  consistent with every prior cutover task in this project).

## Explicitly out of scope for this plan

- `local_authoring` — excluded from the paranoid check for now; its data
  format is expected to change soon (per the project owner), making a
  paranoid audit of it premature work that would likely need redoing.
- Task 26 (build manifest, `--check` mode) — deferred alongside the
  profiler root-cause investigation, after parity.
- Investigating *why* the profiler/`--deep-dive` misses fields
  automatically — deferred until after parity is reached; this is
  automation-quality work, not parity work, per the project owner's
  explicit priority ordering.
- Any change to `local_authoring`'s data format itself (referenced above)
  — a separate, not-yet-scoped effort.
