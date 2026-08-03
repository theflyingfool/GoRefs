"""DuckDB table building and dynamic schema exploration engine for Pokémon GO reference data.

Provides utilities for exploding raw client data snapshots, building exploration tables,
tracking schema inventories, and dynamically registering custom domain tables into the
unified Master DuckDB database (`output/GoRefs_Master.duckdb`).
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
import duckdb
import pandas as pd


def sanitize_table_name(name: str) -> str:
    """Sanitizes an arbitrary string into a valid DuckDB table name.

    Replaces non-alphanumeric characters with underscores, merges consecutive underscores,
    strips leading/trailing underscores, and converts the string to lowercase.

    Args:
        name: The raw table name or file stem to sanitize.

    Returns:
        A sanitized, lower-cased SQL-safe table name string.

    Example:
        >>> sanitize_table_name("POGO-API.Net-v1/CP-Multiplier!")
        'pogo_api_net_v1_cp_multiplier'
    """
    cleaned = re.sub(r"[^0-9A-Za-z_]", "_", name)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_").lower()
    return cleaned


def build_exploration_tables(
    db_file: str = "output/GoRefs_Master.duckdb",
    raw_dumps_dir: Path = Path("raw_dumps")
) -> int:
    """Dynamically builds raw exploration tables across all upstream data sources into DuckDB.

    Scans the `raw_dumps/` directory for all source folders (e.g., `alexelgt_game_masters`,
    `pokemon_go_api`, `pogoapi_net`, `pvpoke`, `pokeapi`, `rplus_shiny`, `local_authoring`, or any
    new raw directories). Explodes complex nested JSON payloads (such as `GAME_MASTER.json` into
    `gm_*` tables) and loads flat raw JSON files into source-prefixed tables.

    Args:
        db_file: Path to the target DuckDB database file. Defaults to
            `output/GoRefs_Master.duckdb`.
        raw_dumps_dir: Path to the root raw dumps directory containing source folders.
            Defaults to `Path("raw_dumps")`.

    Returns:
        Total number of raw exploration tables created or updated in the database.

    Raises:
        FileNotFoundError: If `raw_dumps_dir` does not exist.
    """
    db_path = Path(db_file)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    if not raw_dumps_dir.exists():
        print(f"Warning: {raw_dumps_dir} directory not found. Run pipeline with --fetch first.")
        return 0

    print(f"Opening Master DuckDB database at {db_file}...")
    db = duckdb.connect(str(db_path))

    total_tables_created = 0
    inventory_records: List[Dict[str, Any]] = []

    source_dirs = sorted([d for d in raw_dumps_dir.iterdir() if d.is_dir() and d.name != "assets"])

    print(f"Found {len(source_dirs)} data source directories in {raw_dumps_dir}:")
    for s_dir in source_dirs:
        print(f" - {s_dir.name}")

    for source_dir in source_dirs:
        snapshots = sorted([d for d in source_dir.iterdir() if d.is_dir()])
        if not snapshots:
            continue
        latest_snapshot = snapshots[-1]

        print(f"\n[{source_dir.name}] Ingesting latest raw snapshot: {latest_snapshot.name}")

        for filepath in sorted(latest_snapshot.glob("*.json")):
            if filepath.name == ".meta.json":
                continue

            # Special case for GAME_MASTER.json: explode into individual record_id tables
            if filepath.name == "GAME_MASTER.json":
                print(f"[{source_dir.name}] Exploding Game Master templates into DuckDB tables...")
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        gm_data = json.load(f)

                    rows = []
                    for item in gm_data:
                        t_id = item.get("templateId")
                        data = item.get("data")
                        if isinstance(data, dict):
                            for record_id, json_data in data.items():
                                rows.append({
                                    "templateId": t_id,
                                    "record_id": record_id,
                                    "json_data": json.dumps(json_data)
                                })

                    templates_df = pd.DataFrame(rows)
                    for record_id, group in templates_df.groupby("record_id"):
                        try:
                            tbl_name = sanitize_table_name(f"gm_{record_id}")
                            flattened = pd.json_normalize(group["json_data"].apply(json.loads))
                            flattened.insert(0, "templateId", group["templateId"].values)

                            db.register("tmp_table", flattened)
                            db.execute(f'DROP TABLE IF EXISTS "{tbl_name}"')
                            db.execute(f'CREATE TABLE "{tbl_name}" AS SELECT * FROM tmp_table')

                            total_tables_created += 1
                            inventory_records.append({
                                "source": source_dir.name,
                                "table_name": tbl_name,
                                "row_count": len(flattened),
                                "field_count": len(flattened.columns),
                                "sample_fields": json.dumps(list(flattened.columns[:10]))
                            })
                        except Exception:
                            pass
                except Exception as ex:
                    print(f"[{source_dir.name}] Warning reading GAME_MASTER.json: {ex}")
                continue

            # Standard JSON files across all other sources
            tbl_name = sanitize_table_name(f"{source_dir.name}_{filepath.stem}")
            try:
                db.execute(f'DROP TABLE IF EXISTS "{tbl_name}"')
                db.execute(f'CREATE TABLE "{tbl_name}" AS SELECT * FROM read_json_auto(\'{filepath}\')')

                row_count = db.execute(f'SELECT COUNT(*) FROM "{tbl_name}"').fetchone()[0]
                cols = [col[0] for col in db.execute(f'DESCRIBE "{tbl_name}"').fetchall()]

                total_tables_created += 1
                inventory_records.append({
                    "source": source_dir.name,
                    "table_name": tbl_name,
                    "row_count": row_count,
                    "field_count": len(cols),
                    "sample_fields": json.dumps(cols[:10])
                })
                print(f"  Created table '{tbl_name}' ({row_count} rows, {len(cols)} columns)")

            except Exception as ex:
                print(f"[{source_dir.name}] Warning creating table '{tbl_name}' from {filepath.name}: {ex}")

    # Build schema inventory table across all sources
    if inventory_records:
        inv_df = pd.DataFrame(inventory_records)
        db.register("inv_df", inv_df)
        db.execute("DROP TABLE IF EXISTS schema_inventory")
        db.execute("CREATE TABLE schema_inventory AS SELECT * FROM inv_df")

    db.close()
    print("\n" + "=" * 70)
    print(f"Exploration Database Built Successfully! Created {total_tables_created} tables across {len(source_dirs)} sources in '{db_file}'.")
    print("=" * 70)
    return total_tables_created


def register_custom_domain_table(
    db_file: Union[str, Path] = "output/GoRefs_Master.duckdb",
    table_name: str = "",
    data: Union[pd.DataFrame, List[Dict[str, Any]], str] = None,
    source_key: str = "custom_domain"
) -> bool:
    """Dynamically registers a custom domain table or new source dataset into DuckDB.

    Ensures extension support without breaking or altering pre-existing canonical
    or raw schemas. Updates `schema_inventory` automatically.

    Args:
        db_file: Path to the target DuckDB database file. Defaults to
            `output/GoRefs_Master.duckdb`.
        table_name: Raw or formatted table name to create/replace in the database.
        data: Data to ingest. Can be a `pandas.DataFrame`, a list of dictionaries,
            or a SQL SELECT statement string.
        source_key: Optional identifier tag for the source registering this table.
            Defaults to `"custom_domain"`.

    Returns:
        True if registration succeeded, False otherwise.

    Raises:
        ValueError: If table_name or data is invalid.
    """
    if not table_name:
        raise ValueError("table_name cannot be empty.")
    if data is None:
        raise ValueError("data cannot be None.")

    tbl_sanitized = sanitize_table_name(table_name)
    db_path = Path(db_file)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(db_path))
    try:
        if isinstance(data, pd.DataFrame):
            con.register("tmp_custom_reg", data)
            con.execute(f'DROP TABLE IF EXISTS "{tbl_sanitized}"')
            con.execute(f'CREATE TABLE "{tbl_sanitized}" AS SELECT * FROM tmp_custom_reg')
            con.unregister("tmp_custom_reg")
        elif isinstance(data, list):
            df = pd.DataFrame(data)
            con.register("tmp_custom_reg", df)
            con.execute(f'DROP TABLE IF EXISTS "{tbl_sanitized}"')
            con.execute(f'CREATE TABLE "{tbl_sanitized}" AS SELECT * FROM tmp_custom_reg')
            con.unregister("tmp_custom_reg")
        elif isinstance(data, str):
            con.execute(f'DROP TABLE IF EXISTS "{tbl_sanitized}"')
            con.execute(f'CREATE TABLE "{tbl_sanitized}" AS {data}')
        else:
            con.close()
            return False

        row_count = con.execute(f'SELECT COUNT(*) FROM "{tbl_sanitized}"').fetchone()[0]
        cols = [col[0] for col in con.execute(f'DESCRIBE "{tbl_sanitized}"').fetchall()]

        # Update schema_inventory if table exists
        existing_tables = [row[0] for row in con.execute("SHOW TABLES").fetchall()]
        if "schema_inventory" in existing_tables:
            con.execute(
                "DELETE FROM schema_inventory WHERE table_name = ?",
                (tbl_sanitized,)
            )
            con.execute(
                "INSERT INTO schema_inventory VALUES (?, ?, ?, ?, ?)",
                (source_key, tbl_sanitized, row_count, len(cols), json.dumps(cols[:10]))
            )

        con.close()
        return True
    except Exception as ex:
        print(f"Error registering custom domain table '{table_name}': {ex}")
        con.close()
        return False


if __name__ == "__main__":
    build_exploration_tables()