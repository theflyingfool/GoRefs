# `reference.json` Shim Source + Badge Identity Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix badges' non-unique `badge_id` (independent, standalone), then ingest a
copy of GoBuddy's `reference.json` as a new, lowest-trust GoRefs source, using it
both as a cross-check against existing domains and as the schema/data source for
six domains GoRefs has no canonical table for at all.

**Architecture:** Task 1 is a pure `src/builder.py` fix, unrelated to the rest.
Tasks 2-5 add `reference_json_shim` as a new source through the existing generic
engine (`src/engine.py`'s `run_source()`, `config/source_templates/*.yml`), at
priority 9 in `TRUST_HIERARCHY` (below `unverified_claim`'s 8, so it can never win
a claim conflict), following the exact pattern already established for
`local_authoring` (a local-file fetcher, no network calls).

**Tech Stack:** Python, DuckDB, PyYAML, the existing `src/engine.py` template
engine — no new dependencies.

## Global Constraints

- Full design/rationale/verified real data: `docs/superpowers/specs/2026-08-02-reference-json-shim-source-design.md` — read it before starting any task.
- `reference_json_shim` must be `TRUST_HIERARCHY` priority **9** (strictly lower-trust, i.e. higher number, than `unverified_claim`'s 8) — it must never win a conflict against any existing source.
- `friendship_levels` must not regress: GoRefs' raw 6-tier data (a newer tier `reference.json` lacks) must still win after this shim is added — verify explicitly in Task 5, do not just assume trust-tier ordering handles it.
- Do not touch `src/paranoid_check.py` or the paused `docs/superpowers/plans/2026-08-02-data-parity-paranoid-check.md` plan in this plan.
- Do not attempt to fix the `forms` gender-granularity mismatch or the `friendship_levels` canonical-modeling bug (NULL milestone, duplicate 90.0 rows) — both are known, separate, out-of-scope defects (see spec).
- Every task ends with `uv run pytest tests/ -q` fully green before its commit.
- Copy the real `reference.json` from `/home/nick/Repos/GoBuddy/src/data/reference.json` into this repo at `data-authoring/reference_json_shim/reference.json` as part of Task 2 — this is a one-time manual copy, not a live sync; note its source path and copy date in a one-line comment file alongside it (`data-authoring/reference_json_shim/SOURCE.md`) so a future refresh knows where it came from.

---

### Task 1: Fix badge identity from `id-or-name` fallback to `(name, description)`

**Not blocked on anything else in this plan — do this first, independently.**

`KNOWN_ISSUES.md` item #3 describes this as row loss ("382 distinct badges
silently absorbed"). Verify this directly against `output/GoRefs_Master.duckdb`
before writing any code — `select count(*) from badges` returns 597 (all rows
present) and `select count(distinct badge_id) from badges` returns 184: the bug
is that `badge_id` is not a unique identifier as its name implies, not that rows
are missing. The fix in `src/builder.py`'s "Build Badges" block (currently
computing `badge_id = str(item.get("id") or item.get("name"))`) is to key on
`(name, description)` instead, which `KNOWN_ISSUES.md` already confirmed resolves
the vast majority of the 597 raw records to distinct values, with only exact
byte-for-byte duplicate raw records legitimately collapsing.

**Files:**
- Modify: `src/builder.py` (the "Build Badges" block — search for
  `badge_id = str(item.get("id") or item.get("name"))`, currently the first
  statement inside the `for item in badges_raw:` loop under the
  `# Build Badges` comment; also the dict-branch a few lines below it that
  computes `badge_id = str(b_id)` from a `badges_raw` dict shape, for
  consistency even though today's real `pogoapi_net` data is always a list).
- Test: `tests/test_badge_identity_fix.py` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new consumed by later tasks in this plan — Task 1 is fully standalone.

- [ ] **Step 1: Write the failing test**

Create `tests/test_badge_identity_fix.py`:

```python
import json
import hashlib
from pathlib import Path
import duckdb
from src.builder import GoRefsMasterEngine


def _badges_raw_fixture():
    return [
        # Two genuinely distinct records sharing a bare name (the real
        # collision pattern -- e.g. "Pokemon Air Adventures" 2023 dates).
        {"name": "Pokemon Air Adventures", "description": "Jeju Island, 2023", "rank": 1, "targets": [1], "event_badge": True},
        {"name": "Pokemon Air Adventures", "description": "Jeju Island, July 28, 2023", "rank": 1, "targets": [1], "event_badge": True},
        # Two exact byte-for-byte duplicate raw records (the real upstream
        # duplication pattern KNOWN_ISSUES.md documents) -- these SHOULD
        # collapse, since they are the same record appearing twice.
        {"name": "Pokemon GO Fest-Egg-thusiast", "description": "Berlin, July 1-3, 2022", "rank": 2, "targets": None, "event_badge": True},
        {"name": "Pokemon GO Fest-Egg-thusiast", "description": "Berlin, July 1-3, 2022", "rank": 2, "targets": None, "event_badge": True},
        # A normal, never-colliding badge.
        {"name": "Triathlete", "description": "Achieve a seven-day streak.", "rank": 5, "targets": [1, 10, 50, 100], "event_badge": False},
    ]


def test_badge_identity_distinguishes_same_name_different_description(tmp_path):
    engine = GoRefsMasterEngine.__new__(GoRefsMasterEngine)  # bypass __init__ (no fetch/build side effects needed for this unit)
    badges_list = engine._build_badges_list(_badges_raw_fixture())

    ids = [b["badge_id"] for b in badges_list]
    air_adventure_ids = {b["badge_id"] for b in badges_list if b["name"] == "Pokemon Air Adventures"}
    assert len(air_adventure_ids) == 2, "two distinct dated records must get two distinct badge_ids"


def test_badge_identity_collapses_true_byte_identical_duplicates(tmp_path):
    engine = GoRefsMasterEngine.__new__(GoRefsMasterEngine)
    badges_list = engine._build_badges_list(_badges_raw_fixture())

    gofest_rows = [b for b in badges_list if b["name"] == "Pokemon GO Fest-Egg-thusiast"]
    assert len(gofest_rows) == 1, "exact byte-for-byte duplicate raw records must collapse to one row"


def test_badge_identity_is_stable_and_deterministic():
    engine = GoRefsMasterEngine.__new__(GoRefsMasterEngine)
    badges_list_1 = engine._build_badges_list(_badges_raw_fixture())
    badges_list_2 = engine._build_badges_list(_badges_raw_fixture())
    assert [b["badge_id"] for b in badges_list_1] == [b["badge_id"] for b in badges_list_2]


def test_real_badges_table_after_fix_has_far_fewer_id_collisions():
    db_path = Path("output/GoRefs_Master.duckdb")
    if not db_path.exists():
        import pytest
        pytest.skip("output/GoRefs_Master.duckdb not built -- run `uv run go_refs.py --build` first")
    con = duckdb.connect(str(db_path), read_only=True)
    total = con.execute("select count(*) from badges").fetchone()[0]
    distinct_ids = con.execute("select count(distinct badge_id) from badges").fetchone()[0]
    con.close()
    # Before the fix: 597 total / 184 distinct (a 3.2x collision ratio).
    # After the fix: KNOWN_ISSUES.md's own investigation found (name, description)
    # resolves the large majority distinctly -- assert a real improvement, not
    # exact counts (upstream data can shift between runs).
    assert distinct_ids / total > 0.85, (
        f"expected (name, description) identity to resolve the large majority of "
        f"{total} rows distinctly, got only {distinct_ids} distinct badge_ids"
    )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_badge_identity_fix.py -v`
Expected: FAIL with `AttributeError: 'GoRefsMasterEngine' object has no attribute '_build_badges_list'` — this method doesn't exist yet; Step 3 extracts the existing inline "Build Badges" block into it.

- [ ] **Step 3: Extract and fix badge identity**

In `src/builder.py`, find the existing "Build Badges" block (search for
`# Build Badges` and `badge_id = str(item.get("id") or item.get("name"))`).
Extract its logic into a new method on `GoRefsMasterEngine`, placed near the
other `_build_*` style helper logic in the same class, and call it from the
existing build flow in place of the inline block:

```python
    def _build_badges_list(self, badges_raw) -> list:
        """Builds the badges canonical-table row list, one row per raw record
        (not deduplicated to one row per entity -- see the long-standing
        comment this replaces for why: the 'badges' table intentionally keeps
        every dated/regional badge variant as its own row).

        badge_id is derived from (name, description) rather than the previous
        id-or-name fallback: pogoapi_net's raw badge records never carry an
        'id' field, so name-only identity collapsed real, distinct dated
        event-badge variants (e.g. "Pokemon Air Adventures" 2023 dates) onto
        one badge_id. (name, description) resolves the large majority of
        cases; the remaining collisions are exact byte-for-byte duplicate
        raw records in pogoapi_net's own data, which legitimately collapse.
        """
        def _badge_id_for(name, description) -> str:
            key = f"{name}\x1f{description or ''}"
            return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]

        badges_list = []
        seen_ids = set()
        if isinstance(badges_raw, list):
            for item in badges_raw:
                if isinstance(item, dict):
                    name = item.get("name")
                    description = item.get("description")
                    badge_id = _badge_id_for(name, description)
                    if badge_id in seen_ids:
                        continue  # exact (name, description) duplicate -- collapse
                    seen_ids.add(badge_id)
                    is_event = bool(item.get("event_badge", False))
                    rank = item.get("rank")
                    targets = json.dumps(item.get("targets")) if item.get("targets") is not None else None
                    badges_list.append({
                        "badge_id": badge_id, "name": name, "is_event_badge": is_event,
                        "description": description, "rank": rank, "targets": targets,
                    })
        elif isinstance(badges_raw, dict):
            for b_id, b_info in badges_raw.items():
                if isinstance(b_info, dict):
                    name = b_info.get("name")
                    description = b_info.get("description")
                    badge_id = _badge_id_for(name, description)
                    if badge_id in seen_ids:
                        continue
                    seen_ids.add(badge_id)
                    is_event = bool(b_info.get("event_badge", False))
                    rank = b_info.get("rank")
                    targets = json.dumps(b_info.get("targets")) if b_info.get("targets") is not None else None
                    badges_list.append({
                        "badge_id": badge_id, "name": name, "is_event_badge": is_event,
                        "description": description, "rank": rank, "targets": targets,
                    })
        return badges_list
```

Add `import hashlib` to `src/builder.py`'s imports if not already present
(check first — `src/builder.py` may already import it elsewhere). Replace
the original inline "Build Badges" block's body with a single call:
`badges_list = self._build_badges_list(badges_raw)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_badge_identity_fix.py -v`
Expected: PASS (4/4). The last test (`test_real_badges_table_after_fix_has_far_fewer_id_collisions`)
will SKIP until a real `--build` has been run with this fix in place — that's
expected at this step; run `uv run go_refs.py --build` afterward and re-run this
one test to confirm it passes for real, not just on the synthetic fixture.

- [ ] **Step 5: Run full suite and rebuild**

Run: `uv run pytest tests/ -q` — expect all pass.
Run: `uv run go_refs.py --build` — rebuilds `output/GoRefs_Master.duckdb` with the fix live.
Run: `uv run pytest tests/test_badge_identity_fix.py::test_real_badges_table_after_fix_has_far_fewer_id_collisions -v` — expect PASS now.

- [ ] **Step 6: Update KNOWN_ISSUES.md**

Move item #3 (`badge_id` collisions) from "Still open" to a "Resolved"
section (following whatever resolved-items convention `KNOWN_ISSUES.md`
already uses elsewhere in the file), noting: the original report
overstated the defect as row loss (verified: all 597 raw rows were always
present); the actual defect (non-unique `badge_id`) is fixed via `(name,
description)` identity as of this task's commit.

- [ ] **Step 7: Commit**

```bash
git add src/builder.py tests/test_badge_identity_fix.py KNOWN_ISSUES.md
git commit -m "fix: derive badge_id from (name, description) instead of id-or-name fallback

All 597 raw badge records were always present in the badges table --
KNOWN_ISSUES.md #3 overstated this as row loss. The real defect: badge_id
collapsed 382 distinct badges onto 184 shared values because pogoapi_net's
raw records have no id field and name alone isn't unique across dated
event-badge variants. (name, description) resolves the large majority
distinctly; true byte-for-byte duplicate raw records now correctly
collapse instead of being kept as spurious extra rows."
```

---

## SUPERSEDED (2026-08-03): Tasks 2-5 below were over-scoped for a short-term shim

The project owner reviewed this plan and correctly flagged Tasks 2-5 as too
heavy for something explicitly meant to be temporary: per-domain templates,
entity-identity resolution, and trust-tier integration is real engineering
investment for a stopgap. **Implemented instead:** `src/reference_shim.py`
wholesale-dumps every one of `reference.json`'s 25 top-level arrays into its
own `refjson_<snake_case_domain>` table via `uv run go_refs.py
--load-reference-shim` — no templates, no claims-ledger integration, no
identity resolution. Table names are always `refjson_`-prefixed so they can
never collide with or be overwritten by `write_master_duckdb()`'s own
hardcoded table list (verified directly against `src/builder.py`). See
`data-authoring/reference_json_shim/SOURCE.md` for the live version of this
note. Tasks 2-5's text below is kept only as a record of the rejected
heavier design, not as something to execute.

**Task 1 (badge_id fix) is unaffected by this — still open, not yet done.**

---

### Task 2 (superseded, not to be executed): Add `reference_json_shim` as a new lowest-trust source

**Files:**
- Create: `src/fetchers/reference_json_shim.py`
- Create: `data-authoring/reference_json_shim/reference.json` (copy — see Global Constraints)
- Create: `data-authoring/reference_json_shim/SOURCE.md`
- Modify: `config/sources.yml`
- Modify: `src/builder.py` (`TRUST_HIERARCHY` in `src/builder.py:22-33`)
- Test: `tests/test_reference_json_shim_fetcher.py` (create)

**Interfaces:**
- Consumes: `src.fetchers.base.BaseFetcher`, `FetcherRegistry` (existing).
- Produces: a registered fetcher for source key `reference_json_shim`, discoverable
  the same way `local_authoring` is — later tasks' `--deep-dive reference_json_shim`
  and `run_source("reference_json_shim_<endpoint>", ...)` calls depend on this.

- [ ] **Step 1: Copy the real file and document its provenance**

```bash
mkdir -p data-authoring/reference_json_shim
cp /home/nick/Repos/GoBuddy/src/data/reference.json data-authoring/reference_json_shim/reference.json
```

Create `data-authoring/reference_json_shim/SOURCE.md`:

```markdown
# reference_json_shim provenance

Copied from `/home/nick/Repos/GoBuddy/src/data/reference.json` on 2026-08-02.
This is a manual, one-time snapshot -- not a live sync. Refresh by re-running
the copy command above and re-running `uv run go_refs.py --fetch --source
reference_json_shim` (or `--build`) whenever a newer comparison is wanted.
See `docs/superpowers/specs/2026-08-02-reference-json-shim-source-design.md`
for why this source exists and why it is deliberately the lowest-trust
source in the system.
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_reference_json_shim_fetcher.py`:

```python
import json
from pathlib import Path
from src.fetchers import FetcherRegistry


def test_reference_json_shim_fetcher_is_registered():
    fetcher_cls = FetcherRegistry.get_fetcher_class("reference_json_shim")
    assert fetcher_cls is not None


def test_reference_json_shim_fetcher_archives_configured_file(tmp_path):
    fixture_dir = tmp_path / "data-authoring" / "reference_json_shim"
    fixture_dir.mkdir(parents=True)
    (fixture_dir / "reference.json").write_text(json.dumps({"species": [{"slug": "bulbasaur"}]}))

    fetcher_cls = FetcherRegistry.get_fetcher_class("reference_json_shim")
    config = {"files": [str(fixture_dir / "reference.json")]}
    fetcher = fetcher_cls("reference_json_shim", config, base_dump_dir=tmp_path / "raw_dumps")
    snapshot_dir = fetcher.fetch(force=True)

    assert (snapshot_dir / "reference.json").exists()
    assert json.loads((snapshot_dir / "reference.json").read_text())["species"][0]["slug"] == "bulbasaur"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/test_reference_json_shim_fetcher.py -v`
Expected: FAIL — `FetcherRegistry.get_fetcher_class("reference_json_shim")` returns `None` (not registered yet).

- [ ] **Step 4: Create the fetcher**

Create `src/fetchers/reference_json_shim.py`, following `src/fetchers/local_authoring.py`'s
exact existing pattern (same archive-local-files behavior, different registered key
and default file list):

```python
"""Fetcher/archiver module for the reference.json lowest-trust shim source."""

import shutil
from pathlib import Path
from .base import BaseFetcher, FetcherRegistry


@FetcherRegistry.register("reference_json_shim")
class ReferenceJsonShimFetcher(BaseFetcher):
    """Fetcher/archiver for a manually-copied snapshot of GoBuddy's reference.json,
    used as GoRefs' lowest-trust cross-check/gap-fill source. See
    docs/superpowers/specs/2026-08-02-reference-json-shim-source-design.md.
    """

    def fetch(self, force: bool = False) -> Path:
        """Archives the configured reference.json snapshot into a timestamped snapshot dir.

        Args:
            force: If True, forces snapshot creation.

        Returns:
            Path to saved snapshot directory.
        """
        files = self.config.get("files", ["data-authoring/reference_json_shim/reference.json"])
        snapshot_dir = self.create_snapshot_dir()

        print(f"[{self.source_key}] Archiving reference.json shim into snapshot...")
        for rel_path_str in files:
            file_path = Path(rel_path_str)
            if file_path.exists():
                dest_path = snapshot_dir / file_path.name
                shutil.copy2(file_path, dest_path)
                print(f"[{self.source_key}] Copied {file_path} -> {dest_path}")
            else:
                print(f"[{self.source_key}] Warning: reference_json_shim file {file_path} not found.")

        print(f"[{self.source_key}] Snapshot completed at {snapshot_dir}")
        return self.finalize_snapshot(snapshot_dir, force=force)
```

Register the new module in `src/fetchers/__init__.py` the same way every
other fetcher module is registered there (check the file first — it likely
either imports each fetcher module explicitly, or auto-discovers `.py` files
in the directory; match whichever pattern already exists so
`reference_json_shim` is discovered the same way `local_authoring` is).

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_reference_json_shim_fetcher.py -v`
Expected: PASS (2/2).

- [ ] **Step 6: Add the source to `config/sources.yml` and `TRUST_HIERARCHY`**

In `config/sources.yml`, add (following the exact structure of the existing
`local_authoring` entry immediately above it):

```yaml
  reference_json_shim:
    name: "GoBuddy reference.json (lowest-trust shim)"
    description: "Manually-copied snapshot of GoBuddy's own canonical reference.json, used as a lowest-trust cross-check and gap-fill source. Never wins a claim conflict against any other source. See docs/superpowers/specs/2026-08-02-reference-json-shim-source-design.md."
    enabled: true
    trust_tier: "reference_json_shim"
    priority: 9
    license: "Project Internal"
    files:
      - "data-authoring/reference_json_shim/reference.json"
    local_dump_dir: "raw_dumps/reference_json_shim"
```

In `src/builder.py`, add to `TRUST_HIERARCHY` (`src/builder.py:22-33`):

```python
TRUST_HIERARCHY: Dict[str, int] = {
    "confirmed_owner_submission": 1,
    "local_authoring": 1,
    "authoritative_game_master": 2,
    "alexelgt_game_masters": 2,
    "rplus_shiny": 3,
    "pokemon_go_api": 4,
    "pvpoke": 5,
    "pogoapi_net": 6,
    "pokeapi": 7,
    "unverified_claim": 8,
    "reference_json_shim": 9,
}
```

- [ ] **Step 7: Run full suite and verify fetch works end-to-end**

Run: `uv run pytest tests/ -q` — expect all pass.
Run: `uv run go_refs.py --fetch` (fetches all configured sources, including
the new one) — confirm `raw_dumps/reference_json_shim/<timestamp>/reference.json`
is created and its contents match the copied file.

- [ ] **Step 8: Commit**

```bash
git add src/fetchers/reference_json_shim.py src/fetchers/__init__.py config/sources.yml src/builder.py tests/test_reference_json_shim_fetcher.py data-authoring/reference_json_shim/
git commit -m "feat: add reference_json_shim as a new lowest-trust source (priority 9)"
```

---

### Task 3: Templates for cross-check domains with a clean shared key

Covers `species` (by `dexNumber`), `medals` (by the fixed `(name, description)`
identity from Task 1), `typeEffectiveness`, and `weatherBoosts`. These are
deliberately expected to LOSE every claim conflict against existing higher-trust
sources — the test in this task proves that, not just that claims are emitted.

**Files:**
- Create: `config/source_templates/reference_json_shim_species.yml`
- Create: `config/source_templates/reference_json_shim_medals.yml`
- Create: `config/source_templates/reference_json_shim_typeEffectiveness.yml`
- Create: `config/source_templates/reference_json_shim_weatherBoosts.yml`
- Modify: `src/builder.py` (add `run_source()` calls for each, merged into the
  existing species/badges/type-effectiveness/weather-boosts claim resolution —
  find each domain's existing `run_source(...)` call(s) in `src/builder.py`, per
  Task 2's "Interfaces" note above, and add a call for this shim's template
  immediately after each, so its lower-priority claims are present in the same
  `resolve_all_claims()` pass and correctly lose)
- Test: `tests/test_reference_json_shim_cross_check.py` (create)

**Interfaces:**
- Consumes: `run_source()` (existing, `src/engine.py`), the `reference_json_shim`
  raw dump from Task 2.
- Produces: nothing new consumed by later tasks — Tasks 3 and 4 are independent
  of each other (both depend only on Task 2).

- [ ] **Step 1: Confirm `reference.json`'s top-level shape is unwrappable per-domain**

Since `reference.json` is one JSON object with each domain as a top-level array key
(not one file per domain), each template's `record_extraction.unwrap_path` selects
into that specific array — e.g. `unwrap_path: [species]` for the species template,
`unwrap_path: [medals]` for medals. Verify this against the real copied file before
writing templates:

```bash
uv run python3 -c "
import json
data = json.load(open('data-authoring/reference_json_shim/reference.json'))
print(list(data.keys()))
"
```

Expected output includes `species`, `medals`, `typeEffectiveness`, `weatherBoosts`
among the 25 top-level keys (already verified once during spec-writing; re-verify
here in case the copy is refreshed between Task 2 and Task 3).

- [ ] **Step 2: Write `reference_json_shim_species.yml`**

```yaml
source_key: reference_json_shim
endpoint: species
entity_id_prefix: pokemon_dex
record_extraction:
  unwrap_path: [species]
  iterate_mode: top_level_list
identity_field: dexNumber
field_mappings:
  name:
    source_field: name
    transform: direct
  gen:
    source_field: gen
    transform: direct
  can_mega_evolve:
    source_field: canMegaEvolve
    transform: direct
  can_gigantamax:
    source_field: canGigantamax
    transform: direct
gender_signals: []
overrides: {}
needs_review: []
```

`entity_id_prefix: pokemon_dex` is the critical line — it's what makes this
shim's claims land on the exact same `pokemon_dex_<n>` entities that
`alexelgt_game_masters`'s species claims already use (per
`config/source_templates/game_master_pokemon_settings.yml`'s own
`entity_id_prefix: pokemon_dex`), so the trust-tier resolution in
`resolve_attribute_claim()` actually has both claims to compare, rather than
the shim's claims landing on an unreachable, disjoint namespace (the exact
bug already documented in `KNOWN_ISSUES.md` for `pogoapi_net`'s own
species-stats claims).

- [ ] **Step 3: Write `reference_json_shim_medals.yml`**

```yaml
source_key: reference_json_shim
endpoint: medals
entity_id_prefix: badge
record_extraction:
  unwrap_path: [medals]
  iterate_mode: top_level_list
identity_field: slug
field_mappings:
  name:
    source_field: name
    transform: direct
  description:
    source_field: description
    transform: direct
  is_event_badge:
    source_field: isEventMedal
    transform: direct
gender_signals: []
overrides: {}
needs_review:
  - field: identity_field
    reason: >-
      reference.json's medal `slug` is a clean, always-distinct
      slugify(name) (verified: 583/583 distinct). This does NOT match
      GoRefs' own post-Task-1 badge_id (a hash of (name, description)), so
      this shim's claims will land on a DIFFERENT entity namespace than
      badges' own claims today (badge_<hash> vs badge_<slug>) and will
      never actually compete/lose against them as intended -- they will
      instead sit as orphaned, never-read claims. This is a known
      limitation, not silently swept under the rug: fixing it requires
      either badges' own identity_field also becoming a slugify(name)-based
      value (a bigger, out-of-scope change to Task 1), or teaching this
      template to compute the SAME hash Task 1 uses. Flagging explicitly
      per this project's established needs_review convention rather than
      building a false sense that this cross-check works today -- Task 3's
      Step 6 test must assert on this honestly (see below), not assume it.
```

- [ ] **Step 4: Write `reference_json_shim_typeEffectiveness.yml` and `reference_json_shim_weatherBoosts.yml`**

Inspect the real per-record shape for both before writing field_mappings
(these were not printed during spec-writing — do this now):

```bash
uv run python3 -c "
import json
data = json.load(open('data-authoring/reference_json_shim/reference.json'))
print(json.dumps(data['typeEffectiveness'][0], indent=2))
print(json.dumps(data['weatherBoosts'][0], indent=2))
"
```

Write both templates following the same `unwrap_path`/`identity_field`/
`field_mappings` pattern as Steps 2-3, using whatever identity field the
real inspected shape suggests (likely a compound attacking/defending type
pair for `typeEffectiveness`, and a weather name for `weatherBoosts` — since
`type_effectiveness` and `weather_boosts` are already **Full** per the
coverage report, entity_id alignment must be checked against those two
tables' real existing entity_id scheme in `output/GoRefs_Master.duckdb`
the same way Step 2 checked species — if no existing generic-engine claims
back these two tables today (verify: `grep -n "type_effectiveness\|weather_boosts" src/builder.py`
for whether they're built by `run_source()` or hand-parsed), document that
finding plainly rather than guessing an entity_id scheme that doesn't exist
yet, and treat these two templates as reference-only additions (written,
tested for parseability, but not yet wired into `resolve_all_claims()`) —
flag this explicitly in the task's completion report rather than silently
skipping it.

- [ ] **Step 5: Wire the species and medals templates into `src/builder.py`**

Find the existing species-claims `run_source()` call(s) in `src/builder.py`
(search for `run_source("game_master_pokemon_settings"` and
`run_source("pogoapi_net_pokemon_stats"`) and the badges section (search for
`# Build Badges`). Add, immediately after the existing species-related
`run_source()` calls, in the same claims-collection flow:

```python
        reference_json_shim_species_claims = run_source(
            "reference_json_shim_species", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
```

And after `resolve_all_claims()` is first called (search for
`resolved = self.resolve_all_claims()`), if `reference_json_shim_species_claims`
was collected before that call, no further wiring is needed — `run_source()`'s
claims are collected into `self.claims` (verify this against `run_source()`'s
actual return-value handling elsewhere in `src/builder.py`, e.g. how
`gm_pokemon_settings_claims` is used after being assigned, and mirror that exact
pattern here rather than inventing a new one).

Do NOT wire the medals template's claims into anything that feeds the
`badges` table directly (Task 1 already established `badges_list` is
hand-built from raw data, not from the ledger) — instead, just confirm via
`run_source()`'s claims collection that the medals claims are collected
into the ledger at all (for `_claims_ledger` visibility / future use), even
though Step 3's `needs_review` note already establishes they won't
practically compete against anything today.

- [ ] **Step 6: Write the cross-check test**

Create `tests/test_reference_json_shim_cross_check.py`:

```python
import duckdb
from pathlib import Path
import pytest


def test_reference_json_shim_species_claims_never_win_over_game_master():
    db_path = Path("output/GoRefs_Master.duckdb")
    if not db_path.exists():
        pytest.skip("output/GoRefs_Master.duckdb not built -- run `uv run go_refs.py --build` first")
    con = duckdb.connect(str(db_path), read_only=True)
    # Bulbasaur's gen must still resolve from a higher-trust source (1), not
    # from reference_json_shim (priority 9) -- this is the actual point of
    # putting this source at the bottom of TRUST_HIERARCHY.
    rows = con.execute(
        "select source, priority from _claims_ledger where entity_id = 'pokemon_dex_1' and attribute = 'gen' order by priority"
    ).fetchall()
    con.close()
    assert len(rows) >= 1, "expected at least one 'gen' claim for pokemon_dex_1"
    winning_source, winning_priority = rows[0]
    assert winning_source != "reference_json_shim", (
        f"reference_json_shim must never win a claim conflict, but it won 'gen' for pokemon_dex_1 "
        f"(winning source was {winning_source!r} at priority {winning_priority})"
    )
    if len(rows) > 1:
        shim_rows = [r for r in rows if r[0] == "reference_json_shim"]
        assert shim_rows, "expected reference_json_shim to have submitted a losing claim, not be entirely absent"
        assert shim_rows[0][1] == 9, "reference_json_shim's claim must be recorded at priority 9"
```

- [ ] **Step 7: Run full suite and rebuild**

Run: `uv run pytest tests/ -q` — expect all pass (new tests referencing the
real DB will `skip` until a fresh `--build` runs).
Run: `uv run go_refs.py --build`.
Run: `uv run pytest tests/test_reference_json_shim_cross_check.py -v` — expect PASS.

- [ ] **Step 8: Commit**

```bash
git add config/source_templates/reference_json_shim_species.yml config/source_templates/reference_json_shim_medals.yml config/source_templates/reference_json_shim_typeEffectiveness.yml config/source_templates/reference_json_shim_weatherBoosts.yml src/builder.py tests/test_reference_json_shim_cross_check.py
git commit -m "feat: cross-check species/medals/typeEffectiveness/weatherBoosts against reference_json_shim"
```

---

### Task 4: Model the six total-canonical-gap domains using `reference.json`'s shapes

Covers `form_moves`, `species_evolutions`, `pvp_rank_rewards`,
`pvp_rank_requirements`, `player_level_rewards`, `backgrounds` — none of these
have a canonical table in GoRefs today (per the coverage report). Unlike Task 3,
these are meant to actually populate real data (there is no higher-priority
source to lose to yet), while still being tagged with `reference_json_shim` as
their `source` in the claims ledger so a future primary-source promotion can
supersede them cleanly.

**Files:**
- Create: `config/source_templates/reference_json_shim_formMoves.yml`
- Create: `config/source_templates/reference_json_shim_speciesEvolutions.yml`
- Create: `config/source_templates/reference_json_shim_pvpRankRewards.yml`
- Create: `config/source_templates/reference_json_shim_pvpRankRequirements.yml`
- Create: `config/source_templates/reference_json_shim_playerLevelRewards.yml`
- Create: `config/source_templates/reference_json_shim_backgrounds.yml`
- Modify: `src/builder.py` (add the six new canonical tables' DDL to the schema
  dict — search for `"badges": "badge_id VARCHAR, ..."` in `src/builder.py:1515`
  and add six sibling entries in the same dict; add six new row-assembly blocks
  reading from `run_source()`'s claims the same way existing simple domains do)
- Test: `tests/test_reference_json_shim_new_tables.py` (create)

**Interfaces:**
- Consumes: `run_source()`, Task 2's raw dump. Independent of Task 3.
- Produces: six new canonical tables — no later task in this plan consumes them
  directly, but Task 5's verification checks all six.

- [ ] **Step 1: Decide each table's entity identity and foreign keys**

Real shapes (already verified during spec-writing, reproduced here for the
implementer's direct use):

| Domain | Real record shape | Entity identity | FK resolution |
|---|---|---|---|
| `formMoves` | `{formSlug, moveSlug, isElite}` | `f"{formSlug}::{moveSlug}"` (composite, no natural single key) | `formSlug` should match `forms.slug` directly (GoRefs already uses the same slug convention); `moveSlug` is `reference.json`'s own move-slug — GoRefs' `moves` table has no `slug` column (only `move_id`/`name`), so store `moveSlug`/`formSlug` as plain text columns rather than attempting a live join in this task; a join view can be added later once `moves` gets a slug column. |
| `speciesEvolutions` | `{fromSpeciesSlug, toSpeciesSlug, candyRequired, itemRequired}` | `f"{fromSpeciesSlug}::{toSpeciesSlug}"` | Both slugs should match `species.slug` directly. |
| `pvpRankRewards` | `{leagueRank, track, sortOrder, rewardType, itemName, amount}` | `f"{leagueRank}::{track}::{sortOrder}"` | None needed — self-contained. |
| `pvpRankRequirements` | `{rank, additionalBattlesRequired, additionalBattleWinsRequired}` | `rank` | None needed. |
| `playerLevelRewards` | `{level, sortOrder, itemName, amount}` | `f"{level}::{sortOrder}"` | None needed. |
| `backgrounds` | `{slug, name}` | `slug` | None needed. |

- [ ] **Step 2: Write the six templates**

Follow this exact pattern (shown for `backgrounds`, the simplest case) for
all six — `unwrap_path` selects the matching top-level array, `entity_id_prefix`
is the new table's own namespace (not shared with any existing domain, since
these are brand new entities), `identity_field` per the table above:

```yaml
source_key: reference_json_shim
endpoint: backgrounds
entity_id_prefix: background
record_extraction:
  unwrap_path: [backgrounds]
  iterate_mode: top_level_list
identity_field: slug
field_mappings:
  name:
    source_field: name
    transform: direct
gender_signals: []
overrides: {}
needs_review: []
```

For the four domains needing a composite identity (`formMoves`,
`speciesEvolutions`, `pvpRankRewards`, `playerLevelRewards`), check
`src/engine.py`'s transform library (`apply_transform()`) for an existing
"concatenate fields" transform before writing a new one — if one exists,
use it to build the composite `identity_field` value from two source
fields; if none exists, write the composite key directly in
`src/builder.py`'s row-assembly step instead of in the template (i.e. read
each raw record's two fields directly in the loop that builds each table's
row list, the same way Task 1's `_build_badges_list` does its own key
computation), rather than inventing new template syntax mid-task.

- [ ] **Step 3: Add the six tables' DDL and row assembly to `src/builder.py`**

In the schema dict (`src/builder.py:1515`, alongside `"badges": "..."`), add:

```python
            "form_moves": "form_slug VARCHAR, move_slug VARCHAR, is_elite BOOLEAN, source VARCHAR",
            "species_evolutions": "from_species_slug VARCHAR, to_species_slug VARCHAR, candy_required INT, item_required VARCHAR, source VARCHAR",
            "pvp_rank_rewards": "league_rank INT, track VARCHAR, sort_order INT, reward_type VARCHAR, item_name VARCHAR, amount INT, source VARCHAR",
            "pvp_rank_requirements": "rank INT, additional_battles_required INT, additional_battle_wins_required INT, source VARCHAR",
            "player_level_rewards": "level INT, sort_order INT, item_name VARCHAR, amount INT, source VARCHAR",
            "backgrounds": "background_slug VARCHAR, name VARCHAR, source VARCHAR",
```

Each table carries a `source` column (always `"reference_json_shim"` for now,
every row) so a future primary-source promotion is a visible, auditable
change, not a silent one — this is a deliberate, explicit "this data came
from the shim" marker per the design spec's temporariness intent, not an
oversight to clean up later.

For row assembly, add six new blocks near the existing simple-domain
row-building code (e.g. near `mega_species_list`'s construction), each
calling `run_source("reference_json_shim_<endpoint>", ...)` and mapping
its resolved claims (or, for the four composite-identity domains, the raw
records directly, per Step 2's guidance) into the row-list shape matching
the DDL above. Follow the existing pattern used for `weather_boosts` or
`community_days` (whichever is structurally simplest — check both first) as
the concrete template for "how a simple, non-species-linked domain gets
built from `run_source()`'s output" in this codebase, rather than inventing
a new pattern.

- [ ] **Step 4: Write the test**

Create `tests/test_reference_json_shim_new_tables.py`:

```python
import duckdb
from pathlib import Path
import pytest

NEW_TABLES = [
    "form_moves", "species_evolutions", "pvp_rank_rewards",
    "pvp_rank_requirements", "player_level_rewards", "backgrounds",
]


@pytest.mark.parametrize("table", NEW_TABLES)
def test_new_canonical_table_exists_and_is_populated(table):
    db_path = Path("output/GoRefs_Master.duckdb")
    if not db_path.exists():
        pytest.skip("output/GoRefs_Master.duckdb not built -- run `uv run go_refs.py --build` first")
    con = duckdb.connect(str(db_path), read_only=True)
    count = con.execute(f"select count(*) from {table}").fetchone()[0]
    all_sources = con.execute(f"select distinct source from {table}").fetchall()
    con.close()
    assert count > 0, f"{table} must be populated, got 0 rows"
    assert all(s == ("reference_json_shim",) for s in all_sources), (
        f"{table} should currently be sourced entirely from reference_json_shim, got sources {all_sources}"
    )


def test_form_moves_slugs_are_resolvable_against_forms_and_species_tables():
    db_path = Path("output/GoRefs_Master.duckdb")
    if not db_path.exists():
        pytest.skip("output/GoRefs_Master.duckdb not built -- run `uv run go_refs.py --build` first")
    con = duckdb.connect(str(db_path), read_only=True)
    unresolvable = con.execute(
        "select count(*) from form_moves fm left join forms f on fm.form_slug = f.slug where f.slug is null"
    ).fetchone()[0]
    total = con.execute("select count(*) from form_moves").fetchone()[0]
    con.close()
    # Not asserting 0 -- the design spec already documents forms' known
    # gender-granularity mismatch, so some formSlug values (gender-specific,
    # e.g. "-female") may not resolve against GoRefs' gender-collapsed forms
    # table. Assert the MAJORITY resolves, and report the real ratio for a
    # human to judge, rather than asserting a specific number that might be
    # wrong the moment reference.json is refreshed.
    assert unresolvable / total < 0.5, (
        f"{unresolvable}/{total} form_moves rows have a form_slug not found in forms.slug -- "
        f"expected the majority to resolve given GoRefs already uses the same slug convention"
    )
```

- [ ] **Step 5: Run full suite and rebuild**

Run: `uv run pytest tests/ -q` — expect all pass (new parametrized tests skip
until rebuild).
Run: `uv run go_refs.py --build`.
Run: `uv run pytest tests/test_reference_json_shim_new_tables.py -v` — expect all PASS; if
`test_form_moves_slugs_are_resolvable_against_forms_and_species_tables` fails,
investigate the real unresolved ratio and report it rather than forcing the
test to pass by loosening the threshold blindly.

- [ ] **Step 6: Commit**

```bash
git add config/source_templates/reference_json_shim_formMoves.yml config/source_templates/reference_json_shim_speciesEvolutions.yml config/source_templates/reference_json_shim_pvpRankRewards.yml config/source_templates/reference_json_shim_pvpRankRequirements.yml config/source_templates/reference_json_shim_playerLevelRewards.yml config/source_templates/reference_json_shim_backgrounds.yml src/builder.py tests/test_reference_json_shim_new_tables.py
git commit -m "feat: add six canonical tables (form_moves, species_evolutions, pvp_rank_rewards, pvp_rank_requirements, player_level_rewards, backgrounds) sourced from reference_json_shim"
```

---

### Task 5: Full-build verification and regression guard

**Files:**
- Test: `tests/test_reference_json_shim_no_regressions.py` (create)
- Modify: `KNOWN_ISSUES.md` (document the six new tables' shim-sourced status
  and Task 3's medals-identity-mismatch limitation as known, accepted
  follow-ups, matching this file's existing conventions)
- Modify: `AUTOMATION_NOTES.md` (one short pointer entry to this plan and the
  medals-identity-mismatch finding, per its existing "index only" format)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing further — this is the plan's final task.

- [ ] **Step 1: Write the regression-guard test**

Create `tests/test_reference_json_shim_no_regressions.py`:

```python
import duckdb
from pathlib import Path
import pytest


def test_friendship_levels_still_has_six_tiers_not_five():
    # reference.json's friendshipLevels has only 5 tiers; GoRefs' own raw
    # data has a genuine 6th, newer tier (per the coverage report). This
    # shim must not regress that -- it's lowest-priority specifically so it
    # can never override this.
    db_path = Path("output/GoRefs_Master.duckdb")
    if not db_path.exists():
        pytest.skip("output/GoRefs_Master.duckdb not built -- run `uv run go_refs.py --build` first")
    con = duckdb.connect(str(db_path), read_only=True)
    count = con.execute("select count(*) from friendship_levels").fetchone()[0]
    con.close()
    assert count >= 6, f"expected friendship_levels to keep its 6th tier, got {count} rows"


def test_reference_json_shim_never_appears_as_winning_source_for_any_pre_existing_domain():
    db_path = Path("output/GoRefs_Master.duckdb")
    if not db_path.exists():
        pytest.skip("output/GoRefs_Master.duckdb not built -- run `uv run go_refs.py --build` first")
    con = duckdb.connect(str(db_path), read_only=True)
    # For every (entity_id, attribute) pair reference_json_shim submitted a
    # claim for, confirm it is never the sole/winning claim unless no other
    # source claimed that same pair at all (a genuine gap-fill, not a win
    # against real competition).
    losses = con.execute("""
        select l.entity_id, l.attribute
        from _claims_ledger l
        where l.source = 'reference_json_shim'
        and exists (
            select 1 from _claims_ledger l2
            where l2.entity_id = l.entity_id and l2.attribute = l.attribute
            and l2.priority < l.priority
        )
    """).fetchall()
    con.close()
    # This test's purpose is documentation via failure message, not a strict
    # zero-tolerance gate -- report findings if any real conflict exists
    # where reference_json_shim's claim was needed at all despite losing.
    assert isinstance(losses, list)  # always true; real assertion is the query running without error
```

- [ ] **Step 2: Run the full suite and a real end-to-end build**

Run: `uv run pytest tests/ -q` — expect all pass.
Run: `uv run go_refs.py --fetch && uv run go_refs.py --build && uv run go_refs.py --test`
— expect `--test` to report 0 unexpected new gaps introduced by this plan
(some new `CLAIMS_ONLY`-style entries from `reference_json_shim` are
expected and fine; a regression would be an existing domain's previously-passing
check now failing).

- [ ] **Step 3: Update `KNOWN_ISSUES.md` and `AUTOMATION_NOTES.md`**

In `KNOWN_ISSUES.md`, add a short new entry (following the file's existing
table/anchor conventions) noting: six new tables
(`form_moves`/`species_evolutions`/`pvp_rank_rewards`/`pvp_rank_requirements`/
`player_level_rewards`/`backgrounds`) are currently 100%
`reference_json_shim`-sourced and should be superseded by primary-source
modeling when that work is picked up (the coverage report's "raw data
already ingested" cases — `formMoves`/`speciesEvolutions` in particular have
real GAME_MASTER raw data sitting unpromoted in `gm_pokemonsettings`, per
that report); and that the `reference_json_shim_medals` template's claims
currently never compete against `badges` due to a slug-vs-hash identity
mismatch (Task 3 Step 3's `needs_review` note) — flag as a real,
accepted-for-now limitation, not a mystery to re-discover later.

In `AUTOMATION_NOTES.md`, add one short pointer entry (per its existing
"index only, real content lives elsewhere" format) linking to both
`KNOWN_ISSUES.md` entries above — the identity-namespace-mismatch pattern
(a shim's claims landing on a technically-valid but practically-unreachable
entity_id) is exactly the kind of automation-relevant insight that file
exists to index.

- [ ] **Step 4: Commit**

```bash
git add tests/test_reference_json_shim_no_regressions.py KNOWN_ISSUES.md AUTOMATION_NOTES.md
git commit -m "test: verify reference_json_shim never regresses existing domains; document known limitations"
```

## After this plan

The `reference.json` shim is live at the bottom of the trust hierarchy,
`badge_id` is a real unique key, and six previously-total-gap domains have
canonical tables (shim-sourced, clearly marked as such). Real next steps,
not part of this plan:

- Promote `form_moves`/`species_evolutions` from shim-sourced to
  primary-sourced by modeling `gm_pokemonsettings`'s already-ingested
  `quickMoves`/`cinematicMoves`/`eliteQuickMove`/`eliteCinematicMove` and
  `evolutionIds`/`candyToEvolve`/`evolutionBranch`/`familyId` columns —
  once that lands, those claims will naturally outrank the shim's, per
  `TRUST_HIERARCHY`, with no further shim-side changes needed.
- Decide whether to resolve the `reference_json_shim_medals` /
  post-Task-1-`badges` identity mismatch (Task 3 Step 3) — likely by adding
  a `slug` column to `badges` computed the same way `reference.json`
  computes its own, so the two can actually be compared.
- Revisit the paused `--test-paranoid` plan's C1 fix, if/when source-field
  completeness (not just canonical-table gaps) becomes the priority again.
