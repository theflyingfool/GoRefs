"""Wholesale loader for the reference_json_shim: a raw, unmodeled dump of
GoBuddy's reference.json into output/GoRefs_Master.duckdb, prefixed
refjson_* so it never collides with GoRefs' own canonical tables.

Deliberately not integrated with the fetcher/template/claims-ledger
machinery every other source uses -- this is a short-term stopgap, not a
new permanent source. See data-authoring/reference_json_shim/SOURCE.md.
"""

import json
import re
from pathlib import Path
from typing import Dict

import duckdb
import pandas as pd

_CAMEL_TO_SNAKE_RE = re.compile(r"(?<!^)(?=[A-Z])")


def camel_to_snake(name: str) -> str:
    """Converts a camelCase key (e.g. "formMoves") to snake_case ("form_moves")."""
    return _CAMEL_TO_SNAKE_RE.sub("_", name).lower()


def load_reference_json_shim(
    json_path: Path = Path("data-authoring/reference_json_shim/reference.json"),
    db_path: Path = Path("output/GoRefs_Master.duckdb"),
) -> Dict[str, int]:
    """Loads every top-level array in reference.json into its own
    refjson_<snake_case_domain> table in output/GoRefs_Master.duckdb.

    Each table is dropped and recreated fresh, so re-running this after
    refreshing the copied reference.json is always safe. Table names never
    collide with GoRefs' own canonical tables (all prefixed refjson_), so
    this can be run before or after --build with no ordering dependency.

    Args:
        json_path: Path to the copied reference.json snapshot.
        db_path: Path to the master DuckDB database to load tables into.

    Returns:
        Dict mapping each created table name to its row count.
    """
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    row_counts: Dict[str, int] = {}

    try:
        for domain_key, records in data.items():
            table_name = f"refjson_{camel_to_snake(domain_key)}"
            con.execute(f'DROP TABLE IF EXISTS "{table_name}"')
            if records:
                df = pd.DataFrame(records)
                con.register("tmp_refjson_df", df)
                con.execute(f'CREATE TABLE "{table_name}" AS SELECT * FROM tmp_refjson_df')
                con.unregister("tmp_refjson_df")
                row_counts[table_name] = len(df)
            else:
                con.execute(f'CREATE TABLE "{table_name}" (placeholder VARCHAR)')
                row_counts[table_name] = 0
    finally:
        con.close()

    return row_counts
