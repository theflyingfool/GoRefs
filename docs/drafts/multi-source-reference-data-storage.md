# Multi-source reference data: storage & precedence — brainstorm

2026-07-28. Written mid-Task-3 of the ingestion consolidation plan
(`docs/superpowers/plans/` — actually tracked as
`/home/nick/.claude/plans/linear-rolling-beaver.md`), after the medal-data
problem exposed a broader issue: we're no longer merging 1-2 sources into
`reference.json`, we're merging N (GAME_MASTER, `pokemon-go-api`, the now-
vendored `vendor/pogoapi-snapshot/`, the pokemongo-shiny sheet, and
whatever comes next), each authoritative for different fields, some
overlapping, some disagreeing. This is a brainstorm, not a decision record —
multiple ideas, a recommendation, explicitly not a plan to execute as-is.

Companion doc: `docs/drafts/db-architecture-options.md` (written earlier
this session) covers the on-device storage question (one SQLite file vs.
two, JSON-vs-prebuilt-file). This doc covers a different layer — the
*ingestion-time* merge problem — and connects to that one at the end rather
than re-solving it.

---

## The actual problem, stated precisely

Today's model (even before this session's changes): one script reads N
cache files, applies ad-hoc per-field logic inline in `build-reference.ts`
("gender comes from X, shadow from Y"), writes one `reference.json`. That
per-field logic lived as scattered code, invisible until you read the whole
file. The medal case made this visible: GAME_MASTER doesn't have medal
names at all, so "just switch the source" broke silently in a way that
would have crashed real users' syncs. As more sources get added, this
scattering gets worse, not better — nobody can look at one place and answer
"where does `medal.description` actually come from, and why."

Separately, you're right that "read a multi-MB JSON at every app boot"
doesn't stay reliable as source count and field count grow. That's a real,
separate concern from the merge-logic one.

---

## Idea A — An explicit, reviewable precedence table

Instead of per-field logic buried in transform functions, one config
(literally a file, e.g. `scripts/ingest/precedence.ts` or a JSON table)
that says, for every field that has more than one candidate source, which
source wins and why:

```ts
// illustrative shape, not a real spec
{
  "medal.name": { primary: "pogoapi-snapshot", fallback: null, note: "GAME_MASTER has no medal display text at all" },
  "species.hasMale/hasFemale": { primary: "gameMaster", fallback: "pogoapi-snapshot", note: "GAME_MASTER genderSettings confirmed match, prefer first-party" },
  "form.shinyReleasedAt": { primary: "shinySheet", fallback: null, note: "no other source has release-date granularity" },
}
```

Transform code becomes "look up the field's source in the table, read from
that source" instead of hardcoded per-field branches. The table itself
becomes the reviewable artifact — a PR that changes which source wins for
a field is a one-line diff in one file, not a hunt through transform logic.

**Pros:** transparent, auditable, cheap to extend per-field as new sources
arrive. Directly solves the medal problem as its first real entry, not a
one-off special case.
**Cons:** another layer of indirection over what's currently plain
function calls; needs the table kept honest (a field with no precedence
entry falling back to "undefined behavior" is a real failure mode worth
guarding against, e.g. a lint/test that every emitted field has a table
entry).

## Idea B — Per-entity/per-category output files instead of one `reference.json`

Split the merge output into many small files (per species, or per
category — moves.json, medals.json, etc.) instead of one large blob.

**Pros:** smaller, more reviewable git diffs; a future partial-resync path
becomes conceivable (only reload the categories that changed).
**Cons:** real restructuring of both the build and the runtime sync path
(`reference-sync.ts` currently wipes/reloads everything in one transaction
by design, partly *because* it's simpler than partial sync); no evidence
yet that git-diff-noise or partial-resync is an actual pain point today.
Speculative — the kind of thing to revisit if Idea A's table reveals
categories that change independently and often, not something to build
preemptively.

## Idea C — Treat "JSON read at boot" as the read-side problem it is, not a write-side one

The boot-time cost isn't really about how ingestion stores its output —
it's `reference-sync.ts` parsing a multi-MB JSON and doing thousands of
`INSERT`s every time `REFERENCE_DATA_VERSION` changes. That's exactly what
`docs/drafts/db-architecture-options.md` already analyzed (shipping a
prebuilt SQLite file instead of JSON, or its recommended hybrid: attach a
prebuilt file and bulk-copy inside the existing transaction, keeping the
deferred-FK safety net but skipping JSON-parse-then-insert). Growing source
count is a real, concrete argument for *not* leaving that option
"documented but deferred" — every new source makes the JSON bigger and the
boot-time cliff worse, which is new information since that report was
written. See "Recommendation" below.

## Idea D — Materialize straight to SQLite at build time, skip JSON as an intermediate format for reference data

Task 6 of the current plan already builds a real `.sqlite` file from
`reference.json` for `drizzle-kit studio` inspection. If the merge step
wrote directly to SQLite (instead of JSON, then a separate SQLite-studio
step reading that JSON back), that artifact could become the actual
*shipped* thing — this is functionally Option 3/4 from
`db-architecture-options.md`, described from the ingestion side instead of
the runtime side. Worth naming here because it's the same conclusion two
different angles (this doc's "boot-time" angle, that doc's "storage
architecture" angle) converge on.

## Idea E — A source-ledger: record provenance per field, not just the value

Alongside (or inside) Idea A's precedence table, optionally record *which
source a given merged value actually came from* as queryable metadata —
either build-time-only (a debug artifact, not shipped) or a real column/
table in the reference data itself. Answers "why does this Pokémon show
X" without re-deriving it by hand, and gives a natural hook if a better
source for some field shows up later (you'd know exactly which rows to
re-check).

**Recommendation: skip for now.** Real value, but speculative until "why
does this show X" is an actual recurring debugging pain, not a hypothetical
one. Cheap to add later on top of Idea A's table if it becomes one.

---

## Recommendation

1. **Adopt Idea A now, minimally.** Task 3 needs a real answer for medals
   (and, per its report, friendship-level XP values and PvP rank counts
   also diverge between GAME_MASTER and the vendored pogoapi snapshot) —
   build just enough of a precedence table to cover the fields Task 3
   already found need one, not a fully general system speculatively sized
   for sources that don't exist yet. Let it grow field-by-field as real
   conflicts show up, the same way `slug-renames.ts` grew organically
   rather than being designed upfront for every possible future rename.
2. **Don't restructure the output format (Idea B) yet.** One
   `reference.json` as the merge target is still fine at today's scale;
   revisit only if Idea A's table makes visible that specific categories
   churn independently often enough to want partial resync.
3. **Treat this session's finding — data sources are multiplying — as new
   evidence for escalating `db-architecture-options.md`'s hybrid option**
   (hold the FK safety net, cut boot cost via bulk-copy instead of
   JSON-parse-then-insert) **from "documented but deferred" to "worth doing
   soon,"** not something to solve inside this doc. That report already has
   the analysis; this doc just adds the "and it's about to get worse"
   argument.
4. **Skip Idea E for now.**

## What this means for the paused plan, concretely

Task 3's medal problem becomes the first real precedence-table entry
(`medal.name`/`medal.description`: primary = `vendor/pogoapi-snapshot`, no
fallback, documented reason = GAME_MASTER has no medal text at all —
confirmed by direct search this session). The report also flagged
friendship-level XP values and PvP-rank counts as similarly diverging
between sources — those become table entries too, with an explicit
decision (not a default) on which source wins each. This is a small,
scoped addition to Task 3, not a new task — the precedence table starts as
a handful of entries, not a framework built in advance of need.
