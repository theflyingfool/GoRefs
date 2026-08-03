"""Fetcher module for raw Niantic client GAME_MASTER.json dumps.

Fetches latest `GAME_MASTER.json` dumps from the `alexelgt/game_masters` repository. Structured
extraction (species stats, combat moves, CP multipliers, items, stickers, avatar items, friendship
milestones, and the raw template archive) is no longer done here -- see the game_master_*.yml
templates under config/source_templates/ and src/builder.py's collect_and_resolve_claims() (Task
22 cut this fetcher's former extract_structured_claims() hand-parser over to the generic
template-driven engine; only raw snapshot retrieval remains fetcher-owned).
"""

import requests
from pathlib import Path
from .base import BaseFetcher, FetcherRegistry


@FetcherRegistry.register("alexelgt_game_masters")
@FetcherRegistry.register("game_master")
class GameMasterFetcher(BaseFetcher):
    """Fetcher for raw Niantic client GAME_MASTER.json via alexelgt/game_masters repository."""

    def fetch(self, force: bool = False) -> Path:
        """Fetches raw `GAME_MASTER.json` payload from the configured remote URL.

        Args:
            force: If True, bypasses pre-flight ETag check and forces fresh download.

        Returns:
            Path to the snapshot directory where `GAME_MASTER.json` was saved.

        Raises:
            ValueError: If source URL is missing from configuration.
        """
        url = self.config.get("url")
        if not url:
            raise ValueError("No URL specified for alexelgt_game_masters source config.")

        latest_snapshot = self.is_remote_unchanged(url, force=force)
        if latest_snapshot:
            print(f"[{self.source_key}] Pre-flight check: Remote commit ETag matches latest snapshot ({latest_snapshot.name}). Skipped network download!")
            return latest_snapshot

        print(f"[{self.source_key}] Remote commit updated. Fetching raw GAME_MASTER.json from {url}...")
        response = requests.get(url, timeout=60)
        response.raise_for_status()

        etag = response.headers.get("ETag") or response.headers.get("Last-Modified")
        data = response.json()

        snapshot_dir = self.create_snapshot_dir()
        saved_path = self.save_raw(snapshot_dir, "GAME_MASTER", data)
        print(f"[{self.source_key}] Saved snapshot to {saved_path}")

        return self.finalize_snapshot(snapshot_dir, etag=str(etag).strip('"') if etag else None, force=force)
