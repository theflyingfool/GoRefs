"""Cutover test for local_authoring -> generic engine (Task 23).

local_authoring's costume-lookup.json is structurally different from every
other cutover so far: it's a flat dict-of-scalars lookup mapping a shared
costume TOKEN (the same raw string pokemon_go_api_pokedex.yml's sub_records
already write verbatim into forms.costume_name) to a curated display name, or
"" where nobody has curated one yet -- not a per-entity record set. This is
the source's first real integration into collect_and_resolve_claims at all
(grep confirms local_authoring previously only appeared in TRUST_HIERARCHY
and the fetcher registry).

The brief's literal Step 3 instruction ("assert local_authoring's claims
(priority 1) would win over any conflicting lower-priority claim for the same
entity/attribute") doesn't apply here: nothing else in the pipeline produces
a `display_name` attribute on a `costume_token_*` entity_id, so there is
nothing to conflict with -- these are the only claims that will ever exist
under that entity_id/attribute pair. The closest sound equivalent is asserted
below: a curated (non-empty) display name reaches the claims ledger and, from
there, the forms table's new costume_display_name field; an empty-string
entry does not produce a spurious claim/override.

Like test_cutover_rplus_shiny.py, the raw snapshot is written directly to
tmp_path/local_authoring/... on disk and FetcherRegistry lookups are mocked
away, so any claim seen provably came from engine.run_source() reading the
templated snapshot, not the legacy fetcher path.
"""
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

from src.builder import GoRefsMasterEngine
from src.engine import run_source


def _write_costume_lookup(tmp_path):
    snap_dir = tmp_path / "local_authoring" / "2026-01-01T000000Z"
    snap_dir.mkdir(parents=True)
    payload = {
        "FASHION_2021_NOEVOLVE": "Fashionable costume",
        "ANNIVERSARY_2024": "",
    }
    (snap_dir / "costume-lookup.json").write_text(json.dumps(payload))


def _fake_fetcher(raw_by_name):
    fetcher = MagicMock()
    fetcher.load_latest_raw.side_effect = lambda name: raw_by_name.get(name)
    fetcher.extract_structured_claims.return_value = {}
    return fetcher


def test_run_source_alone_lets_empty_string_through():
    # Documents the precedent this cutover follows (same as
    # test_rplus_shiny_empty_string_debut_produces_no_claim): run_source()'s
    # own filter is only `value is not None`, so "" alone passes it. The
    # builder.py-side truthy filter (asserted below) is what actually excludes
    # uncurated tokens from the ledger.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        _write_costume_lookup(tmp_path)
        claims = run_source(
            "local_authoring_costume-lookup",
            raw_dumps_dir=tmp_path,
            templates_dir=Path("config/source_templates"),
        )
        blank_claims = [
            c for c in claims
            if c["entity_id"] == "costume_token_ANNIVERSARY_2024" and c["attribute"] == "display_name"
        ]
        assert blank_claims and blank_claims[0]["value"] == ""


def test_curated_costume_token_produces_display_name_claim(tmp_path):
    _write_costume_lookup(tmp_path)
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.side_effect = lambda key: (lambda *a: _fake_fetcher({}))
        engine.collect_and_resolve_claims()

    matches = [
        c for c in engine.claims_ledger
        if c["entity_id"] == "costume_token_FASHION_2021_NOEVOLVE" and c["attribute"] == "display_name"
    ]
    assert len(matches) == 1
    assert matches[0]["value"] == "Fashionable costume"
    assert matches[0]["source"] == "local_authoring"
    assert matches[0]["priority"] == 1


def test_uncurated_empty_string_token_produces_no_ledger_claim(tmp_path):
    _write_costume_lookup(tmp_path)
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.side_effect = lambda key: (lambda *a: _fake_fetcher({}))
        engine.collect_and_resolve_claims()

    blank_matches = [
        c for c in engine.claims_ledger
        if c["entity_id"] == "costume_token_ANNIVERSARY_2024" and c["attribute"] == "display_name"
    ]
    assert blank_matches == []
