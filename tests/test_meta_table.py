"""Unit test for the _meta table in src/builder.py."""

from pathlib import Path
import duckdb

from src.builder import GoRefsMasterEngine


def test_meta_table_has_build_row_and_per_source_rows(tmp_path):
    out_dir = tmp_path / "output"
    db_file = out_dir / "GoRefs_Master.duckdb"

    engine = GoRefsMasterEngine(
        raw_dumps_dir=Path("raw_dumps"),
        output_dir=out_dir,
        db_path=db_file
    )
    engine.build_all()

    con = duckdb.connect(str(db_file), read_only=True)
    rows = con.execute("SELECT source, last_pulled_at FROM _meta").fetchall()
    con.close()
    sources = {r[0]: r[1] for r in rows}

    assert "__build__" in sources
    assert sources["__build__"]  # non-empty ISO timestamp string
    # At least one real source (alexelgt_game_masters is always fetched)
    assert "alexelgt_game_masters" in sources
