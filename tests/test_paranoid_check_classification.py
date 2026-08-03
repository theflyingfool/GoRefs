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
