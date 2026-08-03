from pathlib import Path
from unittest.mock import patch, MagicMock

from src.builder import GoRefsMasterEngine


def test_pokeapi_claims_flow_through_ledger_via_engine(tmp_path):
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.run_source") as mock_run_source, \
         patch("src.builder.FetcherRegistry") as mock_registry:
        def _run_source_side_effect(source_key, **kwargs):
            if source_key == "pokeapi_pokemon":
                return [{"entity_id": "pokeapi_bulbasaur", "attribute": "name", "source": "pokeapi", "value": "bulbasaur", "priority": 7}]
            return []
        mock_run_source.side_effect = _run_source_side_effect
        fetcher = MagicMock()
        fetcher.load_latest_raw.return_value = []
        fetcher.extract_structured_claims.return_value = {}
        mock_registry.get_fetcher_class.return_value = lambda *a: fetcher

        engine.collect_and_resolve_claims()

    mock_run_source.assert_any_call("pokeapi_pokemon", raw_dumps_dir=tmp_path, templates_dir=Path("config/source_templates"))
    pokeapi_claims = [c for c in engine.claims_ledger if c["source"] == "pokeapi"]
    assert len(pokeapi_claims) == 1
