"""Base fetcher module for Pokémon GO reference data source fetchers.

Defines the abstract `BaseFetcher` base class and `FetcherRegistry` class for registering
and executing upstream data source fetchers with pre-flight check support, snapshot caching,
and raw payload storage.
"""

import os
import json
import time
import hashlib
import datetime
import shutil
import requests
from pathlib import Path
from typing import Any, Dict, Optional, Type


class BaseFetcher:
    """Abstract Base Fetcher for all Pokémon GO reference data sources.

    Handles timestamped snapshot storage, pre-flight commit/ETag checks, raw data loading,
    and local snapshot deduplication.
    """

    def __init__(self, source_key: str, config: Dict[str, Any], base_dump_dir: Path = Path("raw_dumps")):
        """Initializes the BaseFetcher with source configuration and dump directory.

        Args:
            source_key: Unique identifier key for the source (e.g. "pokemon_go_api").
            config: Configuration dictionary loaded from sources.yml.
            base_dump_dir: Base directory for storing timestamped raw dumps.
                Defaults to `Path("raw_dumps")`.
        """
        self.source_key = source_key
        self.config = config
        self.enabled = config.get("enabled", True)
        self.priority = config.get("priority", 99)
        self.trust_tier = config.get("trust_tier", "unknown")
        self.base_dump_dir = base_dump_dir / source_key
        self.base_dump_dir.mkdir(parents=True, exist_ok=True)

    def create_snapshot_dir(self) -> Path:
        """Creates a timestamped snapshot directory (e.g. raw_dumps/pogoapi_net/2026-07-29T185300Z).

        Returns:
            Path to the created timestamped snapshot directory.
        """
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
        snapshot_dir = self.base_dump_dir / timestamp
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        return snapshot_dir

    def get_latest_snapshot_dir(self, exclude_dir: Optional[Path] = None) -> Optional[Path]:
        """Returns the path to the most recent timestamped snapshot directory.

        Args:
            exclude_dir: Optional directory path to exclude from calculation (useful when
                building a new snapshot).

        Returns:
            Path to the latest snapshot directory, or None if no snapshots exist.
        """
        if not self.base_dump_dir.exists():
            return None
        snapshots = sorted([d for d in self.base_dump_dir.iterdir() if d.is_dir() and d != exclude_dir])
        return snapshots[-1] if snapshots else None

    def get_remote_head_meta(self, url: str) -> Dict[str, str]:
        """Performs a lightweight HTTP HEAD request to fetch remote ETag or Last-Modified header.

        Args:
            url: Target HTTP endpoint URL.

        Returns:
            Dictionary containing "etag" string and HTTP "status" string if successful.
        """
        try:
            res = requests.head(url, timeout=10, allow_redirects=True)
            if res.status_code == 200:
                etag = res.headers.get("ETag") or res.headers.get("Last-Modified") or res.headers.get("x-github-request-id")
                return {"etag": str(etag).strip('"'), "status": "200"}
        except Exception:
            pass
        return {}

    def is_remote_unchanged(self, url: str, force: bool = False) -> Optional[Path]:
        """Pre-flight check to determine if the remote resource is unchanged.

        Performs an HTTP HEAD check on the target URL. If the returned ETag matches the
        saved `.meta.json` from the latest snapshot, network downloading is skipped.

        Args:
            url: Remote resource URL to check.
            force: If True, forces download regardless of pre-flight check.

        Returns:
            Path to latest snapshot directory if remote is unchanged, otherwise None.
        """
        if force:
            return None

        latest = self.get_latest_snapshot_dir()
        if not latest:
            return None

        meta_file = latest / ".meta.json"
        if not meta_file.exists():
            return None

        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                saved_meta = json.load(f)

            saved_etag = saved_meta.get("etag")
            if not saved_etag:
                return None

            remote_meta = self.get_remote_head_meta(url)
            remote_etag = remote_meta.get("etag")

            if remote_etag and remote_etag == saved_etag:
                print(f"[{self.source_key}] Pre-flight check: Remote commit ETag ({remote_etag[:16]}...) matches latest snapshot ({latest.name}). Skipped network download!")
                return latest
        except Exception:
            pass

        return None

    def save_meta(self, snapshot_dir: Path, etag: Optional[str] = None) -> None:
        """Saves metadata (etag, timestamp, source key) to the snapshot directory.

        Args:
            snapshot_dir: Snapshot directory where `.meta.json` should be saved.
            etag: Optional ETag or header hash string.
        """
        meta_file = snapshot_dir / ".meta.json"
        meta_data = {
            "source": self.source_key,
            "etag": etag,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump(meta_data, f, indent=2)

    def save_raw(self, snapshot_dir: Path, name: str, data: Any, is_json: bool = True) -> Path:
        """Saves raw fetched data to the snapshot directory.

        Args:
            snapshot_dir: Snapshot directory to save the file into.
            name: Filename stem without extension.
            data: Data payload (dict/list for JSON, str for plain text).
            is_json: If True, serializes data as JSON format. Defaults to True.

        Returns:
            Path to the saved file.
        """
        filename = f"{name}.json" if is_json else name
        filepath = snapshot_dir / filename
        with open(filepath, "w", encoding="utf-8") as f:
            if is_json:
                json.dump(data, f, indent=2, ensure_ascii=False)
            else:
                f.write(data)
        return filepath

    def compute_directory_hash(self, target_dir: Path) -> str:
        """Computes a unified SHA256 hash across all content files in a snapshot directory.

        Args:
            target_dir: Snapshot directory path.

        Returns:
            Hexadecimal SHA256 string digest.
        """
        hasher = hashlib.sha256()
        for filepath in sorted(target_dir.rglob("*")):
            if filepath.is_file() and filepath.name != ".meta.json":
                hasher.update(filepath.name.encode("utf-8"))
                hasher.update(filepath.read_bytes())
        return hasher.hexdigest()

    def finalize_snapshot(self, new_snapshot_dir: Path, etag: Optional[str] = None, force: bool = False) -> Path:
        """Finalizes a snapshot directory and deduplicates content against previous snapshot.

        If the newly fetched directory content matches the previous snapshot hash, deletes
        `new_snapshot_dir` to prevent redundant disk usage and reuses previous snapshot.

        Args:
            new_snapshot_dir: Directory containing newly fetched files.
            etag: Optional HTTP ETag header string.
            force: If True, bypasses deduplication check.

        Returns:
            Path to the finalized (or reused) snapshot directory.
        """
        self.save_meta(new_snapshot_dir, etag=etag)
        prev_snapshot = self.get_latest_snapshot_dir(exclude_dir=new_snapshot_dir)
        if not prev_snapshot or force:
            return new_snapshot_dir

        new_hash = self.compute_directory_hash(new_snapshot_dir)
        prev_hash = self.compute_directory_hash(prev_snapshot)

        if new_hash == prev_hash:
            shutil.rmtree(new_snapshot_dir)
            print(f"[{self.source_key}] Data unchanged from previous snapshot ({prev_snapshot.name}). Skipped duplicate raw dump.")
            return prev_snapshot

        return new_snapshot_dir

    def load_latest_raw(self, name: str) -> Optional[Any]:
        """Loads raw data from the latest saved snapshot directory for offline processing.

        Args:
            name: Filename stem without extension (e.g. "pokedex").

        Returns:
            Parsed JSON object or text string, or None if snapshot file does not exist.
        """
        latest_dir = self.get_latest_snapshot_dir()
        if not latest_dir:
            return None
        filepath = latest_dir / f"{name}.json"
        if not filepath.exists():
            filepath = latest_dir / name
            if not filepath.exists():
                return None
            with open(filepath, "r", encoding="utf-8") as f:
                return f.read()

        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)

    def fetch(self, force: bool = False) -> Path:
        """Abstract fetch method to be implemented by subclass fetchers.

        Args:
            force: If True, forces network download bypassing pre-flight checks.

        Returns:
            Path to snapshot directory containing fetched raw files.

        Raises:
            NotImplementedError: If child class does not implement `fetch()`.
        """
        raise NotImplementedError("Subclasses must implement fetch()")


class FetcherRegistry:
    """Global registry mapping data source keys to BaseFetcher subclass implementations."""

    _registry: Dict[str, Type[BaseFetcher]] = {}

    @classmethod
    def register(cls, source_key: str):
        """Decorator to register a BaseFetcher subclass under a source key.

        Args:
            source_key: Unique source identifier string (e.g. "alexelgt_game_masters").
        """
        def decorator(subclass: Type[BaseFetcher]):
            cls._registry[source_key] = subclass
            return subclass
        return decorator

    @classmethod
    def get_fetcher_class(cls, source_key: str) -> Optional[Type[BaseFetcher]]:
        """Retrieves a registered BaseFetcher class by its source key.

        Args:
            source_key: Registered source identifier key.

        Returns:
            BaseFetcher subclass or None if not found.
        """
        return cls._registry.get(source_key)

    @classmethod
    def list_registered(cls) -> Dict[str, Type[BaseFetcher]]:
        """Returns a copy of all registered fetcher classes mapped by source key.

        Returns:
            Dictionary mapping source keys to BaseFetcher subclasses.
        """
        return cls._registry.copy()
