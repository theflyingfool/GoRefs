"""Fetcher module for pokeapi.co endpoints."""

import requests
from pathlib import Path
from .base import BaseFetcher, FetcherRegistry


@FetcherRegistry.register("pokeapi")
class PokeApiFetcher(BaseFetcher):
    """Fetcher for base taxonomy endpoints from pokeapi.co."""

    def fetch(self, force: bool = False) -> Path:
        """Fetches species, pokemon, type, and move limit endpoints from pokeapi.co.

        Args:
            force: If True, forces download ignoring deduplication checks.

        Returns:
            Path to saved snapshot directory.
        """
        base_url = self.config.get("base_url")
        endpoints = self.config.get("endpoints", [])

        if not endpoints:
            try:
                index_res = requests.get(f"{base_url}/" if not base_url.endswith("/") else base_url, timeout=30)
                index_res.raise_for_status()
                index_map = index_res.json()
                if isinstance(index_map, dict):
                    target_resources = ["pokemon", "pokemon-species", "type", "move"]
                    endpoints = [
                        {"name": res_key.replace("-", "_"), "path": f"/{res_key}?limit=1025"}
                        for res_key in target_resources if res_key in index_map
                    ]
            except Exception as e:
                print(f"[{self.source_key}] Warning: Endpoint index discovery failed: {e}")

        representative = next((e for e in endpoints if e.get("name") == "pokemon"), endpoints[0] if endpoints else None)
        if representative:
            rep_url = f"{base_url}{representative['path']}" if representative["path"].startswith("/") else f"{base_url}/{representative['path']}"
            cached_snapshot = self.is_remote_unchanged(rep_url, force=force)
            if cached_snapshot:
                return cached_snapshot

        snapshot_dir = self.create_snapshot_dir()
        rep_etag = None
        print(f"[{self.source_key}] Fetching endpoints from {base_url}...")
        for ep in endpoints:
            name = ep.get("name")
            path = ep.get("path")
            url = f"{base_url}{path}" if path.startswith("/") else f"{base_url}/{path}"
            print(f"[{self.source_key}] Fetching '{name}' from {url}...")
            try:
                res = requests.get(url, timeout=45)
                res.raise_for_status()
                if representative and name == representative.get("name"):
                    rep_etag = res.headers.get("ETag") or res.headers.get("Last-Modified")
                data = res.json()
                self.save_raw(snapshot_dir, name, data)
            except Exception as e:
                print(f"[{self.source_key}] Warning: Failed to fetch {name}: {e}")

        print(f"[{self.source_key}] Snapshot completed at {snapshot_dir}")
        return self.finalize_snapshot(snapshot_dir, etag=str(rep_etag).strip('"') if rep_etag else None, force=force)

