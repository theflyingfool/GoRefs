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
    con.execute("CREATE TABLE species (dex_number INTEGER, name VARCHAR)")  # 'name' promoted to canonical; 'id' deliberately absent
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
    # NOTE: empirically verified against the installed DuckDB version (1.5.5)
    # that a "data" field needs >= 10 distinct top-level keys across records
    # before read_json_auto infers MAP(VARCHAR, JSON) instead of a plain
    # STRUCT(...) -- 2 keys (the original design-doc example) still infers a
    # descendable STRUCT and would not exercise the collapse path at all.
    records = [
        {"templateId": "A", "data": {"pokemonSettings": {"dex": 1}}},
        {"templateId": "B", "data": {"combatMove": {"power": 70}}},
    ]
    extra_keys = [
        "itemSettings", "moveSettings", "formSettings", "avatarCustomization",
        "encounterSettings", "weatherAffinities", "raidSettings",
        "questSettings", "playerLevelSettings", "genderSettings",
    ]
    for key in extra_keys:
        records.append({"templateId": key.upper(), "data": {key: {"value": 1}}})

    templates_dir = _build_fixture_source(
        tmp_path, "fixture_source", "data",
        records=records,
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
