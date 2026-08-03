"""Fetcher module for pokemon-go-api data endpoints and sprite asset icons."""

import requests
from pathlib import Path
from typing import Dict, Any
from .base import BaseFetcher, FetcherRegistry


@FetcherRegistry.register("pokemon_go_api")
class PokemonGoApiFetcher(BaseFetcher):
    """Fetcher for pokemon-go-api endpoints and sprite icon assets."""

    def fetch(self, force: bool = False) -> Path:
        """Fetches pokedex, raidboss, maxbattles, quests, and types endpoints.

        Args:
            force: If True, bypasses pre-flight check and forces fresh download.

        Returns:
            Path to the saved snapshot directory.
        """
        base_url = self.config.get("base_url")
        endpoints = self.config.get("endpoints", [])

        # Pre-flight check on main pokedex endpoint
        main_url = f"{base_url}/pokedex.json"
        cached_snapshot = self.is_remote_unchanged(main_url, force=force)
        if cached_snapshot:
            return cached_snapshot

        print(f"[{self.source_key}] Remote commit updated. Fetching endpoints from {base_url}...")
        snapshot_dir = self.create_snapshot_dir()
        main_etag = None

        for ep in endpoints:
            name = ep.get("name")
            path = ep.get("path")
            url = f"{base_url}{path}"
            print(f"[{self.source_key}] Fetching '{name}' from {url}...")
            try:
                res = requests.get(url, timeout=30)
                res.raise_for_status()
                if name == "pokedex":
                    main_etag = res.headers.get("ETag") or res.headers.get("Last-Modified")
                data = res.json()
                self.save_raw(snapshot_dir, name, data)
            except Exception as e:
                print(f"[{self.source_key}] Warning: Failed to fetch {name} from {url}: {e}")

        print(f"[{self.source_key}] Snapshot completed at {snapshot_dir}")
        return self.finalize_snapshot(snapshot_dir, etag=str(main_etag).strip('"') if main_etag else None, force=force)

    def download_assets(self, max_sprites: int = 50) -> Path:
        """Downloads sprite icons from pokemon-go-api/assets into raw_dumps/assets/.

        Args:
            max_sprites: Maximum number of sprite files to download. Defaults to 50.

        Returns:
            Path to the asset output directory.
        """
        assets_base_url = self.config.get("assets_base_url")
        if not assets_base_url:
            print(f"[{self.source_key}] No assets_base_url configured.")
            return Path("raw_dumps/assets")

        asset_dir = Path(self.config.get("asset_dump_dir", "raw_dumps/assets"))
        asset_dir.mkdir(parents=True, exist_ok=True)

        print(f"[{self.source_key}] Downloading sample sprite assets (up to {max_sprites}) into {asset_dir}...")
        downloaded = 0
        for i in range(1, max_sprites + 1):
            filename = f"pm{i}.icon.png"
            target_file = asset_dir / filename
            if target_file.exists():
                continue

            url = f"{assets_base_url}/Pokemon/{filename}"
            try:
                res = requests.get(url, timeout=10)
                if res.status_code == 200:
                    with open(target_file, "wb") as f:
                        f.write(res.content)
                    downloaded += 1
            except Exception:
                pass

        print(f"[{self.source_key}] Downloaded {downloaded} new sprite icons.")
        return asset_dir
