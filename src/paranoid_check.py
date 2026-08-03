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
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

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
        elif inner.upper().startswith("MAP(") or inner.upper() == "JSON":
            collapsed.append(column_path)

    for col_name, col_type, *_ in schema_rows:
        walk_type(col_name, col_type)

    return fields, collapsed


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
              "duckdb_parse_failures": [endpoint_names_duckdb_could_not_parse],
              "collapsed_type_paths": {endpoint: [field_path_collapsed_to_MAP_or_JSON, ...]},
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
        duckdb_parse_failures: List[str] = []
        collapsed_type_paths: Dict[str, List[str]] = {}
        counts = {"CANONICAL": 0, "CLAIMS_ONLY": 0, "MISSING": 0}

        for data_file in tqdm(raw_files, desc=f"{source_key} endpoints", leave=False):
            endpoint = data_file.stem
            mapped_fields = mapped_by_endpoint.get(endpoint, set())
            if endpoint not in mapped_by_endpoint:
                untemplated_endpoints.append(endpoint)

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

        report["sources"][source_key] = {
            "endpoints": endpoints_report,
            "untemplated_endpoints": untemplated_endpoints,
            "method_mismatches": method_mismatches,
            "duckdb_parse_failures": duckdb_parse_failures,
            "collapsed_type_paths": collapsed_type_paths,
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
        if source_data.get("duckdb_parse_failures"):
            lines.append(f"**DuckDB parse failures (schema drift beyond DuckDB's sampling window — Python-walk classification above is unaffected and still authoritative):** " + ", ".join(f"`{e}`" for e in source_data["duckdb_parse_failures"]))
            lines.append("")
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

    return "\n".join(lines)
