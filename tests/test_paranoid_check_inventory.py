from src.paranoid_check import flatten_json_fields


def test_flatten_flat_dict():
    assert flatten_json_fields({"name": "Bulbasaur", "id": 1}) == {"name", "id"}


def test_flatten_nested_dict():
    record = {"names": {"English": "Bulbasaur", "Japanese": "Fushigidane"}}
    assert flatten_json_fields(record) == {"names", "names.English", "names.Japanese"}


def test_flatten_list_of_dicts_walks_every_item_and_unions_their_fields():
    # Different items in the same list can have different keys (e.g. GAME_MASTER's
    # heterogeneous assetForms) -- flattening must union across ALL items, not just
    # inspect the first one, since a field appearing only on a later item would
    # otherwise be silently missed.
    record = {"assetForms": [{"form": "NORMAL"}, {"form": "FEMALE", "isFemale": True}]}
    assert flatten_json_fields(record) == {
        "assetForms", "assetForms.form", "assetForms.isFemale"
    }


def test_flatten_deeply_nested_mixed_dict_and_list():
    record = {"data": {"combatMove": {"buffs": {"targetDefenseStatStageChange": -1}}}}
    assert flatten_json_fields(record) == {
        "data", "data.combatMove", "data.combatMove.buffs",
        "data.combatMove.buffs.targetDefenseStatStageChange",
    }


def test_flatten_ignores_scalar_list_items():
    # A list of plain strings/numbers (not dicts) has nothing further to flatten
    # into -- the field itself is still reported, just not descended into.
    record = {"targets": [1, 10, 50, 100]}
    assert flatten_json_fields(record) == {"targets"}


def test_flatten_empty_dict_returns_empty_set():
    assert flatten_json_fields({}) == set()


import json
import duckdb
from src.paranoid_check import extract_fields_python_walk, extract_fields_duckdb_auto


def test_python_walk_finds_every_field_across_all_records(tmp_path):
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps([
        {"id": 1, "name": "Bulbasaur"},
        {"id": 2, "name": "Ivysaur", "rareField": "only on this record"},
    ]))
    fields = extract_fields_python_walk(data_file)
    assert fields == {"id", "name", "rareField"}


def test_python_walk_handles_dict_of_lists_payload(tmp_path):
    # e.g. raid_bosses' {"currentList": {"lvl5": [...], "lvl1": [...]}} shape --
    # the walk must find fields regardless of top-level container shape, since
    # it isn't using unwrap_path/iterate_mode at all (unlike src/engine.py).
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps({
        "currentList": {"lvl5": [{"pokemonId": 383}], "lvl1": [{"pokemonId": 1, "shiny": True}]}
    }))
    fields = extract_fields_python_walk(data_file)
    assert "currentList.lvl5.pokemonId" in fields
    assert "currentList.lvl1.shiny" in fields


def test_duckdb_auto_finds_top_level_and_nested_fields(tmp_path):
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps([
        {"id": 1, "names": {"English": "Bulbasaur"}},
        {"id": 2, "names": {"English": "Ivysaur"}},
    ]))
    fields, _ = extract_fields_duckdb_auto(data_file)
    assert "id" in fields
    assert "names" in fields
    assert "names.English" in fields


import yaml
from src.paranoid_check import find_templates_for_source, find_raw_files_for_source, mapped_source_fields


def test_find_templates_for_source_reads_source_key_field_not_filename(tmp_path):
    # Regression guard for the documented footgun: a template's filename does
    # NOT reliably match its source_key (e.g. game_master_*.yml files declare
    # source_key: alexelgt_game_masters internally).
    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True)
    (templates_dir / "weirdly_named_file.yml").write_text(yaml.dump({
        "source_key": "pogoapi_net", "endpoint": "badges",
        "field_mappings": {"name": {"source_field": "name", "transform": "direct"}},
    }))
    (templates_dir / "other_source.yml").write_text(yaml.dump({
        "source_key": "pokeapi", "endpoint": "pokemon",
        "field_mappings": {},
    }))

    result = find_templates_for_source("pogoapi_net", templates_dir)

    assert len(result) == 1
    assert result[0]["endpoint"] == "badges"


def test_find_raw_files_for_source_excludes_meta_json(tmp_path):
    raw_dumps_dir = tmp_path / "raw_dumps"
    snapshot_dir = raw_dumps_dir / "pogoapi_net" / "2026-01-01T000000Z"
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "badges.json").write_text("[]")
    (snapshot_dir / "cp_multiplier.json").write_text("[]")
    (snapshot_dir / ".meta.json").write_text("{}")

    result = find_raw_files_for_source("pogoapi_net", raw_dumps_dir)

    assert {f.name for f in result} == {"badges.json", "cp_multiplier.json"}


def test_find_raw_files_for_source_uses_latest_snapshot_only(tmp_path):
    raw_dumps_dir = tmp_path / "raw_dumps"
    old_dir = raw_dumps_dir / "pogoapi_net" / "2026-01-01T000000Z"
    new_dir = raw_dumps_dir / "pogoapi_net" / "2026-06-01T000000Z"
    old_dir.mkdir(parents=True)
    new_dir.mkdir(parents=True)
    (old_dir / "badges.json").write_text("[]")
    (new_dir / "badges.json").write_text("[]")
    (new_dir / "cp_multiplier.json").write_text("[]")

    result = find_raw_files_for_source("pogoapi_net", raw_dumps_dir)

    assert {f.name for f in result} == {"badges.json", "cp_multiplier.json"}
    assert all(f.parent == new_dir for f in result)


def test_mapped_source_fields_combines_field_mappings_and_overrides_per_endpoint():
    templates = [
        {
            "source_key": "pogoapi_net", "endpoint": "badges",
            "field_mappings": {"name": {"source_field": "name", "transform": "direct"}},
            "overrides": {"description": {"source_field": "description", "transform": "direct"}},
        },
        {
            "source_key": "pogoapi_net", "endpoint": "cp_multiplier",
            "field_mappings": {"level": {"source_field": "level", "transform": "direct"}},
        },
    ]

    result = mapped_source_fields(templates)

    assert result["badges"] == {"name", "description"}
    assert result["cp_multiplier"] == {"level"}


import pytest


def test_duckdb_auto_returns_none_fields_on_parse_failure(tmp_path):
    # A top-level array where a later record has a key no earlier record had,
    # placed far enough into the file that DuckDB's schema-inference sampling
    # won't have seen it -- real DuckDB behavior is to raise, not silently
    # omit the field. 25,000 plain records comfortably exceeds any reasonable
    # default sample size.
    import json
    records = [{"id": i, "name": f"item{i}"} for i in range(25000)]
    records[-1]["rareField"] = "only on the last record"
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps(records))

    fields, collapsed = extract_fields_duckdb_auto(data_file)

    assert fields is None
    assert collapsed == []


def test_duckdb_auto_records_collapsed_map_type_paths(tmp_path):
    import json
    # A dict-of-heterogeneous-dicts under one key -- DuckDB infers this as
    # MAP(VARCHAR, ...), the same shape real GAME_MASTER.json's "data" field
    # produces. DEVIATION FROM BRIEF: the brief's original 2-record fixture
    # (just pokemonSettings/combatMove) does NOT actually trigger a MAP
    # collapse on the installed DuckDB version (1.5.5) -- empirically
    # verified it infers a plain STRUCT unioning both keys. Measured the
    # threshold directly: 8 distinct keys under "data" still infers STRUCT,
    # 10 switches to MAP (not exposed as a documented setting). Padded with
    # extra distinct keys to cross that threshold while keeping the original
    # two keys to preserve intent.
    records = [
        {"templateId": "A", "data": {"pokemonSettings": {"dex": 1}}},
        {"templateId": "B", "data": {"combatMove": {"power": 70}}},
    ]
    for i in range(10):
        records.append({"templateId": f"X{i}", "data": {f"extraKey{i}": {"x": i}}})
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps(records))

    fields, collapsed = extract_fields_duckdb_auto(data_file)

    assert fields is not None
    assert "data" in fields
    assert "data" in collapsed
    # Nothing beneath the collapsed MAP was (and couldn't be) discovered --
    # confirms the collapse is recorded rather than silently producing a
    # false negative that looks identical to "field doesn't exist".
    assert "data.pokemonSettings" not in fields


def test_duckdb_auto_no_collapse_on_a_normal_struct(tmp_path):
    import json
    data_file = tmp_path / "data.json"
    data_file.write_text(json.dumps([{"id": 1, "names": {"English": "Bulbasaur"}}]))

    fields, collapsed = extract_fields_duckdb_auto(data_file)

    assert fields == {"id", "names", "names.English"}
    assert collapsed == []
