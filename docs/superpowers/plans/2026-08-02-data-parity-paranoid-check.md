# Rebuilt `--test-paranoid` (Data Parity Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a genuine field-coverage completeness check (`--test-paranoid`) that determines, for every raw field of every non-`local_authoring` source, whether it's fully modeled (`CANONICAL`), preserved-but-unmodeled (`CLAIMS_ONLY`), or silently dropped (`MISSING`) — using two independent raw-JSON-reading methods cross-checked against each other, so a sampling blind spot in one method can't hide a real gap.

**Architecture:** A new, self-contained module (`src/paranoid_check.py`) with no dependency on `src/engine.py`'s runtime extraction path (per the spec's "a bug in our own extraction code cannot be invisible to both the production path and this check" requirement) — it reads templates only to know which raw fields were *declared* as mapped, and reads raw JSON and the built `.duckdb` independently to check what actually happened. Three tasks: (1) dual-method raw field inventory + template/file enumeration, (2) three-tier classification against the live database, (3) report generation, CLI wiring, and progress bars.

**Tech Stack:** Python, `duckdb` (already a dependency, used for `read_json_auto`), `yaml` (template parsing, already used throughout `src/engine.py`/`src/profiler.py`), `tqdm` (already declared in `pyproject.toml`, not yet used anywhere in this codebase — this is its first real use).

## Global Constraints

- Sources in scope: `pokeapi`, `pogoapi_net`, `pvpoke`, `pokemon_go_api`, `rplus_shiny`, `alexelgt_game_masters`. `local_authoring` is explicitly OUT of scope (its data format is expected to change soon).
- The check makes NO relevance judgments about any field — it reports facts (which tier a field falls into) and nothing else. Never filter, skip, or silently downgrade a finding because a field "seems unimportant."
- **Never run `uv run go_refs.py --test-paranoid` against real `raw_dumps/` data as part of implementing this plan.** Every task's verification uses synthetic fixtures only. The project owner runs the real check themselves once this is built and reviewed.
- A template's filename does NOT reliably indicate its `source_key` (e.g. `config/source_templates/game_master_pokemon_settings.yml` has `source_key: alexelgt_game_masters` inside it, not `game_master_*` as its own source_key). Any code enumerating "all templates belonging to source X" MUST read and check each template's actual `source_key:` field — never glob/match on filename prefix.
- `--test-paranoid` must never run as part of `--build` or `--test` — it is a separate, manually-invoked flag only.
- Progress bars (`tqdm`) are required for both the raw-field-extraction phase and the classification phase, since this plan explicitly requires a full, unsampled scan of every record.

---

### Task 1: Dual-method raw field inventory + template/file enumeration

**Files:**
- Create: `src/paranoid_check.py`
- Test: `tests/test_paranoid_check_inventory.py`

**Interfaces:**
- Produces:
  - `flatten_json_fields(node: Any, prefix: str = "") -> Set[str]` — pure function, no I/O.
  - `extract_fields_python_walk(data_file: Path) -> Set[str]`
  - `extract_fields_duckdb_auto(data_file: Path) -> Set[str]`
  - `find_templates_for_source(source_key: str, templates_dir: Path) -> List[Dict[str, Any]]`
  - `find_raw_files_for_source(source_key: str, raw_dumps_dir: Path) -> List[Path]`
  - `mapped_source_fields(templates: List[Dict[str, Any]]) -> Dict[str, Set[str]]` — keyed by endpoint name (e.g. `"badges"`, `"GAME_MASTER"`), each value the set of every `source_field` path declared in that endpoint's template(s) `field_mappings` + `overrides` combined.

Later tasks consume all five functions and the dict shape above by these exact names.

- [ ] **Step 1: Write the failing tests for `flatten_json_fields`**

```python
# tests/test_paranoid_check_inventory.py
from src.paranoid_check import flatten_json_fields


def test_flatten_flat_dict():
    assert flatten_json_fields({"name": "Bulbasaur", "id": 1}) == {"name", "id"}


def test_flatten_nested_dict():
    record = {"names": {"English": "Bulbasaur", "Japanese": "Fushigidane"}}
    assert flatten_json_fields(record) == {"names", "names.English", "names.Japanese"}


def test_flatten_list_of_dicts_walks_every_item_and_unions_their_fields():
    # Different items in the same list can have different keys (e.g. GAME_MASTER's
    # heterogeneous assetForms) -- flattening must union across ALL items, not just
    # inspect the first one, since a field appearing only on a later item would
    # otherwise be silently missed.
    record = {"assetForms": [{"form": "NORMAL"}, {"form": "FEMALE", "isFemale": True}]}
    assert flatten_json_fields(record) == {
        "assetForms", "assetForms.form", "assetForms.isFemale"
    }


def test_flatten_deeply_nested_mixed_dict_and_list():
    record = {"data": {"combatMove": {"buffs": {"targetDefenseStatStageChange": -1}}}}
    assert flatten_json_fields(record) == {
        "data", "data.combatMove", "data.combatMove.buffs",
        "data.combatMove.buffs.targetDefenseStatStageChange",
    }


def test_flatten_ignores_scalar_list_items():
    # A list of plain strings/numbers (not dicts) has nothing further to flatten
    # into -- the field itself is still reported, just not descended into.
    record = {"targets": [1, 10, 50, 100]}
    assert flatten_json_fields(record) == {"targets"}


def test_flatten_empty_dict_returns_empty_set():
    assert flatten_json_fields({}) == set()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_paranoid_check_inventory.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.paranoid_check'`

- [ ] **Step 3: Implement `flatten_json_fields`**

```python
# src/paranoid_check.py
"""Rebuilt --test-paranoid: an engine-bypassing, dual-method field-coverage
completeness check. Determines, for every raw field of every in-scope source,
whether it reaches a canonical table column (CANONICAL), reaches only
_claims_ledger or a raw-passthrough table (CLAIMS_ONLY), or appears nowhere in
the built database at all (MISSING). Makes no relevance judgments -- reports
facts for a human to triage afterward.

Deliberately does not import anything from src/engine.py: a bug in that
module's own extraction logic must not be able to hide from this check by
also being present in this check's own code path.
"""
from pathlib import Path
from typing import Any, Dict, List, Set

import duckdb
import yaml


def flatten_json_fields(node: Any, prefix: str = "") -> Set[str]:
    """Recursively flattens a JSON-shaped value into a set of dotted field paths.

    Descends into dicts (each key becomes prefix.key) and into every item of a
    list-of-dicts (unioning fields across ALL items, not just the first, since
    real sources like GAME_MASTER's assetForms have heterogeneous item shapes).
    A list of non-dict scalars is reported as its own path but not descended
    into further -- there's nothing to flatten inside a plain string/number.

    Args:
        node: A dict, list, or scalar value to flatten.
        prefix: The dotted path accumulated so far (empty string at the root).

    Returns:
        Set of every dotted field path found, including intermediate container
        paths (e.g. both "names" and "names.English").
    """
    paths: Set[str] = set()

    if isinstance(node, dict):
        for key, value in node.items():
            child_path = f"{prefix}.{key}" if prefix else key
            paths.add(child_path)
            paths |= flatten_json_fields(value, child_path)

    elif isinstance(node, list):
        for item in node:
            if isinstance(item, dict):
                paths |= flatten_json_fields(item, prefix)

    return paths
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_paranoid_check_inventory.py -v`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/paranoid_check.py tests/test_paranoid_check_inventory.py
git commit -m "feat: add flatten_json_fields for paranoid-check field flattening"
```

- [ ] **Step 6: Write the failing tests for the two extraction methods**

Append to `tests/test_paranoid_check_inventory.py`:

```python
import json
import duckdb
from src.paranoid_check import extract_fields_python_walk, extract_fields_duckdb_auto


def test_python_walk_finds_every_field_across_all_records(tmp_path):
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps([
        {"id": 1, "name": "Bulbasaur"},
        {"id": 2, "name": "Ivysaur", "rareField": "only on this record"},
    ]))
    fields = extract_fields_python_walk(data_file)
    assert fields == {"id", "name", "rareField"}


def test_python_walk_handles_dict_of_lists_payload(tmp_path):
    # e.g. raid_bosses' {"currentList": {"lvl5": [...], "lvl1": [...]}} shape --
    # the walk must find fields regardless of top-level container shape, since
    # it isn't using unwrap_path/iterate_mode at all (unlike src/engine.py).
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps({
        "currentList": {"lvl5": [{"pokemonId": 383}], "lvl1": [{"pokemonId": 1, "shiny": True}]}
    }))
    fields = extract_fields_python_walk(data_file)
    assert "currentList.lvl5.pokemonId" in fields
    assert "currentList.lvl1.shiny" in fields


def test_duckdb_auto_finds_top_level_and_nested_fields(tmp_path):
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps([
        {"id": 1, "names": {"English": "Bulbasaur"}},
        {"id": 2, "names": {"English": "Ivysaur"}},
    ]))
    fields = extract_fields_duckdb_auto(data_file)
    assert "id" in fields
    assert "names" in fields
    assert "names.English" in fields
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `uv run pytest tests/test_paranoid_check_inventory.py -v`
Expected: FAIL — `ImportError: cannot import name 'extract_fields_python_walk'`

- [ ] **Step 8: Implement both extraction methods**

Append to `src/paranoid_check.py`:

```python
import json


def extract_fields_python_walk(data_file: Path) -> Set[str]:
    """Method B: plain json.load + flatten_json_fields over EVERY record,
    unconditionally -- no sampling. Handles any top-level shape (list, dict,
    or a dict-of-lists container) by flattening the whole payload as one tree;
    flatten_json_fields already unions across every list item at every level,
    so this naturally covers records nested inside a dict-of-lists container
    too, without needing to know the source's specific unwrap/iterate shape.
    """
    with open(data_file, "r", encoding="utf-8") as f:
        payload = json.load(f)
    return flatten_json_fields(payload)


def extract_fields_duckdb_auto(data_file: Path) -> Set[str]:
    """Method A: DuckDB's read_json_auto, which infers schema via SAMPLING
    (not a full scan) -- this is exactly the blind spot Method B exists to
    catch. Flattens DuckDB's inferred STRUCT/LIST column types into the same
    dotted-path convention as flatten_json_fields for direct comparison.
    """
    con = duckdb.connect(":memory:")
    try:
        con.execute(
            "CREATE TABLE _pc AS SELECT * FROM read_json_auto(?, format='auto')",
            [str(data_file)],
        )
        schema_rows = con.execute("DESCRIBE _pc").fetchall()
    finally:
        con.close()

    fields: Set[str] = set()

    def walk_type(column_path: str, duckdb_type: str) -> None:
        fields.add(column_path)
        inner = duckdb_type
        # Unwrap one or more LIST[...] wrappers -- read_json_auto reports a
        # list-of-structs column as e.g. "STRUCT(a INTEGER, b VARCHAR)[]".
        while inner.endswith("[]"):
            inner = inner[:-2].strip()
        if inner.upper().startswith("STRUCT(") and inner.endswith(")"):
            inner_body = inner[len("STRUCT("):-1]
            for field_decl in _split_top_level_commas(inner_body):
                field_decl = field_decl.strip()
                if not field_decl:
                    continue
                # Field declarations look like `"names" STRUCT(...)` or
                # `id BIGINT` -- name is the first whitespace-separated token,
                # optionally quoted.
                name_part, _, type_part = field_decl.partition(" ")
                name_part = name_part.strip('"')
                walk_type(f"{column_path}.{name_part}", type_part.strip())

    for col_name, col_type, *_ in schema_rows:
        walk_type(col_name, col_type)

    return fields


def _split_top_level_commas(s: str) -> List[str]:
    """Splits a STRUCT(...) body on commas that aren't nested inside another
    STRUCT(...)/LIST[...]'s own parens -- a plain str.split(",") would
    incorrectly split "a STRUCT(x INT, y INT), b VARCHAR" in the middle of
    the nested struct.
    """
    parts: List[str] = []
    depth = 0
    current = ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    if current:
        parts.append(current)
    return parts
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `uv run pytest tests/test_paranoid_check_inventory.py -v`
Expected: PASS (all 8 tests so far)

- [ ] **Step 10: Commit**

```bash
git add src/paranoid_check.py tests/test_paranoid_check_inventory.py
git commit -m "feat: add dual-method (duckdb + python) raw field extraction to paranoid-check"
```

- [ ] **Step 11: Write the failing tests for template/file enumeration**

Append to `tests/test_paranoid_check_inventory.py`:

```python
import yaml
from src.paranoid_check import find_templates_for_source, find_raw_files_for_source, mapped_source_fields


def test_find_templates_for_source_reads_source_key_field_not_filename(tmp_path):
    # Regression guard for the documented footgun: a template's filename does
    # NOT reliably match its source_key (e.g. game_master_*.yml files declare
    # source_key: alexelgt_game_masters internally).
    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True)
    (templates_dir / "weirdly_named_file.yml").write_text(yaml.dump({
        "source_key": "pogoapi_net", "endpoint": "badges",
        "field_mappings": {"name": {"source_field": "name", "transform": "direct"}},
    }))
    (templates_dir / "other_source.yml").write_text(yaml.dump({
        "source_key": "pokeapi", "endpoint": "pokemon",
        "field_mappings": {},
    }))

    result = find_templates_for_source("pogoapi_net", templates_dir)

    assert len(result) == 1
    assert result[0]["endpoint"] == "badges"


def test_find_raw_files_for_source_excludes_meta_json(tmp_path):
    raw_dumps_dir = tmp_path / "raw_dumps"
    snapshot_dir = raw_dumps_dir / "pogoapi_net" / "2026-01-01T000000Z"
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "badges.json").write_text("[]")
    (snapshot_dir / "cp_multiplier.json").write_text("[]")
    (snapshot_dir / ".meta.json").write_text("{}")

    result = find_raw_files_for_source("pogoapi_net", raw_dumps_dir)

    assert {f.name for f in result} == {"badges.json", "cp_multiplier.json"}


def test_find_raw_files_for_source_uses_latest_snapshot_only(tmp_path):
    raw_dumps_dir = tmp_path / "raw_dumps"
    old_dir = raw_dumps_dir / "pogoapi_net" / "2026-01-01T000000Z"
    new_dir = raw_dumps_dir / "pogoapi_net" / "2026-06-01T000000Z"
    old_dir.mkdir(parents=True)
    new_dir.mkdir(parents=True)
    (old_dir / "badges.json").write_text("[]")
    (new_dir / "badges.json").write_text("[]")
    (new_dir / "cp_multiplier.json").write_text("[]")

    result = find_raw_files_for_source("pogoapi_net", raw_dumps_dir)

    assert {f.name for f in result} == {"badges.json", "cp_multiplier.json"}
    assert all(f.parent == new_dir for f in result)


def test_mapped_source_fields_combines_field_mappings_and_overrides_per_endpoint():
    templates = [
        {
            "source_key": "pogoapi_net", "endpoint": "badges",
            "field_mappings": {"name": {"source_field": "name", "transform": "direct"}},
            "overrides": {"description": {"source_field": "description", "transform": "direct"}},
        },
        {
            "source_key": "pogoapi_net", "endpoint": "cp_multiplier",
            "field_mappings": {"level": {"source_field": "level", "transform": "direct"}},
        },
    ]

    result = mapped_source_fields(templates)

    assert result["badges"] == {"name", "description"}
    assert result["cp_multiplier"] == {"level"}
```

- [ ] **Step 12: Run tests to verify they fail**

Run: `uv run pytest tests/test_paranoid_check_inventory.py -v`
Expected: FAIL — `ImportError: cannot import name 'find_templates_for_source'`

- [ ] **Step 13: Implement template/file enumeration**

Append to `src/paranoid_check.py`:

```python
def find_templates_for_source(source_key: str, templates_dir: Path) -> List[Dict[str, Any]]:
    """Finds every template belonging to source_key by reading each YAML
    file's own source_key field -- NEVER by matching on filename, since
    filenames don't reliably reflect source_key (e.g. game_master_*.yml
    files declare source_key: alexelgt_game_masters internally).
    """
    matching: List[Dict[str, Any]] = []
    if not templates_dir.exists():
        return matching
    for template_path in sorted(templates_dir.glob("*.yml")):
        with open(template_path, "r", encoding="utf-8") as f:
            template = yaml.safe_load(f)
        if template and template.get("source_key") == source_key:
            matching.append(template)
    return matching


def find_raw_files_for_source(source_key: str, raw_dumps_dir: Path) -> List[Path]:
    """Lists every raw data file (excluding .meta.json) in a source's latest
    timestamped snapshot directory.
    """
    source_dir = raw_dumps_dir / source_key
    if not source_dir.exists():
        return []
    snapshots = sorted([d for d in source_dir.iterdir() if d.is_dir()])
    if not snapshots:
        return []
    latest = snapshots[-1]
    return sorted(f for f in latest.glob("*.json") if f.name != ".meta.json")


def mapped_source_fields(templates: List[Dict[str, Any]]) -> Dict[str, Set[str]]:
    """For each template, collects every source_field path declared in its
    field_mappings + overrides (overrides included since both represent a
    conscious mapping decision -- this function doesn't care which one wins
    at claim-resolution time, only whether the raw field was decided about
    at all). Keyed by endpoint name so a source with multiple endpoint
    templates (e.g. pogoapi_net) gets a separate mapped-field set per file.
    """
    result: Dict[str, Set[str]] = {}
    for template in templates:
        endpoint = template.get("endpoint", template.get("source_key"))
        mappings = dict(template.get("field_mappings", {}))
        mappings.update(template.get("overrides", {}))
        fields = {
            mapping["source_field"]
            for mapping in mappings.values()
            if mapping.get("source_field")
        }
        result.setdefault(endpoint, set())
        result[endpoint] |= fields
    return result
```

- [ ] **Step 14: Run tests to verify they pass**

Run: `uv run pytest tests/test_paranoid_check_inventory.py -v`
Expected: PASS (all 12 tests)

- [ ] **Step 15: Commit**

```bash
git add src/paranoid_check.py tests/test_paranoid_check_inventory.py
git commit -m "feat: add template/raw-file enumeration to paranoid-check"
```

---

### Task 2: Three-tier classification + method-mismatch detection

**Files:**
- Modify: `src/paranoid_check.py`
- Test: `tests/test_paranoid_check_classification.py`

**Interfaces:**
- Consumes: `flatten_json_fields`, `extract_fields_python_walk`, `extract_fields_duckdb_auto`, `find_templates_for_source`, `find_raw_files_for_source`, `mapped_source_fields` (Task 1, exact names above).
- Produces:
  - `canonical_attribute_names(db_path: Path) -> Set[str]` — every column name across every canonical domain table (excludes `_claims_ledger`, `discrepancies`, `change_history`, `game_master_templates` — meta/passthrough tables, not domain tables).
  - `claims_ledger_attributes(db_path: Path, source_key: str) -> Set[str]` — every distinct `attribute` value `_claims_ledger` holds for claims from `source_key`.
  - `classify_endpoint_fields(endpoint: str, python_fields: Set[str], mapped_fields: Set[str], canonical_attrs: Set[str], claims_attrs: Set[str]) -> Dict[str, List[str]]` — pure function, returns `{"MISSING": [...], "CLAIMS_ONLY": [...], "CANONICAL": [...]}` for one endpoint's fields.
  - `find_method_mismatches(python_fields: Set[str], duckdb_fields: Set[str]) -> List[str]` — fields found by the Python walk but missed by DuckDB's sampled auto-inference (the direction that matters: a field DuckDB found but Python didn't would mean a bug in `flatten_json_fields` itself, not a real finding — Python's walk is unconditional/unsampled by construction, so it is the ground truth to compare DuckDB against, not the other way around).

Later tasks (Task 3) consume all of these by these exact names.

- [ ] **Step 1: Write the failing tests for canonical/claims-ledger introspection**

```python
# tests/test_paranoid_check_classification.py
import duckdb
from pathlib import Path
from src.paranoid_check import canonical_attribute_names, claims_ledger_attributes


def _make_test_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INTEGER, name VARCHAR, base_attack INTEGER)")
    con.execute("CREATE TABLE badges (badge_id VARCHAR, is_event_badge BOOLEAN)")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INTEGER)")
    con.execute("CREATE TABLE discrepancies (entity_id VARCHAR, attribute VARCHAR)")
    con.execute("CREATE TABLE game_master_templates (templateId VARCHAR, data VARCHAR)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'base_attack', 'pogoapi_net', '118', 6)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'flavor_text', 'pokeapi', 'A strange seed...', 5)")
    con.close()
    return db_path


def test_canonical_attribute_names_excludes_meta_tables(tmp_path):
    db_path = _make_test_db(tmp_path)
    names = canonical_attribute_names(db_path)
    assert "base_attack" in names
    assert "is_event_badge" in names
    assert "entity_id" not in names  # would only appear if _claims_ledger wasn't excluded
    assert "templateId" not in names  # game_master_templates excluded


def test_claims_ledger_attributes_filters_by_source(tmp_path):
    db_path = _make_test_db(tmp_path)
    attrs = claims_ledger_attributes(db_path, "pogoapi_net")
    assert attrs == {"base_attack"}
    attrs_pokeapi = claims_ledger_attributes(db_path, "pokeapi")
    assert attrs_pokeapi == {"flavor_text"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_paranoid_check_classification.py -v`
Expected: FAIL — `ImportError: cannot import name 'canonical_attribute_names'`

- [ ] **Step 3: Implement canonical/claims-ledger introspection**

Append to `src/paranoid_check.py`:

```python
_META_TABLES = {"_claims_ledger", "discrepancies", "change_history", "game_master_templates"}


def canonical_attribute_names(db_path: Path) -> Set[str]:
    """Every column name across every canonical domain table -- deliberately
    excludes meta/passthrough tables (_claims_ledger, discrepancies,
    change_history, game_master_templates) since a field merely existing in
    one of those doesn't mean it was promoted into a real, modeled domain
    column. This is a name-based heuristic (matching attribute names, not
    tracing individual values end-to-end) -- sufficient for triage, not a
    guaranteed-precise value trace. A human reviewing MISSING/CLAIMS_ONLY
    findings is expected to verify the specific case, same as this project's
    existing --test suite's own documented "unmapped is not verified"
    caveat (see KNOWN_ISSUES.md).
    """
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        tables = [
            r[0] for r in con.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
            ).fetchall()
            if r[0] not in _META_TABLES
        ]
        names: Set[str] = set()
        for table in tables:
            cols = con.execute(f'DESCRIBE "{table}"').fetchall()
            names |= {c[0] for c in cols}
        return names
    finally:
        con.close()


def claims_ledger_attributes(db_path: Path, source_key: str) -> Set[str]:
    """Every distinct attribute name _claims_ledger holds a claim for, from
    the given source.
    """
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute(
            "SELECT DISTINCT attribute FROM _claims_ledger WHERE source = ?", [source_key]
        ).fetchall()
        return {r[0] for r in rows}
    finally:
        con.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_paranoid_check_classification.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/paranoid_check.py tests/test_paranoid_check_classification.py
git commit -m "feat: add canonical/claims-ledger attribute introspection to paranoid-check"
```

- [ ] **Step 6: Write the failing tests for classification and method-mismatch**

Append to `tests/test_paranoid_check_classification.py`:

```python
from src.paranoid_check import classify_endpoint_fields, find_method_mismatches


def test_classify_endpoint_fields_three_tiers():
    python_fields = {"name", "base_attack", "internal_debug_id"}
    mapped_fields = {"name", "base_attack"}  # internal_debug_id was never mapped
    canonical_attrs = {"name"}  # base_attack didn't make it to a domain column in this test db
    claims_attrs = {"base_attack"}  # but it IS in _claims_ledger

    result = classify_endpoint_fields("badges", python_fields, mapped_fields, canonical_attrs, claims_attrs)

    assert result["CANONICAL"] == ["name"]
    assert result["CLAIMS_ONLY"] == ["base_attack"]
    assert result["MISSING"] == ["internal_debug_id"]


def test_classify_endpoint_fields_mapped_but_absent_from_both_is_still_missing():
    # A field can be declared in field_mappings yet still never actually reach
    # _claims_ledger or canonical (e.g. a typo'd source_field, or a record
    # missing the field on every instance sampled at claim-emission time) --
    # "mapped" alone doesn't guarantee the data actually made it through.
    python_fields = {"typo_field"}
    mapped_fields = {"typo_field"}
    canonical_attrs: set = set()
    claims_attrs: set = set()

    result = classify_endpoint_fields("badges", python_fields, mapped_fields, canonical_attrs, claims_attrs)

    assert result["MISSING"] == ["typo_field"]


def test_find_method_mismatches_reports_python_only_fields():
    python_fields = {"name", "rareField", "form.costume"}
    duckdb_fields = {"name", "form.costume"}  # DuckDB's sampling missed rareField

    result = find_method_mismatches(python_fields, duckdb_fields)

    assert result == ["rareField"]


def test_find_method_mismatches_empty_when_methods_agree():
    fields = {"name", "id"}
    assert find_method_mismatches(fields, fields) == []
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `uv run pytest tests/test_paranoid_check_classification.py -v`
Expected: FAIL — `ImportError: cannot import name 'classify_endpoint_fields'`

- [ ] **Step 8: Implement classification and method-mismatch detection**

Append to `src/paranoid_check.py`:

```python
def classify_endpoint_fields(
    endpoint: str,
    python_fields: Set[str],
    mapped_fields: Set[str],
    canonical_attrs: Set[str],
    claims_attrs: Set[str],
) -> Dict[str, List[str]]:
    """Classifies every raw field found by the (unsampled) Python walk into
    exactly one tier. A field is CANONICAL only if it's both mapped AND its
    attribute name reaches a real domain-table column; CLAIMS_ONLY if mapped
    and reaches _claims_ledger but not a domain column; MISSING otherwise --
    including a field that IS in mapped_fields but never actually reached
    either _claims_ledger or canonical (a real, if rarer, failure mode: the
    mapping is declared but the data never made it through, e.g. a typo'd
    source_field or a record where the field was always absent).
    """
    result: Dict[str, List[str]] = {"CANONICAL": [], "CLAIMS_ONLY": [], "MISSING": []}
    for field in sorted(python_fields):
        if field in mapped_fields and field in canonical_attrs:
            result["CANONICAL"].append(field)
        elif field in mapped_fields and field in claims_attrs:
            result["CLAIMS_ONLY"].append(field)
        else:
            result["MISSING"].append(field)
    return result


def find_method_mismatches(python_fields: Set[str], duckdb_fields: Set[str]) -> List[str]:
    """Fields the unsampled Python walk found that DuckDB's sampled
    read_json_auto missed -- the direction that matters, since Python's walk
    processes every record unconditionally and is the ground truth here.
    """
    return sorted(python_fields - duckdb_fields)
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `uv run pytest tests/test_paranoid_check_classification.py -v`
Expected: PASS (4 tests)

- [ ] **Step 10: Commit**

```bash
git add src/paranoid_check.py tests/test_paranoid_check_classification.py
git commit -m "feat: add three-tier classification and method-mismatch detection to paranoid-check"
```

---

### Task 3: Report generation, `run_paranoid_check()` orchestration, CLI wiring, progress bars

**Files:**
- Modify: `src/paranoid_check.py`
- Modify: `go_refs.py:284-330` (the `main()` function's argparse setup and dispatch block)
- Test: `tests/test_paranoid_check_report.py`

**Interfaces:**
- Consumes: every function from Tasks 1 and 2 (exact names above).
- Produces: `run_paranoid_check(db_path: Path, raw_dumps_dir: Path, templates_dir: Path, sources: Optional[List[str]] = None) -> Dict[str, Any]`, invoked by `uv run go_refs.py --test-paranoid [--source SOURCE_KEY]`.

- [ ] **Step 1: Write the failing test for the full orchestration**

```python
# tests/test_paranoid_check_report.py
import json
import yaml
import duckdb
from pathlib import Path
from src.paranoid_check import run_paranoid_check


def _build_fixture_source(tmp_path: Path, source_key: str, endpoint: str, records: list, field_mappings: dict):
    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True, exist_ok=True)
    (templates_dir / f"{source_key}_{endpoint}.yml").write_text(yaml.dump({
        "source_key": source_key, "endpoint": endpoint,
        "field_mappings": field_mappings,
    }))
    raw_dir = tmp_path / "raw_dumps" / source_key / "2026-01-01T000000Z"
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / f"{endpoint}.json").write_text(json.dumps(records))
    return templates_dir


def test_run_paranoid_check_full_report_across_tiers_and_sources(tmp_path):
    templates_dir = _build_fixture_source(
        tmp_path, "fixture_source", "data",
        records=[
            {"id": 1, "name": "Bulbasaur", "internal_debug_id": "xyz123"},
            {"id": 2, "name": "Ivysaur", "internal_debug_id": "abc456"},
        ],
        field_mappings={
            "name": {"source_field": "name", "transform": "direct"},
            "id": {"source_field": "id", "transform": "direct"},
        },
    )

    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (id INTEGER, name VARCHAR)")  # 'name' promoted to canonical
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INTEGER)")
    con.execute("INSERT INTO _claims_ledger VALUES ('fixture_source_1', 'name', 'fixture_source', 'Bulbasaur', 1)")
    con.execute("INSERT INTO _claims_ledger VALUES ('fixture_source_1', 'id', 'fixture_source', '1', 1)")  # mapped+claimed but never promoted
    con.close()

    report = run_paranoid_check(
        db_path=db_path,
        raw_dumps_dir=tmp_path / "raw_dumps",
        templates_dir=templates_dir,
        sources=["fixture_source"],
    )

    source_report = report["sources"]["fixture_source"]
    endpoint_report = source_report["endpoints"]["data"]
    assert "name" in endpoint_report["CANONICAL"]
    assert "id" in endpoint_report["CLAIMS_ONLY"]
    assert "internal_debug_id" in endpoint_report["MISSING"]
    assert report["summary"]["fixture_source"]["MISSING"] == 1
    assert report["summary"]["fixture_source"]["CLAIMS_ONLY"] == 1
    assert report["summary"]["fixture_source"]["CANONICAL"] == 1


def test_run_paranoid_check_flags_endpoint_with_no_template_at_all(tmp_path):
    # A raw data file that no template covers at all -- every one of its
    # fields is trivially MISSING, since nothing has ever decided anything
    # about them. This is a real, distinct failure mode from "field within a
    # templated file that itself wasn't mapped."
    raw_dir = tmp_path / "raw_dumps" / "fixture_source" / "2026-01-01T000000Z"
    raw_dir.mkdir(parents=True)
    (raw_dir / "untemplated_endpoint.json").write_text(json.dumps([{"weirdField": "value"}]))

    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True)  # empty -- no templates for this source at all

    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INTEGER)")
    con.close()

    report = run_paranoid_check(
        db_path=db_path,
        raw_dumps_dir=tmp_path / "raw_dumps",
        templates_dir=templates_dir,
        sources=["fixture_source"],
    )

    endpoint_report = report["sources"]["fixture_source"]["endpoints"]["untemplated_endpoint"]
    assert "weirdField" in endpoint_report["MISSING"]
    assert report["sources"]["fixture_source"]["untemplated_endpoints"] == ["untemplated_endpoint"]


def test_run_paranoid_check_never_includes_local_authoring_by_default():
    # local_authoring is out of scope per this plan's Global Constraints --
    # confirm the default source list (sources=None) never includes it.
    from src.paranoid_check import DEFAULT_PARANOID_SOURCES
    assert "local_authoring" not in DEFAULT_PARANOID_SOURCES
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_paranoid_check_report.py -v`
Expected: FAIL — `ImportError: cannot import name 'run_paranoid_check'`

- [ ] **Step 3: Implement `run_paranoid_check` and report writing**

Append to `src/paranoid_check.py`:

```python
from tqdm import tqdm

DEFAULT_PARANOID_SOURCES = [
    "pokeapi", "pogoapi_net", "pvpoke", "pokemon_go_api", "rplus_shiny", "alexelgt_game_masters",
]


def run_paranoid_check(
    db_path: Path,
    raw_dumps_dir: Path,
    templates_dir: Path,
    sources: "Optional[List[str]]" = None,
) -> Dict[str, Any]:
    """Runs the full dual-method field-coverage check across the given
    sources (defaults to every in-scope source, never local_authoring).

    Returns a dict:
        {
          "sources": {
            source_key: {
              "endpoints": {endpoint: {"CANONICAL": [...], "CLAIMS_ONLY": [...], "MISSING": [...]}},
              "untemplated_endpoints": [endpoint_names_with_no_template_at_all],
              "method_mismatches": {endpoint: [field, ...]},
            },
          },
          "summary": {source_key: {"CANONICAL": n, "CLAIMS_ONLY": n, "MISSING": n}},
        }
    """
    target_sources = sources if sources is not None else DEFAULT_PARANOID_SOURCES
    report: Dict[str, Any] = {"sources": {}, "summary": {}}

    for source_key in tqdm(target_sources, desc="Sources"):
        templates = find_templates_for_source(source_key, templates_dir)
        mapped_by_endpoint = mapped_source_fields(templates)
        canonical_attrs = canonical_attribute_names(db_path)
        claims_attrs = claims_ledger_attributes(db_path, source_key)

        raw_files = find_raw_files_for_source(source_key, raw_dumps_dir)
        endpoints_report: Dict[str, Dict[str, List[str]]] = {}
        untemplated_endpoints: List[str] = []
        method_mismatches: Dict[str, List[str]] = {}
        counts = {"CANONICAL": 0, "CLAIMS_ONLY": 0, "MISSING": 0}

        for data_file in tqdm(raw_files, desc=f"{source_key} endpoints", leave=False):
            endpoint = data_file.stem
            mapped_fields = mapped_by_endpoint.get(endpoint, set())
            if endpoint not in mapped_by_endpoint:
                untemplated_endpoints.append(endpoint)

            python_fields = extract_fields_python_walk(data_file)
            duckdb_fields = extract_fields_duckdb_auto(data_file)

            classification = classify_endpoint_fields(
                endpoint, python_fields, mapped_fields, canonical_attrs, claims_attrs
            )
            endpoints_report[endpoint] = classification
            for tier, fields in classification.items():
                counts[tier] += len(fields)

            mismatches = find_method_mismatches(python_fields, duckdb_fields)
            if mismatches:
                method_mismatches[endpoint] = mismatches

        report["sources"][source_key] = {
            "endpoints": endpoints_report,
            "untemplated_endpoints": untemplated_endpoints,
            "method_mismatches": method_mismatches,
        }
        report["summary"][source_key] = counts

    return report


def render_paranoid_report_markdown(report: Dict[str, Any]) -> str:
    """Renders run_paranoid_check()'s dict into a markdown report. Only
    MISSING and CLAIMS_ONLY fields are listed per endpoint -- CANONICAL
    fields are working as intended and would just be noise; the summary
    table still shows their count for context.
    """
    lines = ["# Paranoid Field-Coverage Report", ""]
    lines.append("| Source | CANONICAL | CLAIMS_ONLY | MISSING |")
    lines.append("|---|---|---|---|")
    for source_key, counts in report["summary"].items():
        lines.append(f"| `{source_key}` | {counts['CANONICAL']} | {counts['CLAIMS_ONLY']} | {counts['MISSING']} |")
    lines.append("")

    for source_key, source_data in report["sources"].items():
        lines.append(f"## `{source_key}`")
        lines.append("")
        if source_data["untemplated_endpoints"]:
            lines.append(f"**Untemplated endpoints (no template covers these files at all):** " + ", ".join(f"`{e}`" for e in source_data["untemplated_endpoints"]))
            lines.append("")
        for endpoint, classification in source_data["endpoints"].items():
            if not classification["MISSING"] and not classification["CLAIMS_ONLY"]:
                continue
            lines.append(f"### `{endpoint}`")
            if classification["MISSING"]:
                lines.append(f"- **MISSING**: " + ", ".join(f"`{f}`" for f in classification["MISSING"]))
            if classification["CLAIMS_ONLY"]:
                lines.append(f"- **CLAIMS_ONLY**: " + ", ".join(f"`{f}`" for f in classification["CLAIMS_ONLY"]))
            lines.append("")
        if source_data["method_mismatches"]:
            lines.append("**Method mismatches** (Python walk found, DuckDB's sampled read_json_auto missed):")
            for endpoint, fields in source_data["method_mismatches"].items():
                lines.append(f"- `{endpoint}`: " + ", ".join(f"`{f}`" for f in fields))
            lines.append("")

    return "\n".join(lines)
```

Add `Optional` to the existing `from typing import ...` import line at the top of `src/paranoid_check.py` (it currently imports `Any, Dict, List, Set` only — add `Optional` to that same line).

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_paranoid_check_report.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the CLI flag in `go_refs.py`**

Modify `go_refs.py`. Add this function near `run_source_coverage_test()` (around line 146):

```python
def run_paranoid_check_cli(source: "Optional[str]" = None) -> None:
    """CLI entrypoint for --test-paranoid. Writes output/paranoid_check_report.md
    and prints a one-line summary per source.
    """
    from src.paranoid_check import run_paranoid_check, render_paranoid_report_markdown

    sources = [source] if source else None
    report = run_paranoid_check(
        db_path=Path("output/GoRefs_Master.duckdb"),
        raw_dumps_dir=Path("raw_dumps"),
        templates_dir=Path("config/source_templates"),
        sources=sources,
    )

    markdown = render_paranoid_report_markdown(report)
    output_path = Path("output/paranoid_check_report.md")
    output_path.write_text(markdown, encoding="utf-8")

    print(f"\nParanoid check complete. Report written to {output_path}")
    for source_key, counts in report["summary"].items():
        print(f"  {source_key}: {counts['CANONICAL']} canonical, {counts['CLAIMS_ONLY']} claims-only, {counts['MISSING']} missing")
```

Add `Optional` to `go_refs.py`'s existing typing import if it doesn't already import it (check the top of the file first — if `from typing import Optional` or similar isn't already present, add it).

In `main()`, add the new flag next to the existing `--deep-dive` argument (around line 302):

```python
    parser.add_argument("--test-paranoid", action="store_true", help="Run the slow, exhaustive dual-method field-coverage check (never part of --build/--test; local_authoring excluded)")
    parser.add_argument("--source", default=None, help="Restrict --test-paranoid to a single source_key (default: all in-scope sources)")
```

Update the `if not any([...])` guard (around line 307) to include `args.test_paranoid`:

```python
    if not any([args.fetch, args.build, args.docs, args.test, args.serve, args.all, args.deep_dive, args.test_paranoid]):
        print("No action specified. Usage: uv run go_refs.py [--fetch] [--build] [--docs] [--test] [--serve] [--all] [--deep-dive [SOURCE]] [--test-paranoid] [--source SOURCE_KEY] [--port PORT] [--config PATH]")
        sys.exit(0)
```

Add the dispatch call after the existing `if args.deep_dive:` block (around line 328):

```python
    if args.test_paranoid:
        run_paranoid_check_cli(source=args.source)
```

- [ ] **Step 6: Verify the CLI wiring imports correctly**

Run: `uv run python3 -c "import go_refs"`
Expected: no import errors.

Run: `uv run go_refs.py --help`
Expected: help text includes `--test-paranoid` and `--source`.

**Do NOT run `uv run go_refs.py --test-paranoid` against the real `raw_dumps/` directory** — that real run is the project owner's to execute, not part of this task's verification.

- [ ] **Step 7: Run the full test suite**

Run: `uv run pytest tests/ -q`
Expected: all tests pass, including every `test_paranoid_check_*.py` file from Tasks 1-3 plus every pre-existing test in the project (should remain at whatever count Task 24 left it at, plus the new tests from this plan).

- [ ] **Step 8: Create `AUTOMATION_NOTES.md`**

Per the design spec's component 4: a new, permanent pointer file, created now (empty of real findings — this plan doesn't do the source-by-source override pass that would populate it) so it exists and is ready for the follow-up plan.

Create `AUTOMATION_NOTES.md` at the repo root:

```markdown
# Automation Notes

A curated index of insights that would make future automated
source-onboarding easier — written so a much-later return to this project
can find them fast without re-deriving anything.

**This file holds only short pointers, never the real writeup.** Each entry
is 1-3 sentences (what was noticed, why it matters for automation) plus a
link to the actual detailed content in `KNOWN_ISSUES.md` or `TODO.md` —
whichever it substantively belongs to by its own established topic. Add an
entry here whenever the source-by-source override pass (or any future work)
turns up something relevant; don't let this file's own content grow beyond
a blurb-and-link per entry.

## Entries

_(none yet — populated during the source-by-source override pass that
follows the first real `--test-paranoid` run)_
```

- [ ] **Step 9: Commit**

```bash
git add src/paranoid_check.py go_refs.py tests/test_paranoid_check_report.py AUTOMATION_NOTES.md
git commit -m "feat: add run_paranoid_check orchestration, report rendering, --test-paranoid CLI flag, and AUTOMATION_NOTES.md"
```

---

---

### Task 4: Harden `extract_fields_duckdb_auto` against real DuckDB failure modes

**Not in the original plan — added after Task 3's review flagged a real test-coverage gap, which investigation showed was actually two real bugs.** Empirical testing against real DuckDB behavior (not assumed) found the design spec's premise was subtly wrong in its explanatory prose, but the underlying dual-method cross-check concept is sound and unaffected — only `extract_fields_duckdb_auto`'s robustness needs fixing:

1. **DuckDB's `read_json_auto` does NOT silently miss rare fields via sampling as the design spec's prose claimed.** Empirically confirmed: a top-level JSON array where a key appears only after DuckDB's schema-inference sample window (tested with 25,000 records, extra key on the last one) makes `read_json_auto` **raise `InvalidInputException`** ("has unknown key") — it validates the whole file strictly against the schema it inferred from sampling, rather than silently omitting the field. `extract_fields_duckdb_auto` (Task 1, reviewed clean, unmodified since) has no exception handling around its DuckDB call — this exception currently propagates all the way up through `run_paranoid_check()`, crashing the entire check for every source, not just the one file that triggered it. This is a real crash risk specifically because upstream schema drift (new fields appearing) is exactly the condition this tool exists to be run under.
2. **DuckDB collapses heterogeneous nested content into a generic `MAP(VARCHAR, JSON)` type rather than a typed `STRUCT`.** Empirically confirmed against the real `alexelgt_game_masters` `GAME_MASTER.json`: its `data` field (which holds wildly different shapes per `templateType`) is typed `MAP(VARCHAR, JSON)`, not a `STRUCT(...)`. `extract_fields_duckdb_auto`'s `walk_type` helper only descends into `STRUCT(...)`/`LIST[...]`-wrapped types — it has no code path for `MAP(...)`, so it silently stops at `data` as one flat field. This isn't a crash, but it means `find_method_mismatches` will report **every single nested field under `data.*`** as an individual "Python found it, DuckDB didn't" mismatch line for this source — potentially hundreds of lines burying any real signal in noise, when the accurate, useful statement is one line: "DuckDB collapsed `data` to `MAP(VARCHAR, JSON)`; cross-check unavailable below this path."

**Files:**
- Modify: `src/paranoid_check.py` (`extract_fields_duckdb_auto`, `run_paranoid_check`, `render_paranoid_report_markdown`)
- Modify: `docs/superpowers/specs/2026-08-02-data-parity-paranoid-check-design.md` — the "Two independent extraction methods, cross-checked" section's claim that DuckDB "can miss a rarely-occurring field entirely" via sampling is corrected to describe the two real failure modes above (a one-paragraph edit, not a rewrite).
- Test: `tests/test_paranoid_check_inventory.py` (append)

**Interfaces:**
- Consumes: nothing new from earlier tasks beyond what already exists.
- Changes: `extract_fields_duckdb_auto(data_file: Path) -> Tuple[Optional[Set[str]], List[str]]` — was `Set[str]`, now returns a 2-tuple `(fields, collapsed_paths)`. `fields` is `None` on a total DuckDB parse failure (was previously an uncaught exception); otherwise a `Set[str]` as before. `collapsed_paths` is a list of field paths where DuckDB's inferred type was `MAP(...)` or bare `JSON` (a "gave up, boxed it generically" signal) — empty list when nothing collapsed. **Every caller of `extract_fields_duckdb_auto` (Task 3's `run_paranoid_check`) must be updated for this new return shape** — this is the one call site to check.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_paranoid_check_inventory.py`:

```python
import pytest


def test_duckdb_auto_returns_none_fields_on_parse_failure(tmp_path):
    # A top-level array where a later record has a key no earlier record had,
    # placed far enough into the file that DuckDB's schema-inference sampling
    # won't have seen it -- real DuckDB behavior is to raise, not silently
    # omit the field. 25,000 plain records comfortably exceeds any reasonable
    # default sample size.
    import json
    records = [{"id": i, "name": f"item{i}"} for i in range(25000)]
    records[-1]["rareField"] = "only on the last record"
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps(records))

    fields, collapsed = extract_fields_duckdb_auto(data_file)

    assert fields is None
    assert collapsed == []


def test_duckdb_auto_records_collapsed_map_type_paths(tmp_path):
    import json
    # A dict-of-heterogeneous-dicts under one key -- DuckDB infers this as
    # MAP(VARCHAR, JSON), the same shape real GAME_MASTER.json's "data" field
    # produces (confirmed against real data before writing this test).
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps([
        {"templateId": "A", "data": {"pokemonSettings": {"dex": 1}}},
        {"templateId": "B", "data": {"combatMove": {"power": 70}}},
    ]))

    fields, collapsed = extract_fields_duckdb_auto(data_file)

    assert fields is not None
    assert "data" in fields
    assert "data" in collapsed
    # Nothing beneath the collapsed MAP was (and couldn't be) discovered --
    # confirms the collapse is recorded rather than silently producing a
    # false negative that looks identical to "field doesn't exist".
    assert "data.pokemonSettings" not in fields


def test_duckdb_auto_no_collapse_on_a_normal_struct(tmp_path):
    import json
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps([{"id": 1, "names": {"English": "Bulbasaur"}}]))

    fields, collapsed = extract_fields_duckdb_auto(data_file)

    assert fields == {"id", "names", "names.English"}
    assert collapsed == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_paranoid_check_inventory.py -k duckdb_auto -v`
Expected: the two new-behavior tests FAIL against the current implementation — the parse-failure test currently raises instead of returning, and the collapsed-map test currently gets a 1-tuple-shaped mismatch (`ValueError: too many values to unpack` or similar, since the current function returns a bare `Set[str]`, not a tuple).

- [ ] **Step 3: Rewrite `extract_fields_duckdb_auto`**

Replace the existing `extract_fields_duckdb_auto` function in `src/paranoid_check.py` with:

```python
def extract_fields_duckdb_auto(data_file: Path) -> "Tuple[Optional[Set[str]], List[str]]":
    """Method A: DuckDB's read_json_auto. Two real failure modes, both
    handled here rather than left to crash or silently under-report:

    1. A field appearing only after DuckDB's schema-inference sample window
       makes read_json_auto RAISE (it strictly validates every record
       against the schema it inferred from sampling) -- not silently omit
       the field, as an earlier draft of this design assumed. Caught here;
       signaled to the caller as fields=None so a single bad file can't
       crash the whole multi-source run.
    2. Heterogeneous nested content (e.g. real GAME_MASTER.json's "data"
       field, which holds a different shape per templateType) gets typed
       MAP(VARCHAR, JSON) rather than a descendable STRUCT -- not a crash,
       but everything beneath that path is invisible to this method. Each
       such path is returned in collapsed_paths so callers can report ONE
       "cross-check unavailable below this path" line instead of treating
       every field Python's walk finds beneath it as a spurious mismatch.

    Returns:
        (fields, collapsed_paths). fields is None on total parse failure
        (collapsed_paths is [] in that case); otherwise a Set[str] as
        before, with collapsed_paths listing any MAP(...)/bare-JSON leaf
        paths where further descent wasn't possible.
    """
    con = duckdb.connect(":memory:")
    try:
        con.execute(
            "CREATE TABLE _pc AS SELECT * FROM read_json_auto(?, format='auto')",
            [str(data_file)],
        )
        schema_rows = con.execute("DESCRIBE _pc").fetchall()
    except duckdb.Error:
        return None, []
    finally:
        con.close()

    fields: Set[str] = set()
    collapsed: List[str] = []

    def walk_type(column_path: str, duckdb_type: str) -> None:
        fields.add(column_path)
        inner = duckdb_type
        while inner.endswith("[]"):
            inner = inner[:-2].strip()
        if inner.upper().startswith("STRUCT(") and inner.endswith(")"):
            inner_body = inner[len("STRUCT("):-1]
            for field_decl in _split_top_level_commas(inner_body):
                field_decl = field_decl.strip()
                if not field_decl:
                    continue
                name_part, _, type_part = field_decl.partition(" ")
                name_part = name_part.strip('"')
                walk_type(f"{column_path}.{name_part}", type_part.strip())
        elif inner.upper().startswith("MAP(") or inner.upper() == "JSON":
            collapsed.append(column_path)

    for col_name, col_type, *_ in schema_rows:
        walk_type(col_name, col_type)

    return fields, collapsed
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_paranoid_check_inventory.py -v`
Expected: PASS (all inventory tests, including the 3 new ones — note this also requires updating the 3 PRE-EXISTING `extract_fields_duckdb_auto` tests from Task 1, since they currently assert a bare set return value; update each to unpack the tuple, e.g. `fields, _ = extract_fields_duckdb_auto(data_file)` before the existing assertions).

- [ ] **Step 5: Commit**

```bash
git add src/paranoid_check.py tests/test_paranoid_check_inventory.py
git commit -m "fix: handle DuckDB parse failures and MAP-type collapses in extract_fields_duckdb_auto"
```

- [ ] **Step 6: Update `run_paranoid_check`'s call site**

In `src/paranoid_check.py`'s `run_paranoid_check`, find the line calling `extract_fields_duckdb_auto(data_file)` and update it and the surrounding logic:

```python
            python_fields = extract_fields_python_walk(data_file)
            duckdb_fields, collapsed_paths = extract_fields_duckdb_auto(data_file)

            classification = classify_endpoint_fields(
                endpoint, python_fields, mapped_fields, canonical_attrs, claims_attrs
            )
            endpoints_report[endpoint] = classification
            for tier, fields in classification.items():
                counts[tier] += len(fields)

            if duckdb_fields is None:
                duckdb_parse_failures.append(endpoint)
            else:
                mismatches = [
                    f for f in find_method_mismatches(python_fields, duckdb_fields)
                    if not any(f == p or f.startswith(p + ".") for p in collapsed_paths)
                ]
                if mismatches:
                    method_mismatches[endpoint] = mismatches
                if collapsed_paths:
                    collapsed_type_paths[endpoint] = collapsed_paths
```

This replaces the existing block in `run_paranoid_check` that computes `duckdb_fields` and `mismatches` (the block currently reads `duckdb_fields = extract_fields_duckdb_auto(data_file)` followed by an unconditional `mismatches = find_method_mismatches(...)` and `if mismatches: method_mismatches[endpoint] = mismatches`). Also add two new local variables at the top of each source's loop iteration, alongside the existing `method_mismatches: Dict[str, List[str]] = {}` line: `duckdb_parse_failures: List[str] = []` and `collapsed_type_paths: Dict[str, List[str]] = {}`. Add both to the per-source dict this function builds (`report["sources"][source_key] = {...}`), alongside the existing `endpoints`, `untemplated_endpoints`, `method_mismatches` keys:

```python
        report["sources"][source_key] = {
            "endpoints": endpoints_report,
            "untemplated_endpoints": untemplated_endpoints,
            "method_mismatches": method_mismatches,
            "duckdb_parse_failures": duckdb_parse_failures,
            "collapsed_type_paths": collapsed_type_paths,
        }
```

The `mismatches` filter above (`if not any(f == p or f.startswith(p + ".") for p in collapsed_paths)`) prevents every field beneath a collapsed MAP path from separately appearing in `method_mismatches` — those are reported once via `collapsed_type_paths` instead, not duplicated as individual mismatch noise.

- [ ] **Step 7: Write the failing test for the orchestration-level handling**

Append to `tests/test_paranoid_check_report.py`:

```python
def test_run_paranoid_check_handles_duckdb_parse_failure_without_crashing(tmp_path):
    templates_dir = _build_fixture_source(
        tmp_path, "fixture_source", "data",
        records=[{"id": i, "name": f"item{i}"} for i in range(25000)],
        field_mappings={"name": {"source_field": "name", "transform": "direct"}},
    )
    # Append the rare-field record that only DuckDB's sampling would choke on --
    # rewrite the raw file directly since _build_fixture_source already wrote it.
    raw_file = tmp_path / "raw_dumps" / "fixture_source" / "2026-01-01T000000Z" / "data.json"
    records = json.loads(raw_file.read_text())
    records[-1]["rareField"] = "triggers a duckdb parse failure"
    raw_file.write_text(json.dumps(records))

    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INTEGER)")
    con.close()

    # Must not raise -- this is the whole point of the fix.
    report = run_paranoid_check(
        db_path=db_path, raw_dumps_dir=tmp_path / "raw_dumps", templates_dir=templates_dir,
        sources=["fixture_source"],
    )

    assert "data" in report["sources"]["fixture_source"]["duckdb_parse_failures"]


def test_run_paranoid_check_reports_collapsed_map_once_not_per_subfield(tmp_path):
    templates_dir = _build_fixture_source(
        tmp_path, "fixture_source", "data",
        records=[
            {"templateId": "A", "data": {"pokemonSettings": {"dex": 1}}},
            {"templateId": "B", "data": {"combatMove": {"power": 70}}},
        ],
        field_mappings={"templateId": {"source_field": "templateId", "transform": "direct"}},
    )
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INTEGER)")
    con.close()

    report = run_paranoid_check(
        db_path=db_path, raw_dumps_dir=tmp_path / "raw_dumps", templates_dir=templates_dir,
        sources=["fixture_source"],
    )

    source_data = report["sources"]["fixture_source"]
    assert "data" in source_data["collapsed_type_paths"]["data"]
    # The whole point: data.pokemonSettings/data.combatMove (which Python's
    # walk finds but DuckDB's MAP-collapsed view can't) must NOT also show up
    # as individual method_mismatches entries -- that would be exactly the
    # noise this fix exists to eliminate.
    mismatches = source_data["method_mismatches"].get("data", [])
    assert not any(m.startswith("data.") for m in mismatches)
```

- [ ] **Step 8: Run tests to verify they fail, then implement, then verify they pass**

Run: `uv run pytest tests/test_paranoid_check_report.py -v` — expect FAIL (KeyError on `duckdb_parse_failures`/`collapsed_type_paths`, since Step 6 hasn't been applied to a running interpreter yet if done out of order; if Step 6 was already applied per above, these should pass immediately — apply Step 6 first, then these tests, in whichever order makes the fail-then-pass cycle real for you).

Run again after Step 6's implementation: `uv run pytest tests/test_paranoid_check_report.py -v`
Expected: PASS (all report tests, including the 2 new ones).

- [ ] **Step 9: Update `render_paranoid_report_markdown` to surface the two new categories**

In `src/paranoid_check.py`'s `render_paranoid_report_markdown`, inside the per-source loop (after the existing `if source_data["untemplated_endpoints"]:` block), add:

```python
        if source_data.get("duckdb_parse_failures"):
            lines.append(f"**DuckDB parse failures (schema drift beyond DuckDB's sampling window — Python-walk classification above is unaffected and still authoritative):** " + ", ".join(f"`{e}`" for e in source_data["duckdb_parse_failures"]))
            lines.append("")
```

And replace the existing `if source_data["method_mismatches"]:` block's rendering with one that also surfaces collapsed paths first:

```python
        if source_data.get("collapsed_type_paths"):
            lines.append("**Collapsed types (DuckDB typed these as MAP/JSON — cross-check unavailable beneath them):**")
            for endpoint, paths in source_data["collapsed_type_paths"].items():
                lines.append(f"- `{endpoint}`: " + ", ".join(f"`{p}`" for p in paths))
            lines.append("")
        if source_data["method_mismatches"]:
            lines.append("**Method mismatches** (Python walk found, DuckDB's sampled read_json_auto missed):")
            for endpoint, fields in source_data["method_mismatches"].items():
                lines.append(f"- `{endpoint}`: " + ", ".join(f"`{f}`" for f in fields))
            lines.append("")
```

- [ ] **Step 10: Correct the design spec's inaccurate premise**

In `docs/superpowers/specs/2026-08-02-data-parity-paranoid-check-design.md`, find the "Two independent extraction methods, cross-checked" section's opening paragraph (currently claims DuckDB "can miss a rarely-occurring field entirely" via sampling). Replace it with:

```markdown
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
don't trust one parser's view of a source's real shape.
```

- [ ] **Step 11: Run the full test suite**

Run: `uv run pytest tests/ -q`
Expected: all tests pass (134 pre-existing + however many new ones this task adds).

- [ ] **Step 12: Commit**

```bash
git add src/paranoid_check.py tests/test_paranoid_check_report.py docs/superpowers/specs/2026-08-02-data-parity-paranoid-check-design.md
git commit -m "fix: surface DuckDB parse failures and collapsed-type paths without crashing or flooding the report"
```

---

## After this plan

Once this plan's 3 tasks are reviewed and merged, the project owner runs `uv run go_refs.py --test-paranoid` themselves against real data and shares the resulting `output/paranoid_check_report.md`. That report becomes the authoritative input to a **follow-up plan** (not written here, since its tasks can't be concretely specified without real report data) covering the source-by-source override pass described in the design spec (`docs/superpowers/specs/2026-08-02-data-parity-paranoid-check-design.md`).
