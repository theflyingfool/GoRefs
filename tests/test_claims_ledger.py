from src.builder import GoRefsMasterEngine


def test_emit_claim_appends_to_ledger(tmp_path):
    engine = GoRefsMasterEngine(db_path=tmp_path / "test.duckdb")
    engine.emit_claim("pokemon_dex_1", "base_attack", "alexelgt_game_masters", 118)
    assert len(engine.claims_ledger) == 1
    claim = engine.claims_ledger[0]
    assert claim["entity_id"] == "pokemon_dex_1"
    assert claim["attribute"] == "base_attack"
    assert claim["source"] == "alexelgt_game_masters"
    assert claim["value"] == 118
    assert claim["priority"] == 2  # from TRUST_HIERARCHY


def test_emit_claim_ignores_none_values(tmp_path):
    engine = GoRefsMasterEngine(db_path=tmp_path / "test.duckdb")
    engine.emit_claim("pokemon_dex_1", "base_attack", "pogoapi_net", None)
    assert len(engine.claims_ledger) == 0
