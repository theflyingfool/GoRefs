"""Schema inventory analysis tool for Master DuckDB database."""

import json
import duckdb
from pathlib import Path
from typing import Dict, List, Any


def analyze_exploration_inventory(db_path: str = "output/GoRefs_Master.duckdb") -> List[Dict[str, Any]]:
    """Analyzes the `schema_inventory` table across raw and canonical tables in DuckDB.

    Args:
        db_path: Path to the target DuckDB database file. Defaults to
            `output/GoRefs_Master.duckdb`.

    Returns:
        List of inventory record dictionaries containing source, table_name, row_count,
        field_count, and sample_fields.
    """
    target_path = Path(db_path)
    if not target_path.exists():
        target_path = Path("exploration.duckdb")
        if not target_path.exists():
            target_path = Path("gameMaster.duckdb")
            if not target_path.exists():
                print(f"Warning: Database '{db_path}' not found. Run 'go_refs.py --build' first.")
                return []

    db = duckdb.connect(str(target_path))
    tables = [r[0] for r in db.execute("SHOW TABLES").fetchall()]
    if "schema_inventory" not in tables:
        db.close()
        return []

    res = db.execute("SELECT * FROM schema_inventory ORDER BY row_count DESC").fetchall()

    inventory = []
    for row in res:
        if len(row) == 5:
            source, table_name, row_count, field_count, fields_json = row
        else:
            table_name, row_count, fields_json = row[0], row[1], row[2]
            source = "alexelgt_game_masters"
            field_count = len(json.loads(fields_json)) if fields_json else 0

        fields = json.loads(fields_json) if isinstance(fields_json, str) else fields_json or []
        inventory.append({
            "source": source,
            "table_name": table_name,
            "row_count": row_count,
            "field_count": field_count,
            "sample_fields": fields[:10]
        })

    db.close()
    return inventory


if __name__ == "__main__":
    inv = analyze_exploration_inventory()
    print(f"Total Tables Analyzed across All Sources: {len(inv)}")
    print("\nTop 30 Exploration Tables by Row Count:")
    print(f"{'Source':<22} | {'Table Name':<35} | {'Rows':<8} | {'Cols':<6}")
    print("-" * 80)
    for item in inv[:30]:
        print(f"{str(item['source']):<22} | {str(item['table_name']):<35} | {item['row_count']:<8} | {item['field_count']:<6}")
