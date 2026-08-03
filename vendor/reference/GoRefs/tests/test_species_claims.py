import json

from src.builder import GoRefsMasterEngine
from unittest.mock import patch, MagicMock


def _fake_fetcher(raw_by_name):
    fetcher = MagicMock()
    fetcher.load_latest_raw.side_effect = lambda name: raw_by_name.get(name)
    fetcher.extract_structured_claims.return_value = {}
    return fetcher


def test_species_build_emits_base_stat_claims(tmp_path):
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    pokedex_raw = [{
        "dexNr": 1, "names": {"English": "Bulbasaur"}, "generation": 1,
        "primaryType": {"type": "POKEMON_TYPE_GRASS"}, "assets": {},
    }]

    # Since Task 20's cutover, "name"/"generation" claims for pokemon_dex_<n>
    # come from engine.run_source("pokemon_go_api_pokedex", ...), which reads
    # config/source_templates/pokemon_go_api_pokedex.yml and the raw JSON
    # snapshot directly off disk (raw_dumps_dir/pokemon_go_api/<snapshot>/
    # pokedex.json) -- NOT via the FetcherRegistry-mocked
    # pg_api_fetcher.load_latest_raw("pokedex") this test used to rely on for
    # that data. A real snapshot file is written here so the templated engine
    # path picks it up; FetcherRegistry is still mocked for
    # alexelgt_game_masters (not yet cut over) and for pokemon_go_api's other
    # legacy-consumed endpoints (raidboss/maxbattles/quests are also cut over
    # to file-based reads now, so an empty currentList/list here is enough).
    snapshot_dir = tmp_path / "pokemon_go_api" / "2026-01-01T000000Z"
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "pokedex.json").write_text(json.dumps(pokedex_raw), encoding="utf-8")
    (snapshot_dir / "raidboss.json").write_text(json.dumps({"currentList": {}}), encoding="utf-8")
    (snapshot_dir / "maxbattles.json").write_text(json.dumps({"currentList": {}}), encoding="utf-8")
    (snapshot_dir / "quests.json").write_text(json.dumps([]), encoding="utf-8")

    with patch("src.builder.FetcherRegistry") as mock_registry:
        def get_fetcher(key):
            if key == "alexelgt_game_masters":
                return lambda *a: _fake_fetcher_gm()
            if key == "pokemon_go_api":
                return lambda *a: _fake_fetcher({"pokedex": pokedex_raw, "raidboss": {}, "maxbattles": {}, "quests": []})
            return lambda *a: _fake_fetcher({})
        mock_registry.get_fetcher_class.side_effect = get_fetcher
        engine.collect_and_resolve_claims()

    dex1_claims = [c for c in engine.claims_ledger if c["entity_id"] == "pokemon_dex_1"]
    attrs_claimed = {c["attribute"] for c in dex1_claims}
    assert "name" in attrs_claimed
    assert "generation" in attrs_claimed


def _fake_fetcher_gm():
    fetcher = MagicMock()
    fetcher.extract_structured_claims.return_value = {"species_stats": {1: {"base_attack": 118, "base_defense": 111, "base_stamina": 128, "buddy_distance_km": 3.0}}}
    fetcher.load_latest_raw.return_value = None
    return fetcher
