#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "duckdb>=1.0.0",
#     "pandas>=2.0.0",
#     "pydantic>=2.0.0",
#     "pyyaml>=6.0",
#     "requests>=2.31.0",
#     "pytest>=8.0.0",
#     "tqdm>=4.66.0",
# ]
# ///
"""
Master CLI & Pipeline Runner for Pokémon GO Unified Reference Knowledge Base (`go_refs`).

Provides streamlined commands to fetch raw snapshots, execute the GoRefsMasterEngine build
pipeline producing `output/GoRefs_Master.duckdb`, and host the local web explorer server.
"""

import sys
import os
import argparse
import yaml
import http.server
import socketserver
import re
from pathlib import Path
from typing import Optional

# Ensure repo root is in Python path for src imports
sys.path.insert(0, str(Path(__file__).parent.resolve()))

from src.fetchers import FetcherRegistry
from src.builder import GoRefsMasterEngine
from src.reference_shim import load_reference_json_shim


def load_config(config_path: Path = Path("config/sources.yml")) -> dict:
    """
    Loads and parses the YAML configuration file defining upstream data sources.

    Args:
        config_path (Path): Path to the YAML configuration file. Default is config/sources.yml.

    Returns:
        dict: Parsed configuration dictionary containing source definitions.

    Raises:
        FileNotFoundError: If the specified configuration file does not exist.
    """
    if not config_path.exists():
        raise FileNotFoundError(f"Configuration file '{config_path}' not found.")
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def run_fetching(config: dict, force: bool = False) -> None:
    """
    Executes raw snapshot fetching across all enabled upstream data sources.

    Iterates over registered fetcher classes, downloads immutable timestamped snapshots,
    and caches visual sprite assets into `raw_dumps/`.

    Args:
        config (dict): Configuration dictionary containing source definitions.
        force (bool): If True, re-fetches snapshots regardless of existing local caches.
    """
    print("=" * 70)
    print("Starting Raw Data Fetching Pipeline (Immutable Timestamped Snapshots)")
    print("=" * 70)
    sources = config.get("sources", {})
    
    for source_key, source_config in sources.items():
        if not source_config.get("enabled", True):
            print(f"[{source_key}] Skipped (Disabled in configuration)")
            continue

        fetcher_cls = FetcherRegistry.get_fetcher_class(source_key)
        if not fetcher_cls:
            print(f"[{source_key}] Warning: No fetcher class registered for source key '{source_key}'.")
            continue

        fetcher = fetcher_cls(source_key, source_config)
        try:
            snapshot_dir = fetcher.fetch(force=force)
            if hasattr(fetcher, "download_assets"):
                fetcher.download_assets(max_sprites=20)
        except Exception as e:
            print(f"[{source_key}] Error during fetching: {e}")

    print("\n[Pipeline] All enabled fetchers finished execution.")


def run_freshness_check(config: dict) -> None:
    """Runs each enabled source's pre-flight freshness check without a full fetch.

    Unlike run_fetching(), this always executes as part of --build, regardless of
    whether --fetch was also passed -- so a build never silently uses raw data that's
    gone stale against its remote source without at least checking.
    """
    print("=" * 70)
    print("Verifying local raw snapshots against remote sources...")
    print("=" * 70)
    sources = config.get("sources", {})
    for source_key, source_config in sources.items():
        if not source_config.get("enabled", True):
            continue
        fetcher_cls = FetcherRegistry.get_fetcher_class(source_key)
        if not fetcher_cls:
            continue
        fetcher = fetcher_cls(source_key, source_config)
        try:
            fetcher.fetch(force=False)
        except Exception as e:
            print(f"[{source_key}] Warning: Freshness check/fetch failed: {e}")
    print("[Freshness] Check complete.\n")


def run_doc_generation() -> None:
    """
    Executes automated docstring documentation generator scripts/generate_docs.py.
    """
    try:
        import scripts.generate_docs as docgen
        docgen.main()
    except Exception as e:
        print(f"[DocGen] Error generating documentation: {e}")


def run_deep_dive(target: str = "all") -> None:
    """
    Runs the schema profiler (src.profiler.SourceProfiler) to generate or
    update config/source_templates/*.yml from the latest raw snapshot(s).

    Args:
        target: "all" to profile every source in config/sources.yml, or a
            single source_key to profile just that source (endpoint name is
            assumed to match the source_key).
    """
    from src.profiler import SourceProfiler
    profiler = SourceProfiler()
    if target == "all":
        profiler.profile_all_sources()
    else:
        profiler.profile_source(target, target)


def run_source_coverage_test() -> None:
    """
    Executes the claims-ledger replay coverage suite against the last built
    output/GoRefs_Master.duckdb.
    """
    try:
        from scripts.user_source_coverage_test import LedgerReplayTester
        tester = LedgerReplayTester()
        tester.run_suite()
        tester.close()
    except Exception as e:
        print(f"[Test] Error executing source coverage test suite: {e}")


def run_paranoid_check_cli(source: "Optional[str]" = None) -> None:
    """CLI entrypoint for --test-paranoid. Writes output/paranoid_check_report.md
    and prints a one-line summary per source.
    """
    from src.paranoid_check import run_paranoid_check, render_paranoid_report_markdown

    sources = [source] if source else None
    report = run_paranoid_check(
        db_path=Path("output/GoRefs_Master.duckdb"),
        raw_dumps_dir=Path("raw_dumps"),
        templates_dir=Path("config/source_templates"),
        sources=sources,
    )

    markdown = render_paranoid_report_markdown(report)
    output_path = Path("output/paranoid_check_report.md")
    output_path.write_text(markdown, encoding="utf-8")

    print(f"\nParanoid check complete. Report written to {output_path}")
    for source_key, counts in report["summary"].items():
        print(f"  {source_key}: {counts['CANONICAL']} canonical, {counts['CLAIMS_ONLY']} claims-only, {counts['MISSING']} missing")


class GoRefsHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """
    Custom HTTP request handler for the GoRefs web application.

    Routes root requests and asset paths to the `web/` directory, serves the single
    master database from `output/GoRefs_Master.duckdb`, auto-generated API docs, and
    Parquet exports -- with real HTTP Range support so remote clients (DuckDB's
    httpfs, DuckDB-WASM reading Parquet) can read partial content without
    downloading the whole file.
    """

    def do_GET(self) -> None:
        url_path = self.path.split('?')[0].split('#')[0]
        if url_path in ('/', '/index.html'):
            self.path = '/web/index.html'
        elif url_path in ('/explorer.js', '/styles.css'):
            self.path = f'/web{url_path}'
        elif url_path in ('/GoRefs_Master.duckdb', '/output/GoRefs_Master.duckdb'):
            self.path = '/output/GoRefs_Master.duckdb'
        elif url_path in ('/docs', '/docs/'):
            self.path = '/docs/api_reference.html'

        range_header = self.headers.get("Range")
        if range_header:
            self._serve_range(range_header)
        else:
            return super().do_GET()

    def _serve_range(self, range_header: str) -> None:
        """Serves a single-range byte request as 206 Partial Content."""
        path = self.translate_path(self.path)
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return

        file_size = Path(path).stat().st_size
        match = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if not match:
            f.close()
            self.send_error(416, "Invalid Range header")
            return

        start_str, end_str = match.groups()
        if start_str == "" and end_str == "":
            f.close()
            self.send_error(416, "Invalid Range header")
            return
        if start_str == "":
            # suffix range: last N bytes
            length = int(end_str)
            start = max(file_size - length, 0)
            end = file_size - 1
        else:
            start = int(start_str)
            end = int(end_str) if end_str else file_size - 1
        end = min(end, file_size - 1)

        if start > end or start >= file_size:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{file_size}")
            self.end_headers()
            return

        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

        f.seek(start)
        remaining = length
        chunk_size = 64 * 1024
        while remaining > 0:
            chunk = f.read(min(chunk_size, remaining))
            if not chunk:
                break
            self.wfile.write(chunk)
            remaining -= len(chunk)
        f.close()

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(200, "OK")
        self.end_headers()


def run_web_server(port: int = 8000) -> None:
    """
    Starts the local web server hosting the single-page explorer UI and WASM SQL Console.

    Serves static assets from `web/`, API documentation from `docs/`, and the master DuckDB database.

    Args:
        port (int): Port number on which to bind the HTTP server. Default is 8000.
    """
    repo_root = Path(__file__).parent.resolve()
    os.chdir(repo_root)

    print("=" * 70)
    print(f"🚀 Starting Local Pokémon GO Web Explorer & WASM SQL Console")
    print(f"   URL: http://localhost:{port}")
    print(f"   Master DB Endpoint: http://localhost:{port}/output/GoRefs_Master.duckdb")
    print(f"   API Documentation: http://localhost:{port}/docs/")
    print("   Press Ctrl+C to stop.")
    print("=" * 70)

    try:
        with socketserver.TCPServer(("", port), GoRefsHTTPRequestHandler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nWeb server stopped cleanly.")


def main() -> None:
    """
    Master CLI entrypoint for Pokémon GO Reference Knowledge Base (`go_refs.py`).

    Parses command-line arguments (--fetch, --build, --serve, --docs, --all, --port, --config)
    and dispatches pipeline stages sequentially.
    """
    parser = argparse.ArgumentParser(
        description="Pokémon GO Open Reference Knowledge Base CLI (`go_refs`)"
    )
    parser.add_argument("--fetch", action="store_true", help="Fetch fresh raw snapshots from all upstream sources")
    parser.add_argument("--build", action="store_true", help="Build master DuckDB database (output/GoRefs_Master.duckdb) using GoRefsMasterEngine")
    parser.add_argument("--docs", action="store_true", help="Generate docstring documentation in docs/ using scripts/generate_docs.py")
    parser.add_argument("--test", action="store_true", help="Run source-by-source data coverage & precedence test suite (lowest to highest priority)")
    parser.add_argument("--serve", action="store_true", help="Start local web server hosting single-page explorer & master database")
    parser.add_argument("--all", action="store_true", help="Execute all pipeline stages (fetch, build, and docs)")
    parser.add_argument("--port", type=int, default=8000, help="Port for local web server (default: 8000)")
    parser.add_argument("--config", default="config/sources.yml", help="Path to sources.yml configuration file (default: config/sources.yml)")
    parser.add_argument("--deep-dive", nargs="?", const="all", help="Run schema profiler to generate/update source templates (specify source or 'all')")
    parser.add_argument("--test-paranoid", action="store_true", help="Run the slow, exhaustive dual-method field-coverage check (never part of --build/--test; local_authoring excluded)")
    parser.add_argument("--source", default=None, help="Restrict --test-paranoid to a single source_key (default: all in-scope sources)")
    parser.add_argument("--load-reference-shim", action="store_true", help="Wholesale-load data-authoring/reference_json_shim/reference.json into refjson_* tables in output/GoRefs_Master.duckdb (temporary stopgap, never overrides canonical tables)")

    args = parser.parse_args()
    config = load_config(Path(args.config))

    if not any([args.fetch, args.build, args.docs, args.test, args.serve, args.all, args.deep_dive, args.test_paranoid, args.load_reference_shim]):
        print("No action specified. Usage: uv run go_refs.py [--fetch] [--build] [--docs] [--test] [--serve] [--all] [--deep-dive [SOURCE]] [--test-paranoid] [--source SOURCE_KEY] [--load-reference-shim] [--port PORT] [--config PATH]")
        sys.exit(0)

    if args.all or args.fetch:
        run_fetching(config)

    if args.all or args.build:
        run_freshness_check(config)
        engine = GoRefsMasterEngine(output_dir=Path("output"))
        engine.build()
        engine.export_parquet(db_path=engine.db_path, output_dir=Path("output"))
        run_doc_generation()

    elif args.docs:
        run_doc_generation()

    if args.test:
        run_source_coverage_test()

    if args.deep_dive:
        run_deep_dive(target=args.deep_dive)

    if args.test_paranoid:
        run_paranoid_check_cli(source=args.source)

    if args.load_reference_shim:
        row_counts = load_reference_json_shim()
        print(f"Loaded {len(row_counts)} refjson_* tables into output/GoRefs_Master.duckdb:")
        for table_name, count in sorted(row_counts.items()):
            print(f"  {table_name}: {count} rows")

    if args.serve:
        run_web_server(port=args.port)


if __name__ == "__main__":
    main()

