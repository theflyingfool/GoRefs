"""Fetcher/archiver module for in-repo local authoring overrides."""

import shutil
from pathlib import Path
from .base import BaseFetcher, FetcherRegistry


@FetcherRegistry.register("local_authoring")
class LocalAuthoringFetcher(BaseFetcher):
    """Fetcher/archiver for local hand-maintained authoring spreadsheets and costume lookups."""

    def fetch(self, force: bool = False) -> Path:
        """Archives configured local authoring JSON files into a timestamped snapshot.

        Args:
            force: If True, forces snapshot creation.

        Returns:
            Path to saved snapshot directory.
        """
        files = self.config.get("files", ["data-authoring/costume-lookup.json"])
        snapshot_dir = self.create_snapshot_dir()

        print(f"[{self.source_key}] Archiving local authoring files into snapshot...")
        for rel_path_str in files:
            file_path = Path(rel_path_str)
            if file_path.exists():
                dest_path = snapshot_dir / file_path.name
                shutil.copy2(file_path, dest_path)
                print(f"[{self.source_key}] Copied {file_path} -> {dest_path}")
            else:
                print(f"[{self.source_key}] Warning: Local authoring file {file_path} not found.")

        print(f"[{self.source_key}] Snapshot completed at {snapshot_dir}")
        return self.finalize_snapshot(snapshot_dir, force=force)
