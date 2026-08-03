import json
from pathlib import Path
from src.engine import run_source

FIXTURES = Path(__file__).parent / "fixtures"


def test_run_source_writes_versioned_parsed_dump(tmp_path):
    run_source(
        "fixture_source",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
        parsed_dumps_dir=tmp_path / "parsed_dumps",
    )
    written = list((tmp_path / "parsed_dumps" / "fixture_source").glob("*/claims.jsonl"))
    assert len(written) == 1
    assert written[0].parent.name == "2026-01-01T000000Z"  # matches the raw snapshot's own timestamp
    lines = written[0].read_text().splitlines()
    assert len(lines) > 0
    assert json.loads(lines[0])["entity_id"] == "fixture_source_1"
