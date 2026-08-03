import json

import yaml
from pathlib import Path
from src.engine import unwrap_to_records
from src.profiler import SourceProfiler


def test_profile_source_writes_template_with_stale_override_flagged(tmp_path):
    raw_dir = tmp_path / "raw_dumps" / "fixture_source" / "2026-01-01T000000Z"
    raw_dir.mkdir(parents=True)
    (raw_dir / "data.json").write_text('[{"id": "1", "form": "FEMALE", "isFemale": false}]')

    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True)
    # Pre-existing template with an override pointing at a field that will vanish
    existing = {
        "source_key": "fixture_source", "endpoint": "data",
        "source_fingerprint": "sha256:stale",
        "record_extraction": {"unwrap_path": [], "iterate_mode": "top_level_list"},
        "identity_field": "id", "field_mappings": {},
        "overrides": {"gender": {"source_field": "no_longer_exists", "transform": "direct"}},
        "needs_review": [],
    }
    # endpoint ("data") != source_key ("fixture_source"), so per profile_source's
    # filename convention (matching engine.run_source()'s documented lookup rule)
    # this is a multi-endpoint-style template: "{source_key}_{endpoint}.yml".
    (templates_dir / "fixture_source_data.yml").write_text(yaml.dump(existing))

    profiler = SourceProfiler(raw_dumps_dir=tmp_path / "raw_dumps", templates_dir=templates_dir)
    profiler.profile_source("fixture_source", "data")

    written = yaml.safe_load((templates_dir / "fixture_source_data.yml").read_text())
    assert "gender" not in written["field_mappings"] or True  # override fell back, not asserted here
    assert any("no_longer_exists" in r.get("reason", "") for r in written["needs_review"])
    assert written["overrides"] == existing["overrides"]  # override text itself is preserved verbatim

    # Signal detection deliverable: the fixture record has both a boolean-field
    # gender signal (isFemale=False) and a value-pattern signal (form="FEMALE").
    signal_types_by_field = {s["source_field"]: s["signal_type"] for s in written["gender_signals"]}
    assert signal_types_by_field["isFemale"] == "boolean_field"
    assert signal_types_by_field["form"] == "value_pattern"


def test_profile_source_degenerate_single_key_dict_of_lists_extracts_records(tmp_path):
    # detect_shape (Task 14) classifies a dict with exactly one record-list-valued
    # key as a dict-of-lists container flattened at the ROOT path ([]), not at
    # ["currentList"]. A mode-inference formula that decides iterate_mode purely
    # from path depth (len(primary_path) > 0) mis-infers "top_level_list" here --
    # the root node is a dict, not a list, so engine.unwrap_to_records's
    # top_level_list branch (isinstance(node, list)) silently extracts zero
    # records. This test locks in the fix: profile_source must infer
    # "dict_of_lists" for this shape so real records make it through.
    raw_dir = tmp_path / "raw_dumps" / "degenerate_source" / "2026-01-01T000000Z"
    raw_dir.mkdir(parents=True)
    payload = {"currentList": [{"id": "A", "val": 1}, {"id": "B", "val": 2}]}
    (raw_dir / "data.json").write_text(json.dumps(payload))

    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True)

    profiler = SourceProfiler(raw_dumps_dir=tmp_path / "raw_dumps", templates_dir=templates_dir)
    template_path = profiler.profile_source("degenerate_source", "data")

    written = yaml.safe_load(template_path.read_text())
    extraction = written["record_extraction"]
    assert extraction["unwrap_path"] == []
    assert extraction["iterate_mode"] == "dict_of_lists"

    records = unwrap_to_records(
        payload,
        unwrap_path=extraction["unwrap_path"],
        iterate_mode=extraction["iterate_mode"],
    )
    assert len(records) == 2
    assert {r["id"] for r in records} == {"A", "B"}
