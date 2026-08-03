from pathlib import Path
from unittest.mock import patch, MagicMock

from src.builder import GoRefsMasterEngine


def test_pogoapi_net_badges_claims_flow_through_ledger_via_engine(tmp_path):
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.run_source") as mock_run_source, \
         patch("src.builder.FetcherRegistry") as mock_registry:
        mock_run_source.return_value = [
            {"entity_id": "pogoapi_net_badges_Triathlete", "attribute": "name", "source": "pogoapi_net", "value": "Triathlete", "priority": 6}
        ]
        fetcher = MagicMock()
        fetcher.load_latest_raw.return_value = []
        fetcher.extract_structured_claims.return_value = {}
        mock_registry.get_fetcher_class.return_value = lambda *a: fetcher

        engine.collect_and_resolve_claims()

    mock_run_source.assert_any_call("pogoapi_net_badges", raw_dumps_dir=tmp_path, templates_dir=Path("config/source_templates"))
    pogoapi_net_claims = [c for c in engine.claims_ledger if c["source"] == "pogoapi_net" and c["entity_id"] == "pogoapi_net_badges_Triathlete"]
    assert len(pogoapi_net_claims) >= 1
