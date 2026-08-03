import json
from unittest.mock import patch, MagicMock

from src.builder import GoRefsMasterEngine


def _write_gamemaster(tmp_path):
    snap_dir = tmp_path / "pvpoke" / "2026-01-01T000000Z"
    snap_dir.mkdir(parents=True)
    payload = {
        "moves": [
            {"moveId": "TACKLE", "name": "Tackle", "type": "normal", "power": 3,
             "energy": 0, "energyGain": 3, "cooldown": 500, "archetype": "General", "turns": 1},
            {"moveId": "ACID", "name": "Acid", "type": "poison", "power": 6,
             "energy": 0, "energyGain": 8, "cooldown": 1000, "archetype": "Multipurpose", "turns": 2},
            {"moveId": "SLUDGE_BOMB", "name": "Sludge Bomb", "type": "poison", "power": 80,
             "energy": 50, "cooldown": 500, "buffs": [0, -1], "buffTarget": "opponent",
             "buffApplyChance": "0.1", "archetype": "Debuff", "turns": 1},
        ],
        "formats": [
            {"title": "Great League", "cup": "great", "cp": 1500, "meta": "great"},
        ],
    }
    (snap_dir / "gamemaster.json").write_text(json.dumps(payload))


def _fake_fetcher(raw_by_name):
    fetcher = MagicMock()
    fetcher.load_latest_raw.side_effect = lambda name: raw_by_name.get(name)
    fetcher.extract_structured_claims.return_value = {}
    return fetcher


def test_pvpoke_move_claims_join_onto_pogoapi_net_numeric_move_entity_id(tmp_path):
    _write_gamemaster(tmp_path)
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    fast_moves_raw = [{"move_id": 221, "name": "Tackle", "type": "Normal", "power": 5,
                        "duration": 500, "energy_delta": 5}]
    charged_moves_raw = [{"move_id": 999, "name": "Sludge Bomb", "type": "Poison", "power": 80,
                           "duration": 2600, "energy_delta": -50}]

    def get_fetcher(key):
        if key == "pogoapi_net":
            return lambda *a: _fake_fetcher({"fast_moves": fast_moves_raw, "charged_moves": charged_moves_raw})
        return lambda *a: _fake_fetcher({})

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.side_effect = get_fetcher
        engine.collect_and_resolve_claims()

    # pogoapi_net's fast-moves loop assigns Tackle entity_id "move_221" (its own
    # numeric move_id). pvpoke only has a string moveId ("TACKLE") with no numeric
    # id of its own, so its claims must be joined (by normalized move name) onto
    # this SAME entity_id for trust-tier resolution to ever see both sources'
    # claims together.
    tackle_pvp_claims = {
        c["attribute"]: c["value"]
        for c in engine.claims_ledger
        if c["entity_id"] == "move_221" and c["source"] == "pvpoke"
    }
    assert tackle_pvp_claims.get("pvp_power") == 3
    assert tackle_pvp_claims.get("pvp_energy_cost") == 0
    assert tackle_pvp_claims.get("pvp_cooldown_turns") == 1

    sludge_pvp_claims = {
        c["attribute"]: c["value"]
        for c in engine.claims_ledger
        if c["entity_id"] == "move_999" and c["source"] == "pvpoke"
    }
    assert sludge_pvp_claims.get("pvp_power") == 80
    assert sludge_pvp_claims.get("stat_buffs") is not None


def test_pvpoke_formats_claims_land_on_pvp_league_entity_id(tmp_path):
    _write_gamemaster(tmp_path)
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.return_value = lambda *a: _fake_fetcher({})
        canonical = engine.collect_and_resolve_claims()

    league_claims = {
        c["attribute"]: c["value"]
        for c in engine.claims_ledger
        if c["entity_id"] == "pvp_league_Great League" and c["source"] == "pvpoke"
    }
    assert league_claims.get("cp_limit") == 1500
    assert league_claims.get("meta") == "great"

    matching = [l for l in canonical["pvp_leagues"] if l["league_id"] == "Great League"]
    assert len(matching) == 1
    assert matching[0]["cp_limit"] == 1500
