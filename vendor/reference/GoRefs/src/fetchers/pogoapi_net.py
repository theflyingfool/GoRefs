"""Fetcher module for pogoapi.net static endpoints."""

import requests
from pathlib import Path
from .base import BaseFetcher, FetcherRegistry


@FetcherRegistry.register("pogoapi_net")
class PogoApiFetcher(BaseFetcher):
    """Fetcher for all static reference endpoints from pogoapi.net."""

    def fetch(self, force: bool = False) -> Path:
        """Fetches all configured static reference JSON endpoints from pogoapi.net.

        Args:
            force: If True, bypasses deduplication checks and forces fresh download.

        Returns:
            Path to the saved snapshot directory.
        """
        base_url = self.config.get("base_url")
        endpoints = self.config.get("endpoints", [])

        # Pre-flight check on a representative endpoint (first configured one)
        representative = endpoints[0] if endpoints else None
        if representative:
            rep_url = f"{base_url}{representative['path']}"
            cached_snapshot = self.is_remote_unchanged(rep_url, force=force)
            if cached_snapshot:
                return cached_snapshot

        snapshot_dir = self.create_snapshot_dir()
        rep_etag = None
        print(f"[{self.source_key}] Fetching endpoints from {base_url}...")
        for ep in endpoints:
            name = ep.get("name")
            path = ep.get("path")
            url = f"{base_url}{path}"
            print(f"[{self.source_key}] Fetching '{name}' from {url}...")
            try:
                res = requests.get(url, timeout=30)
                res.raise_for_status()
                if representative and name == representative.get("name"):
                    rep_etag = res.headers.get("ETag") or res.headers.get("Last-Modified")
                data = res.json()
                self.save_raw(snapshot_dir, name, data)
            except Exception as e:
                print(f"[{self.source_key}] Warning: Failed to fetch {name}: {e}")

        print(f"[{self.source_key}] Snapshot completed at {snapshot_dir}")
        return self.finalize_snapshot(snapshot_dir, etag=str(rep_etag).strip('"') if rep_etag else None, force=force)
