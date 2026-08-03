from src.builder import GoRefsMasterEngine
from unittest.mock import patch, MagicMock


def test_badges_build_produces_badges_list(tmp_path):
    # Post-Task-18-cutover: badges are no longer emitted onto the claims ledger via
    # hand-parsing (that's now run_source("pogoapi_net_badges", ...), see
    # tests/test_cutover_pogoapi_net.py) -- but the "badges" canonical output list is
    # still hand-built directly from badges_raw, one row per raw record (not
    # deduplicated by entity), because the generic engine's entity-deduplicated claims
    # model can't reproduce this table's 597-row legacy shape. This test now checks
    # that canonical output, not ledger claims.
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")
    badges_raw = [{"id": "Triathlete", "name": "Triathlete", "event_badge": False, "description": "desc", "rank": 5, "targets": [1, 10]}]

    fetcher = MagicMock()
    fetcher.load_latest_raw.side_effect = lambda name: {"badges": badges_raw}.get(name, [] if name not in ("raidboss", "maxbattles") else {})
    fetcher.extract_structured_claims.return_value = {}

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.return_value = lambda *a: fetcher
        canonical = engine.collect_and_resolve_claims()

    matching = [b for b in canonical["badges"] if b["badge_id"] == "Triathlete"]
    assert len(matching) == 1
    assert matching[0]["name"] == "Triathlete"
    assert matching[0]["is_event_badge"] is False
    assert matching[0]["description"] == "desc"
    assert matching[0]["rank"] == 5
