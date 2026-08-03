from src.builder import GoRefsMasterEngine


def test_resolve_all_claims_picks_highest_priority(tmp_path):
    engine = GoRefsMasterEngine(db_path=tmp_path / "test.duckdb")
    engine.emit_claim("pokemon_dex_1", "base_attack", "pogoapi_net", 999)   # priority 6
    engine.emit_claim("pokemon_dex_1", "base_attack", "alexelgt_game_masters", 118)  # priority 2, wins

    resolved = engine.resolve_all_claims()

    assert resolved[("pokemon_dex_1", "base_attack")] == 118
    assert len(engine.discrepancies) == 1  # values disagreed


def test_resolve_all_claims_no_discrepancy_when_claims_agree(tmp_path):
    engine = GoRefsMasterEngine(db_path=tmp_path / "test.duckdb")
    engine.emit_claim("pokemon_dex_1", "generation", "pokemon_go_api", 1)

    resolved = engine.resolve_all_claims()

    assert resolved[("pokemon_dex_1", "generation")] == 1
    assert len(engine.discrepancies) == 0
