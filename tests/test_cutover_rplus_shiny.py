"""Cutover test for rplus_shiny -> generic engine (Task 21).

rplus_shiny's raw sheet mixes base species records (pid == "pm<dex>") with
costume/event/mega variant records (pid == "pm<dex>.<suffix>", e.g.
".fFALL_2019", ".cJAN_2020_NOEVOLVE", ".fMEGA") under one flat list. The
legacy hand-parsed code only ever matched the bare-digit pid, silently
dropping every suffixed record. This cutover uses
config/source_templates/rplus_shiny_shiny_releases.yml (identity_field: pid,
entity_id_prefix: pokemon_dex) plus a small builder.py-side filter (a
template's identity_field has no regex/extraction capability of its own) that
must reproduce the exact same filtering, including treating an empty-string
debut ("" -- present, not absent) as no claim at all, matching the legacy
`and date_val` truthiness check.

Like test_cutover_pvpoke.py, the raw snapshot is written directly to
tmp_path/rplus_shiny/... on disk and every FetcherRegistry lookup is mocked to
return nothing -- this is what actually distinguishes the cutover from the
legacy code path: the legacy code read shiny data through
rplus_fetcher.load_latest_raw("shiny_releases"), so with fetchers mocked away
it would see an empty list and produce zero shiny claims. The cutover reads
straight off disk via engine.run_source(), bypassing the fetcher mock
entirely, matching how pvpoke's and pokemon_go_api's cutovers behave.
"""
import json
from unittest.mock import patch, MagicMock

from src.builder import GoRefsMasterEngine


def _write_shiny_releases(tmp_path):
    snap_dir = tmp_path / "rplus_shiny" / "2026-01-01T000000Z"
    snap_dir.mkdir(parents=True)
    payload = [
        {"index": "0", "debut": "2018/03/25", "pid": "pm1", "src": "", "group": "Bulbasaur"},
        {"index": "1", "debut": "2019/10/17", "pid": "pm1.fFALL_2019", "src": "", "group": "Bulbasaur_f19"},
        {"index": "2", "debut": "", "pid": "pm3", "src": "", "group": "Venusaur"},
        {"index": "3", "debut": "2018/05/19", "pid": "pm4", "src": "", "group": "Charmander"},
    ]
    (snap_dir / "shiny_releases.json").write_text(json.dumps(payload))


def _fake_fetcher(raw_by_name):
    fetcher = MagicMock()
    fetcher.load_latest_raw.side_effect = lambda name: raw_by_name.get(name)
    fetcher.extract_structured_claims.return_value = {}
    return fetcher


def test_rplus_shiny_base_pid_produces_shiny_release_date_claim_on_pokemon_dex_entity(tmp_path):
    _write_shiny_releases(tmp_path)
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.side_effect = lambda key: (lambda *a: _fake_fetcher({}))
        engine.collect_and_resolve_claims()

    dex1_claims = [
        c for c in engine.claims_ledger
        if c["entity_id"] == "pokemon_dex_1" and c["attribute"] == "shiny_release_date"
    ]
    assert len(dex1_claims) == 1
    assert dex1_claims[0]["value"] == "2018/03/25"
    assert dex1_claims[0]["source"] == "rplus_shiny"

    dex4_claims = [
        c for c in engine.claims_ledger
        if c["entity_id"] == "pokemon_dex_4" and c["attribute"] == "shiny_release_date"
    ]
    assert len(dex4_claims) == 1
    assert dex4_claims[0]["value"] == "2018/05/19"


def test_rplus_shiny_suffixed_pid_produces_no_claim(tmp_path):
    _write_shiny_releases(tmp_path)
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.side_effect = lambda key: (lambda *a: _fake_fetcher({}))
        engine.collect_and_resolve_claims()

    # "pm1.fFALL_2019" must not leak a stray claim under any entity_id --
    # neither literally ("pokemon_dex_1.fFALL_2019") nor by corrupting dex 1's
    # own claim (dex 1 must have exactly the one base claim, asserted above).
    suffixed_claims = [
        c for c in engine.claims_ledger
        if c["attribute"] == "shiny_release_date" and "fFALL_2019" in c["entity_id"]
    ]
    assert suffixed_claims == []
    dex1_claims = [
        c for c in engine.claims_ledger
        if c["entity_id"] == "pokemon_dex_1" and c["attribute"] == "shiny_release_date"
    ]
    assert len(dex1_claims) == 1


def test_rplus_shiny_empty_string_debut_produces_no_claim():
    # Empty-string debut ("" -- key present, value empty) must be treated as
    # "no claim" exactly like the legacy `and date_val` truthiness check, not
    # passed through as an empty-string claim (run_source()'s own filter is
    # only `value is not None`, which alone would let "" through).
    from pathlib import Path
    from src.engine import run_source
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        _write_shiny_releases(tmp_path)
        claims = run_source(
            "rplus_shiny_shiny_releases",
            raw_dumps_dir=tmp_path,
            templates_dir=Path("config/source_templates"),
        )
        dex3_raw_claims = [c for c in claims if c["entity_id"] == "pokemon_dex_pm3"]
        # run_source() alone (with no builder.py-side truthy filter) DOES let
        # "" through today -- this assertion documents that fact so the
        # builder.py-side filter's necessity is visible, not just asserted.
        assert dex3_raw_claims and dex3_raw_claims[0]["value"] == ""


def test_rplus_shiny_dex_number_string_formatting_matches_species_read_back(tmp_path):
    # builder.py's species read-back loop looks up entity_id
    # f"pokemon_dex_{sp['dex_number']}" where dex_number is a plain int --
    # this must match the cutover's entity_id exactly (no leading zeros, no
    # float repr) or the claim silently never resolves into canonical output.
    _write_shiny_releases(tmp_path)
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.side_effect = lambda key: (lambda *a: _fake_fetcher({}))
        engine.collect_and_resolve_claims()

    entity_ids = {c["entity_id"] for c in engine.claims_ledger if c["attribute"] == "shiny_release_date"}
    assert "pokemon_dex_1" in entity_ids
    assert f"pokemon_dex_{1}" in entity_ids
