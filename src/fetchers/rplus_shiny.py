"""Fetcher module for Rplus shiny releases sheet."""

import requests
from pathlib import Path
from .base import BaseFetcher, FetcherRegistry


@FetcherRegistry.register("rplus_shiny")
class RplusShinyFetcher(BaseFetcher):
    """Fetcher for per-form shiny release dates spreadsheet via opensheet."""

    def fetch(self, force: bool = False) -> Path:
        """Fetches latest Rplus shiny release dates spreadsheet payload.

        Args:
            force: If True, forces download ignoring pre-flight check.

        Returns:
            Path to saved snapshot directory.

        Raises:
            ValueError: If source URL is missing from configuration.
        """
        url = self.config.get("url")
        if not url:
            raise ValueError("No URL configured for rplus_shiny source.")

        cached_snapshot = self.is_remote_unchanged(url, force=force)
        if cached_snapshot:
            return cached_snapshot

        print(f"[{self.source_key}] Remote update detected. Fetching shiny release sheet from {url}...")
        try:
            res = requests.get(url, timeout=30)
            res.raise_for_status()
            etag = res.headers.get("ETag") or res.headers.get("Last-Modified")
            data = res.json()
            snapshot_dir = self.create_snapshot_dir()
            self.save_raw(snapshot_dir, "shiny_releases", data)
            return self.finalize_snapshot(snapshot_dir, etag=str(etag).strip('"') if etag else None, force=force)
        except Exception as e:
            print(f"[{self.source_key}] Warning: Failed to fetch shiny sheet: {e}")
            latest = self.get_latest_snapshot_dir()
            if latest:
                return latest
            raise
