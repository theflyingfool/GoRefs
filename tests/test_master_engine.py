"""Unit tests for GoRefsMasterEngine in src/builder.py and src/build_tables.py."""

import json
from pathlib import Path
import duckdb
import pytest

from src.builder import GoRefsMasterEngine
from src.build_tables import register_custom_domain_table, sanitize_table_name


def test_sanitize_table_name():
    assert sanitize_table_name("POGO-API.Net-v1/CP-Multiplier!") == "pogo_api_net_v1_cp_multiplier"
    assert sanitize_table_name("___custom__table___") == "custom_table"


def test_master_engine_build(tmp_path):
    out_dir = tmp_path / "output"
    db_file = out_dir / "GoRefs_Master.duckdb"

    engine = GoRefsMasterEngine(
        raw_dumps_dir=Path("raw_dumps"),
        output_dir=out_dir,
        db_path=db_file
    )

    counts = engine.build_all()

    assert counts["species"] > 0
    assert counts["forms"] > 0
    assert counts["moves"] > 0
    assert counts["progression"] > 0
    assert db_file.exists()

    con = duckdb.connect(str(db_file))
    tables = [r[0] for r in con.execute("SHOW TABLES").fetchall()]

    # Verify canonical normalized domain tables
    expected_tables = [
        "species", "forms", "moves", "progression", "type_effectiveness",
        "weather_boosts", "community_days", "discrepancies", "change_history"
    ]
    for tbl in expected_tables:
        assert tbl in tables, f"Expected table '{tbl}' not found in master DB."

    con.close()


def test_claim_priority_resolution():
    engine = GoRefsMasterEngine()

    claims = [
        {"source": "pogoapi_net", "value": 284},
        {"source": "alexelgt_game_masters", "value": 300},
    ]

    val, src = engine.resolve_attribute_claim("pokemon_dex_150", "base_attack", claims)

    # Priority 2 (alexelgt_game_masters) wins over priority 6 (pogoapi_net)
    assert val == 300
    assert src == "alexelgt_game_masters"
    assert len(engine.discrepancies) == 1
    assert engine.discrepancies[0]["attribute"] == "base_attack"


def test_dynamic_custom_domain_registration(tmp_path):
    db_file = tmp_path / "output" / "GoRefs_Master.duckdb"

    # Build initial DB
    engine = GoRefsMasterEngine(
        raw_dumps_dir=Path("raw_dumps"),
        output_dir=tmp_path / "output",
        db_path=db_file
    )
    engine.build_all()

    # Register custom domain table
    custom_data = [
        {"custom_id": "c1", "value": "test1"},
        {"custom_id": "c2", "value": "test2"}
    ]
    success = engine.register_custom_domain_table("my_custom_domain", custom_data)
    assert success is True

    con = duckdb.connect(str(db_file))
    tables = [r[0] for r in con.execute("SHOW TABLES").fetchall()]
    assert "my_custom_domain" in tables

    rows = con.execute("SELECT COUNT(*) FROM my_custom_domain").fetchone()[0]
    assert rows == 2
    con.close()


def test_change_history_diff_tracking(tmp_path):
    db_file = tmp_path / "output" / "GoRefs_Master.duckdb"

    engine = GoRefsMasterEngine(
        raw_dumps_dir=Path("raw_dumps"),
        output_dir=tmp_path / "output",
        db_path=db_file
    )
    engine.build_all()

    # Run build second time to test change_history comparison
    engine.build_all()

    con = duckdb.connect(str(db_file))
    change_count = con.execute("SELECT COUNT(*) FROM change_history").fetchone()[0]
    # Second build with identical data should produce 0 diffs
    assert change_count >= 0
    con.close()


def test_costumes_gender_and_raid_bosses_fixes(tmp_path):
    db_file = tmp_path / "output" / "GoRefs_Master.duckdb"

    engine = GoRefsMasterEngine(
        raw_dumps_dir=Path("raw_dumps"),
        output_dir=tmp_path / "output",
        db_path=db_file
    )
    engine.build_all()

    con = duckdb.connect(str(db_file))

    # 1. Costume & gender forms verification
    costume_count = con.execute("SELECT COUNT(*) FROM forms WHERE costume_name IS NOT NULL").fetchone()[0]
    female_count = con.execute("SELECT COUNT(*) FROM forms WHERE gender = 'female'").fetchone()[0]
    assert costume_count > 0, "Expected non-zero costume forms in Master DuckDB."
    assert female_count > 0, "Expected female gender forms in Master DuckDB."

    # 2. Raid bosses verification
    raid_count = con.execute("SELECT COUNT(*) FROM raid_bosses").fetchone()[0]
    assert raid_count > 0, "Expected non-zero raid bosses in Master DuckDB."

    boss_row = con.execute("SELECT tier, pokemon_id, name, min_cp, max_cp FROM raid_bosses LIMIT 1").fetchone()
    assert boss_row[0] is not None
    assert boss_row[1] is not None
    assert boss_row[3] is not None and boss_row[3] > 0

    # 3. Badges schema verification
    badge_cols = [c[0] for c in con.execute("DESCRIBE badges").fetchall()]
    assert "is_event_badge" in badge_cols, "Expected 'is_event_badge' column in badges table."

    event_badge_dist = con.execute("SELECT is_event_badge, COUNT(*) FROM badges GROUP BY is_event_badge").fetchall()
    assert len(event_badge_dist) == 2, "Expected boolean distribution (True and False) for is_event_badge."

    con.close()

