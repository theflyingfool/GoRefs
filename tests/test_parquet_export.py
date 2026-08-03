from pathlib import Path
import duckdb
import pytest
from src.builder import GoRefsMasterEngine


def test_export_parquet_writes_one_file_per_canonical_table(tmp_path):
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, name VARCHAR)")
    con.execute("INSERT INTO species VALUES (1, 'Bulbasaur')")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR)")  # should be excluded
    con.close()

    engine = GoRefsMasterEngine(db_path=db_path)
    exported = engine.export_parquet(db_path=db_path, output_dir=tmp_path)

    assert "species" in exported
    assert "_claims_ledger" not in exported
    assert (tmp_path / "parquet" / "species.parquet").exists()

    con2 = duckdb.connect(str(db_path))
    df = con2.execute(f"SELECT * FROM read_parquet('{tmp_path / 'parquet' / 'species.parquet'}')").df()
    assert df.iloc[0]["name"] == "Bulbasaur"


def test_export_parquet_clears_stale_files(tmp_path):
    """Verify that stale .parquet files from prior builds are cleared."""
    db_path = tmp_path / "test.duckdb"
    parquet_dir = tmp_path / "parquet"
    parquet_dir.mkdir(parents=True, exist_ok=True)

    # Create a stale .parquet file from a prior build
    stale_file = parquet_dir / "obsolete_table.parquet"
    stale_file.write_text("stale content")
    assert stale_file.exists()

    # Create a fresh database with only "species" table
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, name VARCHAR)")
    con.execute("INSERT INTO species VALUES (1, 'Bulbasaur')")
    con.close()

    engine = GoRefsMasterEngine(db_path=db_path)
    exported = engine.export_parquet(db_path=db_path, output_dir=tmp_path)

    # Verify stale file was removed (full rebuild semantics)
    assert not stale_file.exists(), "Stale .parquet file should be cleared on export"
    assert (parquet_dir / "species.parquet").exists()
    assert "species" in exported


def test_export_parquet_with_empty_table(tmp_path):
    """Verify that empty tables (schema-only, zero rows) are exported correctly."""
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE empty_table (id INT, value VARCHAR)")
    # No INSERT — table is empty
    con.close()

    engine = GoRefsMasterEngine(db_path=db_path)
    exported = engine.export_parquet(db_path=db_path, output_dir=tmp_path)

    assert "empty_table" in exported
    assert (tmp_path / "parquet" / "empty_table.parquet").exists()

    # Verify the empty Parquet file is readable
    con2 = duckdb.connect(str(db_path))
    df = con2.execute(f"SELECT * FROM read_parquet('{tmp_path / 'parquet' / 'empty_table.parquet'}')").df()
    assert len(df) == 0


def test_export_parquet_raises_on_missing_db(tmp_path):
    """Verify that missing db_path raises FileNotFoundError."""
    db_path = tmp_path / "nonexistent.duckdb"
    engine = GoRefsMasterEngine(db_path=db_path)

    with pytest.raises(FileNotFoundError):
        engine.export_parquet(db_path=db_path, output_dir=tmp_path)
