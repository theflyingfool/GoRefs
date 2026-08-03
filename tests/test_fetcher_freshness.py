from unittest.mock import patch, MagicMock
from src.fetchers.pogoapi_net import PogoApiFetcher
from src.fetchers.pokeapi import PokeApiFetcher


def test_pogoapi_net_skips_fetch_when_unchanged(tmp_path):
    config = {
        "base_url": "https://pogoapi.net/api/v1",
        "endpoints": [{"name": "cp_multiplier", "path": "/cp_multiplier.json"}],
    }
    fetcher = PogoApiFetcher("pogoapi_net", config, base_dump_dir=tmp_path)
    with patch.object(fetcher, "is_remote_unchanged", return_value=tmp_path / "pogoapi_net" / "cached") as mock_check:
        (tmp_path / "pogoapi_net" / "cached").mkdir(parents=True)
        with patch("requests.get") as mock_get:
            result = fetcher.fetch()
            mock_check.assert_called_once()
            mock_get.assert_not_called()
            assert result == tmp_path / "pogoapi_net" / "cached"


def test_pokeapi_skips_fetch_when_unchanged(tmp_path):
    config = {"base_url": "https://pokeapi.co/api/v2", "endpoints": [{"name": "pokemon", "path": "/pokemon?limit=1025"}]}
    fetcher = PokeApiFetcher("pokeapi", config, base_dump_dir=tmp_path)
    with patch.object(fetcher, "is_remote_unchanged", return_value=tmp_path / "pokeapi" / "cached") as mock_check:
        (tmp_path / "pokeapi" / "cached").mkdir(parents=True)
        with patch("requests.get") as mock_get:
            result = fetcher.fetch()
            mock_check.assert_called_once()
            mock_get.assert_not_called()
            assert result == tmp_path / "pokeapi" / "cached"


def test_pokeapi_dynamic_discovery_with_preflight_check(tmp_path):
    """Test that dynamic endpoint discovery runs before pre-flight check, and pre-flight check is called with discovered endpoint."""
    config = {"base_url": "https://pokeapi.co/api/v2"}
    # No endpoints key - triggers dynamic discovery
    fetcher = PokeApiFetcher("pokeapi", config, base_dump_dir=tmp_path)

    # Mock the index discovery response
    index_response = MagicMock()
    index_response.json.return_value = {
        "pokemon": "https://pokeapi.co/api/v2/pokemon",
        "pokemon-species": "https://pokeapi.co/api/v2/pokemon-species",
        "type": "https://pokeapi.co/api/v2/type",
        "move": "https://pokeapi.co/api/v2/move",
    }

    cached_path = tmp_path / "pokeapi" / "cached"
    cached_path.mkdir(parents=True)

    with patch.object(fetcher, "is_remote_unchanged", return_value=cached_path) as mock_check:
        with patch("requests.get") as mock_get:
            # The index discovery request should succeed
            mock_get.return_value = index_response
            result = fetcher.fetch()

            # Verify pre-flight check was called exactly once
            mock_check.assert_called_once()

            # Verify it was called with the pokemon endpoint URL (discovered endpoint)
            called_url = mock_check.call_args[0][0]
            assert "pokemon?limit=1025" in called_url, f"Pre-flight check URL should contain 'pokemon?limit=1025', got: {called_url}"

            # Verify that main fetch requests were never called
            # (only index discovery request would have been made, then pre-flight returned cached)
            # So requests.get should only be called once (for index discovery)
            assert mock_get.call_count == 1, f"requests.get should be called once for index discovery, got {mock_get.call_count} calls"

            # Verify result is the cached path
            assert result == cached_path
