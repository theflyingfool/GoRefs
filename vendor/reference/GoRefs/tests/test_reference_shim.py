import json
import duckdb
from src.reference_shim import camel_to_snake, load_reference_json_shim


def test_camel_to_snake():
    assert camel_to_snake("formMoves") == "form_moves"
    assert camel_to_snake("species") == "species"
    assert camel_to_snake("pvpRankRequirements") == "pvp_rank_requirements"


def test_load_reference_json_shim_creates_prefixed_tables_without_touching_real_ones(tmp_path):
    json_path = tmp_path / "reference.json"
    json_path.write_text(json.dumps({
        "species": [{"slug": "bulbasaur", "dexNumber": 1}],
        "formMoves": [{"formSlug": "bulbasaur-standard-male", "moveSlug": "vine-whip-fast"}],
        "backgrounds": [],
    }))
    db_path = tmp_path / "test.duckdb"

    row_counts = load_reference_json_shim(json_path=json_path, db_path=db_path)

    assert row_counts == {"refjson_species": 1, "refjson_form_moves": 1, "refjson_backgrounds": 0}

    con = duckdb.connect(str(db_path), read_only=True)
    tables = {row[0] for row in con.execute("SHOW TABLES").fetchall()}
    con.close()
    assert tables == {"refjson_species", "refjson_form_moves", "refjson_backgrounds"}
    # Never collides with what a real --build would name its own tables.
    assert "species" not in tables
