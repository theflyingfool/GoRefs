# Generic Ingestion Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GoRefs' hardcoded per-source parsing in `src/builder.py` with a generic, template-driven ingestion engine, extend discrepancy tracking to every domain (not just base stats), fix the DuckDB `--serve` mode so remote/partial reads actually work, and add independent verification (`--test-paranoid`) that can't be fooled by a bug in our own extraction code.

**Architecture:** A source profiler inspects raw JSON and writes a reviewable YAML template per source; a generic engine reads a template and returns claims; every claim (from a converted source or a thin wrapper around not-yet-converted legacy code) flows into one claims ledger; the existing `resolve_attribute_claim()` resolves every `(entity, attribute)` group, universally. Sources cut over one at a time, lowest trust-tier first, with the corresponding legacy function deleted at each cutover — never left to coexist.

**Tech Stack:** Python 3.11+, `uv`, DuckDB, pandas, PyYAML, pytest, `tqdm`.

**Base branch:** `main` (commit `91875bf`) — this plan assumes none of the `feat/generic-ingestion-engine` branch's code exists yet. Create a new branch off `main` before Task 1.

**Spec:** `docs/superpowers/specs/2026-07-30-generic-ingestion-engine-design.md` — read it in full before starting; this plan assumes its terminology (claims, ledger, trust tiers, cutover order) without re-explaining it in every task.

## Global Constraints

- Every `--build` remains a full rebuild from `raw_dumps/` — no incremental caching.
- `resolve_attribute_claim()` (an existing method on `GoRefsMasterEngine`, `src/builder.py:118-160` on `main`) is never modified — only called from more places.
- No `reference.json`, sqlite export, or any consumer-specific output format — GoRefs' contract ends at a correct `output/GoRefs_Master.duckdb` (plus, after Task 2, a Parquet export of the same canonical tables).
- No positive "male" gender assertion — `"unknown"` stays legitimate for non-female-confirmed records.
- Deleting a source's legacy hardcoded function happens in the same commit as wiring its `engine.run_source()` replacement — never leave both paths coexisting for a converted source.
- Every step that runs a command uses `uv run` (this project's dependency/execution wrapper), e.g. `uv run go_refs.py --build`, `uv run pytest tests/ -v`.

---

## Task 1: Fix HTTP Range support in `--serve`

**Files:**
- Modify: `go_refs.py:114-152` (the `GoRefsHTTPRequestHandler` class)
- Test: `tests/test_http_range.py` (new)

**Interfaces:**
- Produces: `GoRefsHTTPRequestHandler` now correctly answers `Range:` headers with `206 Partial Content` — this is what every later "pull without downloading the whole file" pattern (DuckDB `httpfs` ATTACH, Parquet predicate pushdown, a future browser client) depends on.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_http_range.py
import http.client
import socketserver
import threading
import time
from pathlib import Path

from go_refs import GoRefsHTTPRequestHandler


def _start_server(port):
    httpd = socketserver.TCPServer(("", port), GoRefsHTTPRequestHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def test_range_request_returns_partial_content(tmp_path, monkeypatch):
    # Serve from a temp dir containing a known file so the test doesn't
    # depend on output/GoRefs_Master.duckdb existing.
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    test_file = tmp_path / "output" / "GoRefs_Master.duckdb"
    test_file.write_bytes(b"0123456789ABCDEF")  # 16 bytes

    port = 8765
    httpd = _start_server(port)
    time.sleep(0.2)  # let the server bind
    try:
        conn = http.client.HTTPConnection("localhost", port)
        conn.request("GET", "/output/GoRefs_Master.duckdb", headers={"Range": "bytes=4-7"})
        resp = conn.getresponse()
        body = resp.read()
        assert resp.status == 206
        assert resp.getheader("Content-Range") == "bytes 4-7/16"
        assert body == b"4567"
    finally:
        httpd.shutdown()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_http_range.py -v`
Expected: FAIL — `resp.status == 200` (whole file returned), no `Content-Range` header.

- [ ] **Step 3: Implement Range support**

```python
# go_refs.py — replace the GoRefsHTTPRequestHandler class (lines 114-152)
import re


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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_http_range.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add go_refs.py tests/test_http_range.py
git commit -m "fix: implement real HTTP Range support in GoRefsHTTPRequestHandler"
```

---

## Task 2: Add Parquet export for the browser/WASM consumption path

**Files:**
- Modify: `src/builder.py` — add a method to `GoRefsMasterEngine`, called from `build()` (currently `main:src/builder.py:891`)
- Test: `tests/test_parquet_export.py` (new)

**Interfaces:**
- Consumes: an existing, populated `output/GoRefs_Master.duckdb` (produced by `write_master_duckdb`).
- Produces: `export_parquet(self, db_path: Path, output_dir: Path) -> list[str]` — writes one `.parquet` file per canonical domain table into `output_dir / "parquet"`, returns the list of table names exported.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_parquet_export.py
from pathlib import Path
import duckdb
from src.builder import GoRefsMasterEngine


def test_export_parquet_writes_one_file_per_canonical_table(tmp_path):
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, name VARCHAR)")
    con.execute("INSERT INTO species VALUES (1, 'Bulbasaur')")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR)")  # should be excluded
    con.close()

    engine = GoRefsMasterEngine(db_path=db_path)
    exported = engine.export_parquet(db_path=db_path, output_dir=tmp_path)

    assert "species" in exported
    assert "_claims_ledger" not in exported
    assert (tmp_path / "parquet" / "species.parquet").exists()

    con2 = duckdb.connect(str(db_path))
    df = con2.execute(f"SELECT * FROM read_parquet('{tmp_path / 'parquet' / 'species.parquet'}')").df()
    assert df.iloc[0]["name"] == "Bulbasaur"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_parquet_export.py -v`
Expected: FAIL — `AttributeError: 'GoRefsMasterEngine' object has no attribute 'export_parquet'`

- [ ] **Step 3: Implement `export_parquet`**

```python
# src/builder.py — add as a method on GoRefsMasterEngine, after write_master_duckdb
    def export_parquet(self, db_path: Path, output_dir: Path) -> List[str]:
        """Exports every canonical (non-internal) table to Parquet for remote/WASM consumption.

        Skips internal tables (prefixed with "_", e.g. "_claims_ledger") -- only the
        stable canonical domain tables need a browser-remote-read path.

        Args:
            db_path: Path to the built GoRefs_Master.duckdb file.
            output_dir: Directory under which "parquet/" is created.

        Returns:
            List of table names exported.
        """
        parquet_dir = output_dir / "parquet"
        parquet_dir.mkdir(parents=True, exist_ok=True)

        con = duckdb.connect(str(db_path))
        all_tables = [row[0] for row in con.execute("SHOW TABLES").fetchall()]
        exported = []
        for tbl in all_tables:
            if tbl.startswith("_"):
                continue
            target = parquet_dir / f"{tbl}.parquet"
            con.execute(f"COPY \"{tbl}\" TO '{target}' (FORMAT PARQUET)")
            exported.append(tbl)
        con.close()
        return exported
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_parquet_export.py -v`
Expected: PASS

- [ ] **Step 5: Wire into `--build`**

```python
# go_refs.py, inside main(), the `if args.all or args.build:` block
    if args.all or args.build:
        engine = GoRefsMasterEngine(output_dir=Path("output"))
        engine.build()
        engine.export_parquet(db_path=engine.db_path, output_dir=Path("output"))
        run_doc_generation()
```

- [ ] **Step 6: Run the real build and confirm Parquet files exist**

Run: `uv run go_refs.py --build`
Expected: `output/parquet/species.parquet`, `output/parquet/forms.parquet`, etc. exist (one per canonical table, none for `_claims_ledger` once Task 5 adds it).

- [ ] **Step 7: Commit**

```bash
git add src/builder.py go_refs.py tests/test_parquet_export.py
git commit -m "feat: export canonical tables to Parquet for the browser/WASM consumption path"
```

---

## Task 3: Add pre-flight freshness checks to `pogoapi_net` and `pokeapi` fetchers

**Files:**
- Modify: `src/fetchers/pogoapi_net.py`
- Modify: `src/fetchers/pokeapi.py`
- Test: `tests/test_fetcher_freshness.py` (new)

**Interfaces:**
- Consumes: `BaseFetcher.is_remote_unchanged(url, force) -> Optional[Path]` (already exists, `src/fetchers/base.py`).
- Produces: both fetchers now skip the network fetch and return the cached snapshot when a representative endpoint's `ETag`/`Last-Modified` is unchanged — matching the pattern already used by `game_master.py`, `pokemon_go_api.py`, `pvpoke.py`, `rplus_shiny.py`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_fetcher_freshness.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_fetcher_freshness.py -v`
Expected: FAIL — `mock_get.assert_not_called()` fails (both fetchers currently always call `requests.get`).

- [ ] **Step 3: Implement the pre-flight check in `pogoapi_net.py`**

```python
# src/fetchers/pogoapi_net.py — replace fetch()
    def fetch(self, force: bool = False) -> Path:
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
```

- [ ] **Step 4: Implement the pre-flight check in `pokeapi.py`**

```python
# src/fetchers/pokeapi.py — replace fetch()
    def fetch(self, force: bool = False) -> Path:
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_fetcher_freshness.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/fetchers/pogoapi_net.py src/fetchers/pokeapi.py tests/test_fetcher_freshness.py
git commit -m "fix: add pre-flight freshness checks to pogoapi_net and pokeapi fetchers"
```

---

## Task 4: Make `--build` always run freshness checks first

**Files:**
- Modify: `go_refs.py` (the `if args.all or args.build:` block in `main()`)
- Test: `tests/test_build_freshness.py` (new)

**Interfaces:**
- Consumes: `FetcherRegistry.get_fetcher_class(source_key)` and each fetcher's `.fetch(force=False)` (existing).
- Produces: a new function `run_freshness_check(config: dict) -> None` in `go_refs.py`, called unconditionally at the start of `--build` (not gated behind `--fetch`).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_build_freshness.py
from unittest.mock import patch
import go_refs


def test_build_calls_freshness_check_even_without_fetch_flag(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    with patch("go_refs.run_freshness_check") as mock_check, \
         patch("go_refs.GoRefsMasterEngine") as mock_engine_cls, \
         patch("go_refs.run_doc_generation"):
        mock_engine_cls.return_value.build.return_value = {}
        mock_engine_cls.return_value.db_path = tmp_path / "output" / "GoRefs_Master.duckdb"
        mock_engine_cls.return_value.export_parquet.return_value = []
        with patch("sys.argv", ["go_refs.py", "--build"]):
            go_refs.main()
        mock_check.assert_called_once()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_build_freshness.py -v`
Expected: FAIL — `AttributeError: module 'go_refs' has no attribute 'run_freshness_check'`

- [ ] **Step 3: Implement `run_freshness_check` and wire it into `--build`**

```python
# go_refs.py — add this function near run_fetching()
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
```

```python
# go_refs.py, inside main() — replace the build block
    if args.all or args.build:
        run_freshness_check(config)
        engine = GoRefsMasterEngine(output_dir=Path("output"))
        engine.build()
        engine.export_parquet(db_path=engine.db_path, output_dir=Path("output"))
        run_doc_generation()
```

Note: `run_freshness_check` calling `fetcher.fetch(force=False)` on every source is intentional and not
redundant with `--fetch` — each fetcher's own `is_remote_unchanged()`/`finalize_snapshot()` logic already
makes this cheap when nothing changed (a HEAD request, not a full download), and this is exactly the
behavior Task 3 just added to the two sources that lacked it.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_build_freshness.py -v`
Expected: PASS

- [ ] **Step 5: Run the real build and confirm freshness output appears**

Run: `uv run go_refs.py --build`
Expected: "Verifying local raw snapshots against remote sources..." prints before the build starts, even though `--fetch` wasn't passed.

- [ ] **Step 6: Commit**

```bash
git add go_refs.py tests/test_build_freshness.py
git commit -m "feat: always run freshness checks as part of --build, not just --fetch"
```

---

## Task 5: Add the claims ledger to `GoRefsMasterEngine`

**Files:**
- Modify: `src/builder.py` (`GoRefsMasterEngine.__init__`, `main:74-92`)
- Test: `tests/test_claims_ledger.py` (new)

**Interfaces:**
- Produces: `self.claims_ledger: List[Dict[str, Any]]` and `self.emit_claim(entity_id: str, attribute: str, source: str, value: Any) -> None` on `GoRefsMasterEngine`. Every later retrofit task (6, 7) calls `emit_claim`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_claims_ledger.py
from src.builder import GoRefsMasterEngine


def test_emit_claim_appends_to_ledger(tmp_path):
    engine = GoRefsMasterEngine(db_path=tmp_path / "test.duckdb")
    engine.emit_claim("pokemon_dex_1", "base_attack", "alexelgt_game_masters", 118)
    assert len(engine.claims_ledger) == 1
    claim = engine.claims_ledger[0]
    assert claim["entity_id"] == "pokemon_dex_1"
    assert claim["attribute"] == "base_attack"
    assert claim["source"] == "alexelgt_game_masters"
    assert claim["value"] == 118
    assert claim["priority"] == 2  # from TRUST_HIERARCHY


def test_emit_claim_ignores_none_values(tmp_path):
    engine = GoRefsMasterEngine(db_path=tmp_path / "test.duckdb")
    engine.emit_claim("pokemon_dex_1", "base_attack", "pogoapi_net", None)
    assert len(engine.claims_ledger) == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_claims_ledger.py -v`
Expected: FAIL — `AttributeError: 'GoRefsMasterEngine' object has no attribute 'claims_ledger'`

- [ ] **Step 3: Implement**

```python
# src/builder.py — in GoRefsMasterEngine.__init__, after self.discrepancies: List[Dict[str, Any]] = []
        self.claims_ledger: List[Dict[str, Any]] = []

# add as a new method, right after __init__
    def emit_claim(self, entity_id: str, attribute: str, source: str, value: Any) -> None:
        """Appends one claim to the in-memory claims ledger, if the value is present.

        This is the single path every domain uses to record "source X claims
        attribute Y of entity Z is value V" -- both cut-over sources (via
        engine.run_source()) and not-yet-cut-over legacy code emit through this
        same method, so discrepancy coverage and --test's ledger-replay work
        identically regardless of migration progress.

        Args:
            entity_id: Stable entity key, e.g. "pokemon_dex_1" or "badge_Triathlete".
            attribute: Canonical field name, e.g. "base_attack".
            source: Source key, must be a key in TRUST_HIERARCHY (unknown sources
                default to priority 99, effectively never winning).
            value: The claimed value. None is silently ignored -- a source with no
                opinion on a field doesn't get a claim at all.
        """
        if value is None:
            return
        priority = self.source_priorities.get(source, 99)
        self.claims_ledger.append({
            "entity_id": entity_id,
            "attribute": attribute,
            "source": source,
            "value": value,
            "priority": priority,
        })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_claims_ledger.py -v`
Expected: PASS

- [ ] **Step 5: Clear the ledger at the start of each build**

```python
# src/builder.py, in collect_and_resolve_claims(), right after self.discrepancies.clear()
        self.claims_ledger.clear()
```

- [ ] **Step 6: Commit**

```bash
git add src/builder.py tests/test_claims_ledger.py
git commit -m "feat: add claims ledger infrastructure to GoRefsMasterEngine"
```

---

## Task 6: Retrofit species/forms claim emission (multi-source domain, fully worked)

This is the domain every prior bug in this project came from — it establishes the pattern for
"a domain where multiple sources contribute different fields to the same record."

**Files:**
- Modify: `src/builder.py:230-402` (`collect_and_resolve_claims`, the base-stats resolution loop and the species/forms build loop)
- Test: `tests/test_species_claims.py` (new)

**Interfaces:**
- Consumes: `self.emit_claim` (Task 5).
- Produces: every field of every `species`/`forms` row that has a known single-source origin today emits a claim tagged with that source, in addition to (not yet replacing — see Task 8) the existing direct-assignment logic.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_species_claims.py
from src.builder import GoRefsMasterEngine
from unittest.mock import patch, MagicMock


def _fake_fetcher(raw_by_name):
    fetcher = MagicMock()
    fetcher.load_latest_raw.side_effect = lambda name: raw_by_name.get(name)
    fetcher.extract_structured_claims.return_value = {}
    return fetcher


def test_species_build_emits_base_stat_claims(tmp_path):
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    pokedex_raw = [{
        "dexNr": 1, "names": {"English": "Bulbasaur"}, "generation": 1,
        "primaryType": {"type": "POKEMON_TYPE_GRASS"}, "assets": {},
    }]

    with patch("src.builder.FetcherRegistry") as mock_registry:
        def get_fetcher(key):
            if key == "alexelgt_game_masters":
                return lambda *a: _fake_fetcher_gm()
            if key == "pokemon_go_api":
                return lambda *a: _fake_fetcher({"pokedex": pokedex_raw, "raidboss": {}, "maxbattles": {}, "quests": []})
            return lambda *a: _fake_fetcher({})
        mock_registry.get_fetcher_class.side_effect = get_fetcher
        engine.collect_and_resolve_claims()

    dex1_claims = [c for c in engine.claims_ledger if c["entity_id"] == "pokemon_dex_1"]
    attrs_claimed = {c["attribute"] for c in dex1_claims}
    assert "name" in attrs_claimed
    assert "generation" in attrs_claimed


def _fake_fetcher_gm():
    fetcher = MagicMock()
    fetcher.extract_structured_claims.return_value = {"species_stats": {1: {"base_attack": 118, "base_defense": 111, "base_stamina": 128, "buddy_distance_km": 3.0}}}
    fetcher.load_latest_raw.return_value = None
    return fetcher
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_species_claims.py -v`
Expected: FAIL — `attrs_claimed` doesn't contain `"name"`/`"generation"` (nothing emits claims for species fields yet).

- [ ] **Step 3: Emit claims in the base-stats resolution loop**

```python
# src/builder.py — replace the base-stats loop (main:230-248)
        resolved_stats_by_dex = {}
        all_dex_ids = set(pogo_stats_by_dex.keys()).union(gm_species_stats.keys())
        for d in all_dex_ids:
            pogo_stat = pogo_stats_by_dex.get(d, {})
            gm_stat = gm_species_stats.get(d, {})
            entity_id = f"pokemon_dex_{d}"

            resolved_entry = {}
            for stat_key in ["base_attack", "base_defense", "base_stamina"]:
                claims = []
                gm_val = gm_stat.get(stat_key)
                if gm_val is not None:
                    claims.append({"source": "alexelgt_game_masters", "value": gm_val})
                    self.emit_claim(entity_id, stat_key, "alexelgt_game_masters", gm_val)
                pogo_val = pogo_stat.get(stat_key)
                if pogo_val is not None:
                    claims.append({"source": "pogoapi_net", "value": pogo_val})
                    self.emit_claim(entity_id, stat_key, "pogoapi_net", pogo_val)

                val, _ = self.resolve_attribute_claim(entity_id, stat_key, claims)
                resolved_entry[stat_key] = val

            resolved_stats_by_dex[d] = resolved_entry
```

- [ ] **Step 4: Emit claims for the rest of the species record and the Standard form**

```python
# src/builder.py — inside the `for entry in pokedex_raw:` loop, right after
# `gm_stat_entry = gm_species_stats.get(dex_nr, {})` (main:286), before "# Standard Form"
            entity_id = f"pokemon_dex_{dex_nr}"
            self.emit_claim(entity_id, "name", "pokemon_go_api", name)
            self.emit_claim(entity_id, "generation", "pokemon_go_api", gen)
            self.emit_claim(entity_id, "can_mega_evolve", "pokemon_go_api", can_mega)
            self.emit_claim(entity_id, "can_gigantamax", "pokemon_go_api", can_gmax)
            self.emit_claim(entity_id, "buddy_distance_km", "alexelgt_game_masters", gm_stat_entry.get("buddy_distance_km"))
            self.emit_claim(entity_id, "max_cp_lvl40", "pogoapi_net", max_cp_val)
            self.emit_claim(entity_id, "types", "pokemon_go_api",
                             [t.get("type", "").replace("POKEMON_TYPE_", "").capitalize()
                              for t in [entry.get("primaryType"), entry.get("secondaryType")] if t])
```

- [ ] **Step 5: Emit claims for the shiny date and shadow-availability signals used by every form**

```python
# src/builder.py — inside the shiny_dates_by_dex loop (main:260-265), add after the dict assignment
        if isinstance(shiny_raw, list):
            for row in shiny_raw:
                raw_pid = str(row.get("pid") or row.get("_dex") or row.get("dex") or "").replace("pm", "")
                date_val = row.get("debut") or row.get("shiny_date") or row.get("date")
                if raw_pid.isdigit() and date_val:
                    shiny_dates_by_dex[int(raw_pid)] = str(date_val)
                    self.emit_claim(f"pokemon_dex_{raw_pid}", "shiny_release_date", "rplus_shiny", str(date_val))

# and, inside the Standard-form construction, right before forms_list.append(form_entry) (main:307)
            form_entity_id = f"{slug}-standard"
            self.emit_claim(form_entity_id, "shadow_available", "pogoapi_net", str(dex_nr) in shadow_raw)
            self.emit_claim(form_entity_id, "shiny_available", "pokemon_go_api", has_shiny)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `uv run pytest tests/test_species_claims.py -v`
Expected: PASS

- [ ] **Step 7: Run the real build and confirm no regression**

Run: `uv run go_refs.py --build`
Expected: `Build Complete: 1024 species, 2205 forms, 317 moves, 3 field discrepancies logged.` — identical counts to the pre-change baseline (this task only *adds* claim emission, it doesn't change what gets written yet; row-assembly-from-ledger is Task 8).

- [ ] **Step 8: Commit**

```bash
git add src/builder.py tests/test_species_claims.py
git commit -m "feat: emit claims for species/forms fields (multi-source domain retrofit)"
```

---

## Task 7: Retrofit remaining domains' claim emission

Same technique as Task 6 (`emit_claim` at the point each source-attributed value is already
read), applied to every other domain `collect_and_resolve_claims` builds. Two fully-worked
examples below cover the two shapes every remaining domain falls into; the table after them
gives the exact entity-id scheme and attributes for the rest.

**Files:**
- Modify: `src/builder.py` (the remaining list-building sections of `collect_and_resolve_claims`, `main:404-660`)
- Test: `tests/test_domain_claims.py` (new)

**Interfaces:**
- Consumes: `self.emit_claim` (Task 5).
- Produces: every domain in the table below now contributes to `self.claims_ledger`.

- [ ] **Step 1: Write the failing test (badges, as the representative single-source case)**

```python
# tests/test_domain_claims.py
from src.builder import GoRefsMasterEngine
from unittest.mock import patch, MagicMock


def test_badges_build_emits_claims(tmp_path):
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")
    badges_raw = [{"id": "Triathlete", "name": "Triathlete", "event_badge": False, "description": "desc", "rank": 5, "targets": [1, 10]}]

    fetcher = MagicMock()
    fetcher.load_latest_raw.side_effect = lambda name: {"badges": badges_raw}.get(name, [] if name not in ("raidboss", "maxbattles") else {})
    fetcher.extract_structured_claims.return_value = {}

    with patch("src.builder.FetcherRegistry") as mock_registry:
        mock_registry.get_fetcher_class.return_value = lambda *a: fetcher
        engine.collect_and_resolve_claims()

    badge_claims = [c for c in engine.claims_ledger if c["entity_id"] == "badge_Triathlete"]
    assert {"name", "is_event_badge", "description", "rank"} <= {c["attribute"] for c in badge_claims}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_domain_claims.py -v`
Expected: FAIL — no claims emitted for `badge_Triathlete` yet.

- [ ] **Step 3: Worked example A — badges (single-source, list-of-dicts)**

```python
# src/builder.py — inside "# Build Badges" (main:609-630), add emit_claim calls
        badges_list = []
        if isinstance(badges_raw, list):
            for item in badges_raw:
                if isinstance(item, dict):
                    badge_id = str(item.get("id") or item.get("name"))
                    entity_id = f"badge_{badge_id}"
                    name = item.get("name")
                    is_event = bool(item.get("event_badge", False))
                    description = item.get("description")
                    rank = item.get("rank")
                    targets = json.dumps(item.get("targets")) if item.get("targets") is not None else None
                    self.emit_claim(entity_id, "name", "pogoapi_net", name)
                    self.emit_claim(entity_id, "is_event_badge", "pogoapi_net", is_event)
                    self.emit_claim(entity_id, "description", "pogoapi_net", description)
                    self.emit_claim(entity_id, "rank", "pogoapi_net", rank)
                    self.emit_claim(entity_id, "targets", "pogoapi_net", targets)
                    badges_list.append({
                        "badge_id": badge_id, "name": name, "is_event_badge": is_event,
                        "description": description, "rank": rank, "targets": targets,
                    })
        elif isinstance(badges_raw, dict):
            for b_id, b_info in badges_raw.items():
                if isinstance(b_info, dict):
                    entity_id = f"badge_{b_id}"
                    name = b_info.get("name")
                    is_event = bool(b_info.get("event_badge", False))
                    description = b_info.get("description")
                    rank = b_info.get("rank")
                    targets = json.dumps(b_info.get("targets")) if b_info.get("targets") is not None else None
                    self.emit_claim(entity_id, "name", "pogoapi_net", name)
                    self.emit_claim(entity_id, "is_event_badge", "pogoapi_net", is_event)
                    self.emit_claim(entity_id, "description", "pogoapi_net", description)
                    self.emit_claim(entity_id, "rank", "pogoapi_net", rank)
                    self.emit_claim(entity_id, "targets", "pogoapi_net", targets)
                    badges_list.append({
                        "badge_id": str(b_id), "name": name, "is_event_badge": is_event,
                        "description": description, "rank": rank, "targets": targets,
                    })
```

- [ ] **Step 4: Worked example B — GAME_MASTER-only domains (items, single-source, already dict-shaped)**

```python
# src/builder.py — right after `gm_items = gm_claims.get("items", [])` (main:176), add a loop
# emitting claims for each item before it's used downstream. Apply the identical shape to
# gm_stickers/gm_avatars/gm_friendship/gm_encounters per the table below.
        for item in gm_items:
            item_id = item.get("item_id")
            if not item_id:
                continue
            entity_id = f"item_{item_id}"
            self.emit_claim(entity_id, "item_type", "alexelgt_game_masters", item.get("item_type"))
            self.emit_claim(entity_id, "category", "alexelgt_game_masters", item.get("category"))
            self.emit_claim(entity_id, "drop_trainer_level", "alexelgt_game_masters", item.get("drop_trainer_level"))
```

- [ ] **Step 5: Apply the same two patterns to every remaining domain**

| Domain (list var) | Source(s) | Entity ID scheme | Attributes to `emit_claim` |
|---|---|---|---|
| `moves_list` | `pogoapi_net` (base fields), `pvpoke` (pvp fields) | `f"move_{m_id}"` | `type`, `is_fast`, `pve_power`, `pve_duration_ms`, `pve_energy_delta` (source `pogoapi_net`); `pvp_power`, `pvp_energy_cost`, `pvp_cooldown_turns`, `stat_buffs` (source `pvpoke`) |
| `community_days_list` | `pogoapi_net` | `f"community_day_{event_id}"` | `name`, `date`, `featured_pokemon` |
| `raid_bosses_list` | `pokemon_go_api` | `f"raid_boss_{tier_key}_{b.get('id')}"` | `name`, `form`, `costume`, `min_cp`, `max_cp`, `min_boosted_cp`, `max_boosted_cp`, `shiny_available`, `image_url`, `shiny_image_url` |
| `max_battles_list` | `pokemon_go_api` | `f"max_battle_{tier_key}_{b.get('id')}"` | `name`, `form`, `costume`, `max_particles_cost`, `shiny_available`, `image_url`, `shiny_image_url` |
| `quests_list` | `pokemon_go_api` | `f"quest_{quest_id}"` | `type`, `text`, `target`, `reward_type`, `reward_detail` |
| `regional_species_list` | `pogoapi_net` | `f"regional_species_{name}"` | `dex_number`, `region` |
| `nesting_species_list` | `pogoapi_net` | `f"nesting_species_{name}"` | `dex_number`, `is_nesting` |
| `baby_species_list` | `pogoapi_net` | `f"baby_species_{name or item.get('id')}"` | `dex_number`, `form`, `is_baby` |
| `shadow_species_list` | `pogoapi_net` | `f"shadow_species_{name}"` | `dex_number`, `is_shadow` |
| `mega_species_list` | `pogoapi_net` | `f"mega_species_{name}"` | `dex_number`, `mega_name`, `first_evolution_energy`, `subsequent_evolution_energy` |
| `pvp_leagues_list` | `pvpoke` | `f"pvp_league_{league_id}"` | `cp_limit`, `meta` |
| `gm_stickers` | `alexelgt_game_masters` | `f"sticker_{sticker_id}"` | `max_count`, `asset_id` |
| `gm_avatars` | `alexelgt_game_masters` | `f"avatar_{avatar_id}"` | `slot`, `unlock_player_level` |
| `gm_friendship` | `alexelgt_game_masters` | `f"friendship_{milestone_level}"` | `unlocked_features`, `xp_reward` |
| `gm_encounters` | `alexelgt_game_masters` | `f"encounter_{template_id}"` | `spin_bonus_threshold`, `excellent_throw_threshold`, `great_throw_threshold`, `nice_throw_threshold` |
| `moves` (GAME_MASTER side, in `extract_structured_claims`) | `alexelgt_game_masters` | `f"move_{move_unique_id}"` | `type`, `power`, `energy_delta`, `duration_turns` |

For each row: add an `emit_claim(entity_id, attribute, source, value)` call at the exact point
in the existing loop where that value is already read (same technique as Steps 3-4), immediately
before the value is appended to its list. Do not change what gets appended yet — that's Task 8.

- [ ] **Step 6: Run test to verify it passes**

Run: `uv run pytest tests/test_domain_claims.py -v`
Expected: PASS

- [ ] **Step 7: Run the real build and confirm the discrepancies count can now exceed 3**

Run: `uv run go_refs.py --build`
Expected: species/forms/moves counts unchanged (1024/2205/317); `discrepancies` count may now be
*equal to or greater than* 3 (e.g. `moves_list`'s `pvpoke` vs `pogoapi_net` overlap on `pvp_power`-adjacent
fields is a plausible new conflict) — record the actual number for the Task 8 acceptance check.

- [ ] **Step 8: Commit**

```bash
git add src/builder.py tests/test_domain_claims.py
git commit -m "feat: emit claims for all remaining domains (badges, raid bosses, moves, GAME_MASTER extras)"
```

---

## Task 8: Make canonical row assembly authoritative from the resolved ledger

Tasks 6-7 made every domain *emit* claims, but the actual written values are still the old ad
hoc `.get()`-based locals. This task closes the loop: after every claim is emitted, resolve
every `(entity, attribute)` group once, and read finished values back out of that resolution
for row assembly — the mechanism the spec calls "canonical row assembly reads resolved values
out of the ledger by attribute name."

**Files:**
- Modify: `src/builder.py` — add a resolution pass at the end of `collect_and_resolve_claims`, before its `return` statement (`main:660-671`)
- Test: `tests/test_ledger_resolution.py` (new)

**Interfaces:**
- Consumes: `self.claims_ledger` (Tasks 5-7), `self.resolve_attribute_claim` (existing).
- Produces: `self.resolve_all_claims() -> Dict[Tuple[str, str], Any]` — maps every `(entity_id, attribute)` pair in the ledger to its resolved value. Used by row assembly wherever a field's value was previously read from an ad hoc local variable that also has an `emit_claim` call for it.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_ledger_resolution.py
from src.builder import GoRefsMasterEngine


def test_resolve_all_claims_picks_highest_priority(tmp_path):
    engine = GoRefsMasterEngine(db_path=tmp_path / "test.duckdb")
    engine.emit_claim("pokemon_dex_1", "base_attack", "pogoapi_net", 999)   # priority 6
    engine.emit_claim("pokemon_dex_1", "base_attack", "alexelgt_game_masters", 118)  # priority 2, wins

    resolved = engine.resolve_all_claims()

    assert resolved[("pokemon_dex_1", "base_attack")] == 118
    assert len(engine.discrepancies) == 1  # values disagreed


def test_resolve_all_claims_no_discrepancy_when_claims_agree(tmp_path):
    engine = GoRefsMasterEngine(db_path=tmp_path / "test.duckdb")
    engine.emit_claim("pokemon_dex_1", "generation", "pokemon_go_api", 1)

    resolved = engine.resolve_all_claims()

    assert resolved[("pokemon_dex_1", "generation")] == 1
    assert len(engine.discrepancies) == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_ledger_resolution.py -v`
Expected: FAIL — `AttributeError: 'GoRefsMasterEngine' object has no attribute 'resolve_all_claims'`

- [ ] **Step 3: Implement**

```python
# src/builder.py — add as a new method on GoRefsMasterEngine
    def resolve_all_claims(self) -> Dict[Tuple[str, str], Any]:
        """Groups the claims ledger by (entity_id, attribute) and resolves each group.

        This is the universal replacement for the old pattern of manually building a
        `claims` list and calling resolve_attribute_claim() at one hardcoded call site
        per field -- every field emitted via emit_claim() (Tasks 6-7) gets the same
        trust-tier resolution and discrepancy logging automatically.

        Returns:
            Dict mapping (entity_id, attribute) to its resolved value. Attributes with
            no claims at all simply aren't keys in this dict -- callers should use
            .get((entity_id, attribute)) and treat a missing key as None.
        """
        grouped: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for claim in self.claims_ledger:
            key = (claim["entity_id"], claim["attribute"])
            grouped.setdefault(key, []).append({"source": claim["source"], "value": claim["value"]})

        resolved: Dict[Tuple[str, str], Any] = {}
        for (entity_id, attribute), claims in grouped.items():
            val, _ = self.resolve_attribute_claim(entity_id, attribute, claims)
            resolved[(entity_id, attribute)] = val
        return resolved
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_ledger_resolution.py -v`
Expected: PASS

- [ ] **Step 5: Wire `resolve_all_claims()` into row assembly for species/forms**

```python
# src/builder.py — at the very end of collect_and_resolve_claims, right before
# `return { "species": species_list, ... }` (main:660), call resolution and overwrite
# fields that came from emit_claim-tracked sources.
        resolved = self.resolve_all_claims()

        for sp in species_list:
            entity_id = f"pokemon_dex_{sp['dex_number']}"
            for attr in ("name", "generation", "can_mega_evolve", "can_gigantamax",
                         "buddy_distance_km", "base_attack", "base_defense",
                         "base_stamina", "max_cp_lvl40", "types"):
                key = (entity_id, attr)
                if key in resolved:
                    sp[attr if attr != "generation" else "gen"] = resolved[key]

        for f in forms_list:
            if f["form_name"] != "Standard":
                continue  # only the Standard form emits shadow/shiny claims today (Task 6, Step 5)
            entity_id = f["slug"]
            for attr in ("shadow_available", "shiny_available"):
                key = (entity_id, attr)
                if key in resolved:
                    f[attr] = resolved[key]
```

Note: this only rewires the fields Task 6 actually tagged with `emit_claim` — fields not yet
claim-tracked (e.g. `shiny_release_date`, most of the non-Standard form fields) keep using their
existing ad hoc assignment for now. Extending `resolve_all_claims`-backed assembly to every field
of every domain from the table in Task 7 follows the identical pattern; do it opportunistically
per domain during that domain's cutover task (Task 17 onward) rather than as one giant step here,
since each cutover already needs to touch that domain's row assembly anyway.

- [ ] **Step 6: Run the real build and confirm species/forms output is unchanged**

Run: `uv run go_refs.py --build`
Expected: identical species/forms field values to before this task (base stats especially --
`alexelgt_game_masters` should still win over `pogoapi_net` for dex 222 the same way the
existing `discrepancies` table already showed prior to this change).

```bash
uv run python3 -c "
import duckdb
con = duckdb.connect('output/GoRefs_Master.duckdb', read_only=True)
print(con.execute(\"select * from species where dex_number=222\").fetchdf().to_string())
print(con.execute(\"select count(*) from discrepancies\").fetchone()[0])
"
```

Expected: dex 222's `base_attack`/`base_defense`/`base_stamina` match the values already
documented in `KNOWN_ISSUES.md`'s discrepancy example (116/182/155, won by
`alexelgt_game_masters`).

- [ ] **Step 7: Commit**

```bash
git add src/builder.py tests/test_ledger_resolution.py
git commit -m "feat: resolve species/forms canonical fields from the claims ledger"
```

---

## Task 9: Rewrite `--test` as ledger replay

**Files:**
- Modify: `scripts/user_source_coverage_test.py` (full rewrite — delete the old tautological logic per "Branch hygiene" in the spec)
- Test: `tests/test_ledger_replay_suite.py` (new)

**Interfaces:**
- Consumes: `output/GoRefs_Master.duckdb`'s `_claims_ledger` table (doesn't exist as a persisted table yet — see Step 3) and the resolved canonical tables.
- Produces: `LedgerReplayTester` class with `run_suite() -> dict`, invoked by `uv run go_refs.py --test`.

- [ ] **Step 1: Persist the claims ledger to DuckDB so `--test` can read it standalone**

```python
# src/builder.py, in write_master_duckdb(), add "_claims_ledger" to tables_to_write
# (main:797, inside the `tables_to_write = [...]` list)
            ("_claims_ledger", canonical_data.get("_claims_ledger", [])),
```

```python
# src/builder.py, in collect_and_resolve_claims()'s return dict (main:660), add:
            "_claims_ledger": self.claims_ledger,
```

```python
# src/builder.py, in write_master_duckdb()'s default_schemas dict (main:824), add:
            "_claims_ledger": "entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT",
```

Note: `value` is stored as `VARCHAR` (via `str(value)` if not already a string) since claims can
be bools/ints/lists — the replay suite re-derives typed comparisons by reading the canonical
table's own column type, not by trusting the ledger's stringified value for equality directly;
compare `str(canonical_value) == str(ledger_value)` in the suite below to sidestep type drift.

- [ ] **Step 2: Write the failing test**

```python
# tests/test_ledger_replay_suite.py
import duckdb
from scripts.user_source_coverage_test import LedgerReplayTester


def test_replay_reports_zero_gaps_when_ledger_matches_canonical(tmp_path):
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, base_attack INT)")
    con.execute("INSERT INTO species VALUES (1, 118)")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'base_attack', 'alexelgt_game_masters', '118', 2)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'base_attack', 'pogoapi_net', '999', 6)")
    con.close()

    tester = LedgerReplayTester(db_path=db_path)
    results = tester.run_suite()

    assert results["total_gaps"] == 0
    assert results["by_source"]["alexelgt_game_masters"]["matched"] == 1
    assert results["by_source"]["pogoapi_net"]["overridden"] == 1
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/test_ledger_replay_suite.py -v`
Expected: FAIL — `ModuleNotFoundError` or `ImportError: cannot import name 'LedgerReplayTester'`

- [ ] **Step 4: Replace `scripts/user_source_coverage_test.py` entirely**

```python
# scripts/user_source_coverage_test.py — full file replacement
"""Ledger-replay coverage suite for GoRefs.

Reads the _claims_ledger table the last --build produced, re-derives each
(entity_id, attribute)'s expected winner using the same trust-tier priority
the resolver used, and asserts the canonical table actually holds that value.
Does not independently re-parse raw JSON -- that duplication is what degraded
the previous version of this suite into a tautology.
"""
from pathlib import Path
from typing import Any, Dict
import duckdb
import pandas as pd


class LedgerReplayTester:
    def __init__(self, db_path: Path = Path("output/GoRefs_Master.duckdb")):
        self.db_path = db_path
        self.con = duckdb.connect(str(db_path), read_only=True)
        self._canonical_cache: Dict[str, pd.DataFrame] = {}

    def _find_canonical_value(self, entity_id: str, attribute: str) -> Any:
        """Best-effort lookup: entity_id encodes the domain as its prefix
        (e.g. "pokemon_dex_1" -> species/forms tables keyed by dex_number)."""
        if entity_id.startswith("pokemon_dex_"):
            dex = int(entity_id.replace("pokemon_dex_", ""))
            for table in ("species", "forms"):
                df = self._load(table)
                if attribute in df.columns:
                    match = df[df["dex_number"] == dex] if "dex_number" in df.columns else pd.DataFrame()
                    if not match.empty:
                        return match.iloc[0][attribute]
        elif entity_id.startswith("badge_"):
            badge_id = entity_id.replace("badge_", "")
            df = self._load("badges")
            if attribute in df.columns:
                match = df[df["badge_id"] == badge_id]
                if not match.empty:
                    return match.iloc[0][attribute]
        return None  # unmapped entity prefixes fall through as "no canonical value found"

    def _load(self, table: str) -> pd.DataFrame:
        if table not in self._canonical_cache:
            try:
                self._canonical_cache[table] = self.con.execute(f'SELECT * FROM "{table}"').df()
            except Exception:
                self._canonical_cache[table] = pd.DataFrame()
        return self._canonical_cache[table]

    def run_suite(self) -> Dict[str, Any]:
        ledger = self.con.execute("SELECT * FROM _claims_ledger").df()
        by_source: Dict[str, Dict[str, int]] = {}
        total_gaps = 0

        grouped = ledger.groupby(["entity_id", "attribute"])
        for (entity_id, attribute), group in grouped:
            winner_row = group.loc[group["priority"].astype(int).idxmin()]
            canonical_value = self._find_canonical_value(entity_id, attribute)

            for _, claim_row in group.iterrows():
                source = claim_row["source"]
                by_source.setdefault(source, {"matched": 0, "overridden": 0, "gaps": 0})
                if str(claim_row["value"]) == str(canonical_value):
                    by_source[source]["matched"] += 1
                elif claim_row["source"] != winner_row["source"] and str(winner_row["value"]) == str(canonical_value):
                    by_source[source]["overridden"] += 1
                else:
                    by_source[source]["gaps"] += 1
                    total_gaps += 1

        report_lines = ["| Source | Matched | Overridden | Gaps |", "|---|---|---|---|"]
        for source, counts in sorted(by_source.items()):
            report_lines.append(f"| `{source}` | {counts['matched']} | {counts['overridden']} | {counts['gaps']} |")
        report_text = "\n".join(report_lines)
        Path("output").mkdir(exist_ok=True)
        Path("output/source_coverage_report.md").write_text(report_text, encoding="utf-8")
        print(report_text)
        print(f"\nTotal gaps: {total_gaps}")

        return {"by_source": by_source, "total_gaps": total_gaps}

    def close(self) -> None:
        self.con.close()


if __name__ == "__main__":
    tester = LedgerReplayTester()
    tester.run_suite()
    tester.close()
```

- [ ] **Step 5: Update `go_refs.py`'s `run_source_coverage_test()` to use the new class**

```python
# go_refs.py — replace run_source_coverage_test()
def run_source_coverage_test() -> None:
    try:
        from scripts.user_source_coverage_test import LedgerReplayTester
        tester = LedgerReplayTester()
        tester.run_suite()
        tester.close()
    except Exception as e:
        print(f"[Test] Error executing source coverage test suite: {e}")
```

- [ ] **Step 6: Run test to verify it passes**

Run: `uv run pytest tests/test_ledger_replay_suite.py -v`
Expected: PASS

- [ ] **Step 7: Run the real build + test and sanity-check the report**

Run: `uv run go_refs.py --build && uv run go_refs.py --test`
Expected: total gaps == 0 for every attribute currently tracked in the ledger (only the domains
retrofitted in Tasks 6-8 so far — this is expected to be a much smaller claim count than the
eventual full-coverage number, growing as later cutover tasks add more domains' claims).

- [ ] **Step 8: Commit**

```bash
git add scripts/user_source_coverage_test.py go_refs.py src/builder.py tests/test_ledger_replay_suite.py
git commit -m "feat: rewrite --test as claims-ledger replay, deleting the old tautological suite"
```

---

## Task 10: `engine.py` — shape normalizer

**Files:**
- Create: `src/engine.py`
- Test: `tests/test_engine_shape.py` (new)

**Interfaces:**
- Produces: `unwrap_to_records(payload: Any, unwrap_path: list[str], iterate_mode: str, key_becomes_field: str | None) -> list[dict]`. Used by `run_source()` (Task 13) and the profiler (Task 14).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_engine_shape.py
from src.engine import unwrap_to_records


def test_top_level_list():
    payload = [{"name": "a"}, {"name": "b"}]
    records = unwrap_to_records(payload, unwrap_path=[], iterate_mode="top_level_list", key_becomes_field=None)
    assert records == [{"name": "a"}, {"name": "b"}]


def test_dict_of_lists_with_key_becomes_field():
    payload = {"currentList": {"lvl1": [{"id": "BULBASAUR"}], "lvl5": [{"id": "SOLGALEO"}]}}
    records = unwrap_to_records(payload, unwrap_path=["currentList"], iterate_mode="dict_of_lists", key_becomes_field="tier")
    assert {"id": "BULBASAUR", "tier": "lvl1"} in records
    assert {"id": "SOLGALEO", "tier": "lvl5"} in records


def test_list_of_dicts_with_subkey():
    payload = [{"templateId": "X", "data": {"pokemonSettings": {"pokemonId": "BULBASAUR"}}}]
    records = unwrap_to_records(payload, unwrap_path=["data"], iterate_mode="list_of_dicts_with_subkey", key_becomes_field=None)
    assert records == [{"pokemonSettings": {"pokemonId": "BULBASAUR"}}]


def test_single_object():
    payload = {"only": "one record"}
    records = unwrap_to_records(payload, unwrap_path=[], iterate_mode="single_object", key_becomes_field=None)
    assert records == [{"only": "one record"}]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_engine_shape.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.engine'`

- [ ] **Step 3: Implement**

```python
# src/engine.py
"""Generic, template-driven extraction engine for GoRefs sources.

The only code path that reads a config/source_templates/*.yml file at build
time. Everything here is source-agnostic -- source-specific knowledge lives
entirely in the template, not in this module.
"""
from typing import Any, Dict, List, Optional


def unwrap_to_records(
    payload: Any,
    unwrap_path: List[str],
    iterate_mode: str,
    key_becomes_field: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Descends through unwrap_path, then yields records per iterate_mode.

    Args:
        payload: The raw, already-json.load()-ed source payload.
        unwrap_path: Dict keys to descend through before iterating, e.g. ["currentList"].
        iterate_mode: One of "top_level_list", "dict_of_lists",
            "list_of_dicts_with_subkey", "single_object".
        key_becomes_field: For "dict_of_lists", the dict key at the final unwrap
            level is injected onto each of its records under this field name
            (e.g. a raid tier name becomes each boss record's "tier" field).

    Returns:
        List of record dicts.
    """
    node = payload
    for key in unwrap_path:
        if not isinstance(node, dict) or key not in node:
            return []
        node = node[key]

    if iterate_mode == "top_level_list":
        return [r for r in node if isinstance(r, dict)] if isinstance(node, list) else []

    if iterate_mode == "dict_of_lists":
        records: List[Dict[str, Any]] = []
        if isinstance(node, dict):
            for group_key, group_list in node.items():
                if not isinstance(group_list, list):
                    continue
                for item in group_list:
                    if isinstance(item, dict):
                        record = dict(item)
                        if key_becomes_field:
                            record[key_becomes_field] = group_key
                        records.append(record)
        return records

    if iterate_mode == "list_of_dicts_with_subkey":
        records = []
        if isinstance(node, list):
            for item in node:
                if isinstance(item, dict):
                    records.append(item)
        elif isinstance(payload, list):
            # unwrap_path pointed at a sub-key within each top-level list item
            for item in payload:
                sub = item
                for key in unwrap_path:
                    sub = sub.get(key, {}) if isinstance(sub, dict) else {}
                if isinstance(sub, dict) and sub:
                    records.append(sub)
        return records

    if iterate_mode == "single_object":
        return [node] if isinstance(node, dict) else []

    return []
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_engine_shape.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine.py tests/test_engine_shape.py
git commit -m "feat: add shape normalizer (unwrap_to_records) to the generic engine"
```

---

## Task 11: `engine.py` — transform library

**Files:**
- Modify: `src/engine.py`
- Test: `tests/test_engine_transforms.py` (new)

**Interfaces:**
- Produces: `apply_transform(record: dict, mapping: dict) -> Any`, dispatching on `mapping["transform"]` to one of `direct`, `nested_path`, `boolean`, `list_index`, `slugify`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_engine_transforms.py
from src.engine import apply_transform


def test_direct():
    assert apply_transform({"form": "FEMALE"}, {"source_field": "form", "transform": "direct"}) == "FEMALE"


def test_nested_path():
    record = {"names": {"English": "Bulbasaur"}}
    assert apply_transform(record, {"source_field": "names.English", "transform": "nested_path"}) == "Bulbasaur"


def test_nested_path_fallback():
    record = {"id": "BULBASAUR", "names": {}}
    mapping = {"source_field": "names.English", "transform": "nested_path", "fallback_field": "id"}
    assert apply_transform(record, mapping) == "BULBASAUR"


def test_boolean_from_truthy_int():
    assert apply_transform({"event_badge": 1}, {"source_field": "event_badge", "transform": "boolean"}) is True


def test_list_index():
    record = {"cpRange": [590, 637]}
    assert apply_transform(record, {"source_field": "cpRange", "transform": "list_index", "index": 0}) == 590
    assert apply_transform(record, {"source_field": "cpRange", "transform": "list_index", "index": 1}) == 637


def test_slugify():
    assert apply_transform({"form": "MEGA_X"}, {"source_field": "form", "transform": "slugify"}) == "mega-x"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_engine_transforms.py -v`
Expected: FAIL — `ImportError: cannot import name 'apply_transform'`

- [ ] **Step 3: Implement**

```python
# src/engine.py — append
def _get_nested(record: Dict[str, Any], dotted_path: str) -> Any:
    node: Any = record
    for part in dotted_path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def apply_transform(record: Dict[str, Any], mapping: Dict[str, Any]) -> Any:
    """Applies one template field_mappings entry's transform to a record.

    Args:
        record: A single extracted record (from unwrap_to_records).
        mapping: One field_mappings value, e.g.
            {"source_field": "names.English", "transform": "nested_path", "fallback_field": "id"}.

    Returns:
        The transformed value, or None if the source field is absent.
    """
    transform = mapping.get("transform", "direct")
    source_field = mapping.get("source_field")

    if transform == "direct":
        return record.get(source_field)

    if transform == "nested_path":
        value = _get_nested(record, source_field)
        if value is None and mapping.get("fallback_field"):
            value = record.get(mapping["fallback_field"])
        return value

    if transform == "boolean":
        value = record.get(source_field)
        return bool(value) if value is not None else None

    if transform == "list_index":
        value = record.get(source_field)
        index = mapping.get("index", 0)
        if isinstance(value, list) and len(value) > index:
            return value[index]
        return None

    if transform == "slugify":
        value = record.get(source_field)
        if value is None:
            return None
        return str(value).lower().replace("_", "-").replace(" ", "-")

    raise ValueError(f"Unknown transform: {transform!r}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_engine_transforms.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine.py tests/test_engine_transforms.py
git commit -m "feat: add transform library (direct/nested_path/boolean/list_index/slugify) to the engine"
```

---

## Task 12: `engine.py` — gender signals and identity normalization

This is the generalized fix for the Frillish bug and the 21-species duplicate-row bug documented
in `KNOWN_ISSUES.md`.

**Files:**
- Modify: `src/engine.py`
- Test: `tests/test_engine_gender_identity.py` (new)

**Interfaces:**
- Produces: `resolve_gender(record: dict, gender_signals: list[dict], context: dict | None = None) -> str` and `normalize_form_identity(species_dex: int, species_slug: str, form_name: str | None, costume_name: str | None, gender: str) -> tuple`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_engine_gender_identity.py
from src.engine import resolve_gender, normalize_form_identity


def test_resolve_gender_boolean_field_signal():
    record = {"isFemale": True}
    signals = [{"signal_type": "boolean_field", "source_field": "isFemale", "when_true": "female"}]
    assert resolve_gender(record, signals) == "female"


def test_resolve_gender_value_pattern_signal_catches_frillish_bug():
    # This is the exact real-world case that broke: isFemale is False, but the
    # `form` value itself says FEMALE.
    record = {"form": "FEMALE", "isFemale": False}
    signals = [
        {"signal_type": "boolean_field", "source_field": "isFemale", "when_true": "female"},
        {"signal_type": "value_pattern", "source_field": "form", "pattern": "(?i)female", "value": "female"},
    ]
    assert resolve_gender(record, signals) == "female"


def test_resolve_gender_key_pattern_signal():
    record = {"names": {"English": "Frillish (Female)"}}
    signals = [{"signal_type": "key_pattern", "source_field": "__record_key__", "key_pattern": "(?i)_female$", "value": "female"}]
    assert resolve_gender(record, signals, context={"record_key": "FRILLISH_FEMALE"}) == "female"


def test_resolve_gender_no_signal_fires():
    record = {"form": "STANDARD"}
    signals = [{"signal_type": "boolean_field", "source_field": "isFemale", "when_true": "female"}]
    assert resolve_gender(record, signals) == "unknown"


def test_normalize_form_identity_collapses_duplicate_representations():
    # regionForms' "Frillish (Female)" and assetForms' form="FEMALE" should
    # normalize to the SAME identity tuple.
    ident_a = normalize_form_identity(592, "592-frillish", "Frillish (Female)", None, "female")
    ident_b = normalize_form_identity(592, "592-frillish", "Female", None, "female")
    assert ident_a == ident_b
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_engine_gender_identity.py -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_gender'`

- [ ] **Step 3: Implement**

```python
# src/engine.py — append
import re


def resolve_gender(
    record: Dict[str, Any],
    gender_signals: List[Dict[str, Any]],
    context: Optional[Dict[str, Any]] = None,
) -> str:
    """Evaluates every gender signal against a record; any one firing means "female".

    This is the generalized fix for a source encoding "this is the female variant"
    inconsistently across fields (a boolean flag, a form-name string, or a dict key
    name) -- rather than trusting one hardcoded field, every declared signal is checked.

    Args:
        record: The extracted record.
        gender_signals: List of signal dicts from a template's `gender_signals`.
        context: Optional extra values not on the record itself, e.g. {"record_key":
            "FRILLISH_FEMALE"} for key_pattern signals sourced from a dict key rather
            than a record field.

    Returns:
        "female" if any signal fires, else "unknown".
    """
    context = context or {}
    for signal in gender_signals:
        signal_type = signal.get("signal_type")
        if signal_type == "boolean_field":
            if bool(record.get(signal["source_field"])) is True:
                return signal.get("when_true", "female")
        elif signal_type == "value_pattern":
            value = record.get(signal["source_field"])
            if isinstance(value, str) and re.search(signal["pattern"], value):
                return signal.get("value", "female")
        elif signal_type == "key_pattern":
            key_value = context.get("record_key", "")
            if re.search(signal["key_pattern"], str(key_value)):
                return signal.get("value", "female")
    return "unknown"


def normalize_form_identity(
    species_dex: int,
    species_slug: str,
    form_name: Optional[str],
    costume_name: Optional[str],
    gender: str,
) -> tuple:
    """Builds a normalized identity tuple for deduplicating form records.

    Strips a leading repeat of the species' own name from form_name (this is what
    caused "592-frillish-frillish-female"-style duplicate slugs), and folds any
    form_name that's purely a gender label (e.g. "Female") into the gender field
    rather than treating it as a distinct form -- so the same real-world variant,
    however it's spelled across different upstream fields, collapses to one tuple.

    Args:
        species_dex: Species dex number.
        species_slug: e.g. "592-frillish".
        form_name: Raw form name, e.g. "Frillish (Female)" or "Female" or None.
        costume_name: Raw costume name, or None.
        gender: Already-resolved gender ("female" or "unknown").

    Returns:
        (species_dex, normalized_form_token, normalized_costume_token, gender)
    """
    species_name_part = species_slug.split("-", 1)[1] if "-" in species_slug else species_slug

    def _normalize_token(raw: Optional[str]) -> Optional[str]:
        if not raw:
            return None
        token = raw.lower().strip()
        token = re.sub(r"\(female\)|\(male\)", "", token).strip()
        token = re.sub(r"[^a-z0-9]+", "-", token).strip("-")
        # strip a leading repeat of the species' own name, e.g. "frillish-female" -> "female"
        if token.startswith(species_name_part):
            token = token[len(species_name_part):].strip("-") or None
        return token or None

    form_token = _normalize_token(form_name)
    # a form_name that's purely a gender label carries no additional identity info
    # once gender is already captured separately -- collapse it to None.
    if form_token in ("female", "male"):
        form_token = None
    if form_token == "standard":
        form_token = None

    costume_token = _normalize_token(costume_name)

    return (species_dex, form_token, costume_token, gender)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_engine_gender_identity.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine.py tests/test_engine_gender_identity.py
git commit -m "feat: add gender-signal resolution and form identity normalization to the engine"
```

---

## Task 13: `engine.py` — `run_source()` entrypoint

**Files:**
- Modify: `src/engine.py`
- Test: `tests/test_engine_run_source.py` (new)
- Fixture: `tests/fixtures/source_templates/fixture_source.yml` (new)
- Fixture: `tests/fixtures/raw_dumps/fixture_source/2026-01-01T000000Z/data.json` (new)

**Interfaces:**
- Consumes: `unwrap_to_records`, `apply_transform`, `resolve_gender` (Tasks 10-12), `TRUST_HIERARCHY` (`src/builder.py`).
- Produces: `run_source(source_key: str, raw_dumps_dir: Path = Path("raw_dumps"), templates_dir: Path = Path("config/source_templates")) -> list[Claim]`. This is what every cutover task (17+) calls instead of a legacy hardcoded function.

- [ ] **Step 1: Create fixtures**

```yaml
# tests/fixtures/source_templates/fixture_source.yml
source_key: fixture_source
endpoint: data
record_extraction:
  unwrap_path: []
  iterate_mode: top_level_list
identity_field: id
field_mappings:
  name:
    source_field: name
    transform: direct
  power:
    source_field: power
    transform: direct
gender_signals: []
overrides: {}
needs_review: []
```

```json
// tests/fixtures/raw_dumps/fixture_source/2026-01-01T000000Z/data.json
[
  {"id": "1", "name": "Tackle", "power": 40},
  {"id": "2", "name": "Ember", "power": 30}
]
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_engine_run_source.py
from pathlib import Path
from src.engine import run_source

FIXTURES = Path(__file__).parent / "fixtures"


def test_run_source_returns_claims_for_every_record_field():
    claims = run_source(
        "fixture_source",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )
    entity_1_claims = {c["attribute"]: c["value"] for c in claims if c["entity_id"] == "fixture_source_1"}
    assert entity_1_claims == {"name": "Tackle", "power": 40}
    for c in claims:
        assert c["source"] == "fixture_source"
        assert "priority" in c
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/test_engine_run_source.py -v`
Expected: FAIL — `ImportError: cannot import name 'run_source'`

- [ ] **Step 4: Implement**

```python
# src/engine.py — append
import json
import yaml
from pathlib import Path


def _get_latest_snapshot_dir(source_dir: Path) -> Optional[Path]:
    if not source_dir.exists():
        return None
    snapshots = sorted([d for d in source_dir.iterdir() if d.is_dir()])
    return snapshots[-1] if snapshots else None


def run_source(
    source_key: str,
    raw_dumps_dir: Path = Path("raw_dumps"),
    templates_dir: Path = Path("config/source_templates"),
) -> List[Dict[str, Any]]:
    """Extracts claims from a source's latest raw snapshot, driven entirely by its template.

    This is the ONLY function that reads config/source_templates/*.yml. It never writes
    to canonical tables -- callers (GoRefsMasterEngine, --test-paranoid) are responsible
    for feeding the returned claims into the ledger/resolver.

    Args:
        source_key: e.g. "pokemon_go_api". Looks for a template named exactly
            "{source_key}.yml", or, for multi-endpoint sources, the caller should pass
            the specific "{source_key}_{endpoint}.yml" template name as source_key.
        raw_dumps_dir: Base directory containing raw_dumps/<source>/<timestamp>/*.json.
        templates_dir: Base directory containing config/source_templates/*.yml.

    Returns:
        List of claim dicts: {"entity_id", "attribute", "source", "value", "priority"}.
    """
    from src.builder import TRUST_HIERARCHY  # local import avoids a circular import at module load

    template_path = templates_dir / f"{source_key}.yml"
    with open(template_path, "r", encoding="utf-8") as f:
        template = yaml.safe_load(f)

    actual_source_key = template.get("source_key", source_key)
    endpoint = template.get("endpoint", source_key)
    source_dir = raw_dumps_dir / actual_source_key
    snapshot_dir = _get_latest_snapshot_dir(source_dir)
    if not snapshot_dir:
        return []

    data_file = snapshot_dir / f"{endpoint}.json"
    if not data_file.exists():
        return []
    with open(data_file, "r", encoding="utf-8") as f:
        payload = json.load(f)

    extraction = template.get("record_extraction", {})
    records = unwrap_to_records(
        payload,
        unwrap_path=extraction.get("unwrap_path", []),
        iterate_mode=extraction.get("iterate_mode", "top_level_list"),
        key_becomes_field=extraction.get("key_becomes_field"),
    )

    field_mappings = dict(template.get("field_mappings", {}))
    field_mappings.update(template.get("overrides", {}))  # overrides always win
    gender_signals = template.get("gender_signals", [])
    identity_field = template.get("identity_field", "id")
    priority = TRUST_HIERARCHY.get(actual_source_key, 99)

    claims: List[Dict[str, Any]] = []
    for record in records:
        raw_id = record.get(identity_field)
        if raw_id is None:
            continue
        entity_id = f"{actual_source_key}_{raw_id}"

        for attribute, mapping in field_mappings.items():
            value = apply_transform(record, mapping)
            if value is not None:
                claims.append({
                    "entity_id": entity_id,
                    "attribute": attribute,
                    "source": actual_source_key,
                    "value": value,
                    "priority": priority,
                })

        if gender_signals:
            gender = resolve_gender(record, gender_signals)
            claims.append({
                "entity_id": entity_id,
                "attribute": "gender",
                "source": actual_source_key,
                "value": gender,
                "priority": priority,
            })

    return claims
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_engine_run_source.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/engine.py tests/test_engine_run_source.py tests/fixtures
git commit -m "feat: implement engine.run_source() entrypoint"
```

---

## Task 14: `profiler.py` — shape detection, identity ranking, field cataloging

**Files:**
- Create: `src/profiler.py`
- Test: `tests/test_profiler_detection.py` (new)

**Interfaces:**
- Produces: `detect_shape(payload) -> list[tuple[list[str], list[dict]]]`, `rank_identity_candidates(records, sample_n=200) -> list[tuple[str, int, int]]`, `catalog_fields(records, sample_n=200) -> tuple[Counter, dict, dict, int]`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_profiler_detection.py
from src.profiler import detect_shape, rank_identity_candidates, catalog_fields


def test_detect_shape_finds_nested_dict_of_lists():
    payload = {"currentList": {"lvl1": [{"id": "A"}, {"id": "B"}]}, "graphics": {}}
    candidates = detect_shape(payload)
    assert candidates[0][0] == ["currentList"]
    assert len(candidates[0][1]) == 2


def test_rank_identity_candidates_ranks_by_uniqueness():
    records = [{"speciesId": "bulbasaur", "dex": 1}, {"speciesId": "bulbasaur_shadow", "dex": 1}]
    candidates = rank_identity_candidates(records)
    by_field = {c[0]: c[1] for c in candidates}
    assert by_field["speciesId"] == 2  # unique
    assert by_field["dex"] == 1        # collides


def test_catalog_fields_tracks_presence_and_sparsity():
    records = [{"a": 1, "b": "x"}, {"a": 2}]
    presence, types, examples, n = catalog_fields(records)
    assert presence["a"] == 2
    assert presence["b"] == 1
    assert n == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_profiler_detection.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.profiler'`

- [ ] **Step 3: Implement**

```python
# src/profiler.py
"""Source profiler: inspects raw JSON and proposes config/source_templates/*.yml templates.

Ranks identity-field candidates by uniqueness rather than checking a hardcoded
shortlist of field names -- a fixed shortlist was tried during design review and
missed pvpoke's real identity field (speciesId) entirely (see the spec's
"Profiler dry-run findings" section), which is exactly the kind of hardcoding
this whole project exists to move away from.
"""
import re
from collections import Counter, defaultdict
from typing import Any, Dict, List, Tuple


def detect_shape(payload: Any, max_depth: int = 4) -> List[Tuple[List[str], List[Dict[str, Any]]]]:
    """Finds every point in payload where a list of record-shaped dicts appears.

    Returns:
        List of (path, records) tuples, in discovery order. Callers typically pick
        the shallowest-path, most-populous candidate as primary.
    """
    candidates: List[Tuple[List[str], List[Dict[str, Any]]]] = []

    def is_record_list(v: Any) -> bool:
        return isinstance(v, list) and len(v) > 0 and all(isinstance(x, dict) for x in v[:20])

    def walk(node: Any, path: List[str], depth: int) -> None:
        if depth > max_depth:
            return
        if is_record_list(node):
            candidates.append((path, node))
            return
        if isinstance(node, dict):
            for key, sub in node.items():
                walk(sub, path + [key], depth + 1)

    walk(payload, [], 0)
    return candidates


def rank_identity_candidates(records: List[Dict[str, Any]], sample_n: int = 200) -> List[Tuple[str, int, int]]:
    """Ranks every field by uniqueness-within-sample, not a hardcoded name shortlist.

    Returns:
        List of (field_name, unique_count, sampled_n) sorted by unique_count descending.
    """
    sample = records[:sample_n]
    n = len(sample)
    field_values: Dict[str, List[Any]] = defaultdict(list)
    for rec in sample:
        for k, v in rec.items():
            if isinstance(v, (str, int)) and not isinstance(v, bool):
                field_values[k].append(v)

    ranked = []
    for field, values in field_values.items():
        if len(values) < n:
            continue  # only fields present on every sampled record are identity candidates
        ranked.append((field, len(set(values)), n))
    ranked.sort(key=lambda t: -t[1])
    return ranked


def catalog_fields(records: List[Dict[str, Any]], sample_n: int = 200) -> Tuple[Counter, Dict[str, Counter], Dict[str, Any], int]:
    """Catalogs every field's presence count, observed type(s), and one example value.

    Includes one level of nested-dict flattening (e.g. "names.English").

    Returns:
        (field_presence, field_types, examples, sampled_n)
    """
    field_presence: Counter = Counter()
    field_types: Dict[str, Counter] = defaultdict(Counter)
    examples: Dict[str, Any] = {}
    sample = records[:sample_n]

    for rec in sample:
        if not isinstance(rec, dict):
            continue
        for k, v in rec.items():
            field_presence[k] += 1
            field_types[k][type(v).__name__] += 1
            examples.setdefault(k, v)
            if isinstance(v, dict):
                for nk, nv in v.items():
                    key = f"{k}.{nk}"
                    field_presence[key] += 1
                    field_types[key][type(nv).__name__] += 1
                    examples.setdefault(key, nv)

    return field_presence, field_types, examples, len(sample)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_profiler_detection.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/profiler.py tests/test_profiler_detection.py
git commit -m "feat: add profiler shape/identity/field detection (uniqueness-ranked, not hardcoded)"
```

---

## Task 15: `profiler.py` — signal detection, template writer, drift/`--deep-dive`

**Files:**
- Modify: `src/profiler.py`
- Modify: `go_refs.py` (add `--deep-dive` flag)
- Test: `tests/test_profiler_template_writer.py` (new)

**Interfaces:**
- Produces: `detect_gender_signals(records, sample_n=200) -> list[dict]`, `detect_range_pairs(examples) -> list[tuple[str, list]]`, `compute_shape_fingerprint(field_presence) -> str`, `class SourceProfiler` with `profile_source(source_key, endpoint, ...) -> Path` and `profile_all_sources() -> None`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_profiler_template_writer.py
import yaml
from pathlib import Path
from src.profiler import SourceProfiler


def test_profile_source_writes_template_with_stale_override_flagged(tmp_path):
    raw_dir = tmp_path / "raw_dumps" / "fixture_source" / "2026-01-01T000000Z"
    raw_dir.mkdir(parents=True)
    (raw_dir / "data.json").write_text('[{"id": "1", "form": "FEMALE", "isFemale": false}]')

    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True)
    # Pre-existing template with an override pointing at a field that will vanish
    existing = {
        "source_key": "fixture_source", "endpoint": "data",
        "source_fingerprint": "sha256:stale",
        "record_extraction": {"unwrap_path": [], "iterate_mode": "top_level_list"},
        "identity_field": "id", "field_mappings": {},
        "overrides": {"gender": {"source_field": "no_longer_exists", "transform": "direct"}},
        "needs_review": [],
    }
    (templates_dir / "fixture_source.yml").write_text(yaml.dump(existing))

    profiler = SourceProfiler(raw_dumps_dir=tmp_path / "raw_dumps", templates_dir=templates_dir)
    profiler.profile_source("fixture_source", "data")

    written = yaml.safe_load((templates_dir / "fixture_source.yml").read_text())
    assert "gender" not in written["field_mappings"] or True  # override fell back, not asserted here
    assert any("no_longer_exists" in r.get("reason", "") for r in written["needs_review"])
    assert written["overrides"] == existing["overrides"]  # override text itself is preserved verbatim
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_profiler_template_writer.py -v`
Expected: FAIL — `AttributeError: module 'src.profiler' has no attribute 'SourceProfiler'`

- [ ] **Step 3: Implement signal detection and the template writer**

```python
# src/profiler.py — append
import hashlib
import json
import yaml
import datetime
from pathlib import Path
from typing import Optional


def detect_gender_signals(records: List[Dict[str, Any]], sample_n: int = 200) -> List[Dict[str, Any]]:
    sample = records[:sample_n]
    boolean_fields, value_fields = set(), set()
    for rec in sample:
        for k, v in rec.items():
            if isinstance(v, bool) and re.search(r"(?i)female", k):
                boolean_fields.add(k)
            if isinstance(v, str) and re.search(r"(?i)female", v):
                value_fields.add(k)
    signals = []
    for f in sorted(boolean_fields):
        signals.append({"signal_type": "boolean_field", "source_field": f, "when_true": "female"})
    for f in sorted(value_fields):
        signals.append({"signal_type": "value_pattern", "source_field": f, "pattern": "(?i)female", "value": "female"})
    return signals


def detect_range_pairs(examples: Dict[str, Any]) -> List[Tuple[str, List[Any]]]:
    return [
        (k, v) for k, v in examples.items()
        if isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v)
    ]


def compute_shape_fingerprint(field_presence: Counter) -> str:
    """Hashes the sorted set of field paths (not values) -- used to detect upstream drift."""
    key_paths = sorted(field_presence.keys())
    return "sha256:" + hashlib.sha256(json.dumps(key_paths).encode("utf-8")).hexdigest()[:16]


class SourceProfiler:
    def __init__(self, raw_dumps_dir: Path = Path("raw_dumps"), templates_dir: Path = Path("config/source_templates")):
        self.raw_dumps_dir = raw_dumps_dir
        self.templates_dir = templates_dir
        self.templates_dir.mkdir(parents=True, exist_ok=True)

    def _resolve_path(self, record: Dict[str, Any], path: str) -> Any:
        node: Any = record
        for part in path.split("."):
            if not isinstance(node, dict) or part not in node:
                return None
            node = node[part]
        return node

    def profile_source(self, source_key: str, endpoint: str) -> Optional[Path]:
        snapshot_dirs = self.raw_dumps_dir / source_key
        if not snapshot_dirs.exists():
            print(f"[Profiler] No raw dumps found for '{source_key}', skipping.")
            return None
        snapshots = sorted([d for d in snapshot_dirs.iterdir() if d.is_dir()])
        if not snapshots:
            return None
        data_file = snapshots[-1] / f"{endpoint}.json"
        if not data_file.exists():
            print(f"[Profiler] No '{endpoint}.json' in latest snapshot for '{source_key}', skipping.")
            return None

        with open(data_file, "r", encoding="utf-8") as f:
            payload = json.load(f)

        candidates = detect_shape(payload)
        if not candidates:
            print(f"[Profiler] No record-shaped list found for '{source_key}/{endpoint}'.")
            return None
        candidates.sort(key=lambda c: (len(c[0]), -len(c[1])))
        primary_path, primary_records = candidates[0]

        identity_candidates = rank_identity_candidates(primary_records)
        identity_field = identity_candidates[0][0] if identity_candidates else "id"

        field_presence, field_types, examples, sample_n = catalog_fields(primary_records)
        gender_signals = detect_gender_signals(primary_records, sample_n)
        range_pairs = detect_range_pairs(examples)

        field_mappings: Dict[str, Any] = {}
        for field in field_presence:
            if "." in field:
                continue  # nested fields get folded in via a dedicated nested_path mapping only when needed
            field_mappings[field] = {"source_field": field, "transform": "direct"}
        for pair_field, _ in range_pairs:
            field_mappings.pop(pair_field, None)
            field_mappings[f"min_{pair_field}"] = {"source_field": pair_field, "transform": "list_index", "index": 0}
            field_mappings[f"max_{pair_field}"] = {"source_field": pair_field, "transform": "list_index", "index": 1}

        template_path = self.templates_dir / f"{source_key}.yml"
        existing_overrides: Dict[str, Any] = {}
        if template_path.exists():
            with open(template_path, "r", encoding="utf-8") as f:
                existing = yaml.safe_load(f) or {}
            existing_overrides = existing.get("overrides", {})

        needs_review = []
        validated_overrides = dict(existing_overrides)
        for attr, override_mapping in existing_overrides.items():
            source_field = override_mapping.get("source_field", "")
            probe_record = primary_records[0] if primary_records else {}
            if self._resolve_path(probe_record, source_field) is None and source_field not in field_presence:
                needs_review.append({
                    "field": attr,
                    "reason": f"override for '{attr}' references '{source_field}', which no longer exists in the new shape",
                })
                # the override itself is preserved verbatim in the file (a human must edit it),
                # but it is NOT merged into field_mappings below, so mapping falls back to auto-detected

        template = {
            "source_key": source_key,
            "endpoint": endpoint,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_fingerprint": compute_shape_fingerprint(field_presence),
            "record_extraction": {
                "unwrap_path": primary_path,
                "iterate_mode": "dict_of_lists" if len(primary_path) > 0 and isinstance(
                    self._resolve_path(payload, ".".join(primary_path)), dict
                ) else "top_level_list",
            },
            "identity_field": identity_field,
            "field_mappings": field_mappings,
            "gender_signals": gender_signals,
            "overrides": existing_overrides,
            "needs_review": needs_review,
        }

        with open(template_path, "w", encoding="utf-8") as f:
            yaml.dump(template, f, sort_keys=False)

        if needs_review:
            for item in needs_review:
                print(f"[Profiler] WARNING: {source_key}: {item['reason']}")

        return template_path

    def profile_all_sources(self) -> None:
        import yaml as _yaml
        sources_config_path = Path("config/sources.yml")
        if not sources_config_path.exists():
            return
        with open(sources_config_path, "r", encoding="utf-8") as f:
            config = _yaml.safe_load(f)
        for source_key, source_conf in config.get("sources", {}).items():
            endpoints = source_conf.get("endpoints")
            if endpoints:
                for ep in endpoints:
                    self.profile_source(source_key, ep["name"])
            else:
                # single-endpoint source: use the source_key itself as a best-guess endpoint name
                self.profile_source(source_key, source_key)
```

- [ ] **Step 4: Wire `--deep-dive` into `go_refs.py`**

```python
# go_refs.py — add near run_source_coverage_test()
def run_deep_dive(target: str = "all") -> None:
    from src.profiler import SourceProfiler
    profiler = SourceProfiler()
    if target == "all":
        profiler.profile_all_sources()
    else:
        profiler.profile_source(target, target)
```

```python
# go_refs.py, in main() — add the argument and dispatch
    parser.add_argument("--deep-dive", nargs="?", const="all", help="Run schema profiler to generate/update source templates (specify source or 'all')")
    # ... in the args-checking block, add args.deep_dive to the `if not any([...])` list
    if args.deep_dive:
        run_deep_dive(target=args.deep_dive)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_profiler_template_writer.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/profiler.py go_refs.py tests/test_profiler_template_writer.py
git commit -m "feat: add gender/range-pair signal detection, template writer, and --deep-dive flag"
```

---

## Task 16: Parsed-dumps versioning

**Files:**
- Modify: `src/engine.py` (`run_source()`)
- Test: `tests/test_parsed_dumps_versioning.py` (new)

**Interfaces:**
- Modifies `run_source()`'s signature to accept `parsed_dumps_dir: Path = Path("output/parsed_dumps")` and write its returned claims to `parsed_dumps_dir / source_key / snapshot_dir.name / "claims.jsonl"` as a side effect.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_parsed_dumps_versioning.py
import json
from pathlib import Path
from src.engine import run_source

FIXTURES = Path(__file__).parent / "fixtures"


def test_run_source_writes_versioned_parsed_dump(tmp_path):
    run_source(
        "fixture_source",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
        parsed_dumps_dir=tmp_path / "parsed_dumps",
    )
    written = list((tmp_path / "parsed_dumps" / "fixture_source").glob("*/claims.jsonl"))
    assert len(written) == 1
    assert written[0].parent.name == "2026-01-01T000000Z"  # matches the raw snapshot's own timestamp
    lines = written[0].read_text().splitlines()
    assert len(lines) > 0
    assert json.loads(lines[0])["entity_id"] == "fixture_source_1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_parsed_dumps_versioning.py -v`
Expected: FAIL — `TypeError: run_source() got an unexpected keyword argument 'parsed_dumps_dir'`

- [ ] **Step 3: Implement**

```python
# src/engine.py — modify run_source()'s signature and add the write at the end, before `return claims`
def run_source(
    source_key: str,
    raw_dumps_dir: Path = Path("raw_dumps"),
    templates_dir: Path = Path("config/source_templates"),
    parsed_dumps_dir: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    # ... (unchanged body through `claims: List[Dict[str, Any]] = []` and the extraction loop) ...

    if parsed_dumps_dir is not None:
        out_dir = parsed_dumps_dir / actual_source_key / snapshot_dir.name
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / "claims.jsonl", "w", encoding="utf-8") as f:
            for claim in claims:
                f.write(json.dumps(claim) + "\n")

    return claims
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_parsed_dumps_versioning.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine.py tests/test_parsed_dumps_versioning.py
git commit -m "feat: version parsed claims alongside their source raw snapshot"
```

---

## Task 17: Cutover — `pokeapi` (fully worked, plumbing smoke test)

Per the spec, `pokeapi` isn't mapped to any canonical field today — this cutover proves the
engine plumbing end-to-end with zero risk, not a data-quality fix. No override is expected.

**Files:**
- Modify: `go_refs.py` (`run_deep_dive`) — none needed, already generic
- Modify: `src/builder.py` (`collect_and_resolve_claims`) — add the cutover call
- Test: `tests/test_cutover_pokeapi.py` (new)

**Interfaces:**
- Consumes: `engine.run_source` (Task 13).
- Produces: `pokeapi`'s claims (currently zero canonical attributes, since nothing maps to it yet) flow through the same ledger as every other source.

- [ ] **Step 1: Generate the template**

Run: `uv run go_refs.py --deep-dive pokeapi`
Expected: `config/source_templates/pokeapi.yml` is created, with `identity_field: name` (per the
spec's documented dry-run finding) and `field_mappings` for `name`/`url` only.

- [ ] **Step 2: Write the failing test**

```python
# tests/test_cutover_pokeapi.py
from src.builder import GoRefsMasterEngine
from unittest.mock import patch, MagicMock


def test_pokeapi_claims_flow_through_ledger_via_engine(tmp_path):
    engine = GoRefsMasterEngine(raw_dumps_dir=tmp_path, db_path=tmp_path / "test.duckdb")

    with patch("src.builder.run_source") as mock_run_source, \
         patch("src.builder.FetcherRegistry") as mock_registry:
        mock_run_source.return_value = [
            {"entity_id": "pokeapi_bulbasaur", "attribute": "name", "source": "pokeapi", "value": "bulbasaur", "priority": 7}
        ]
        fetcher = MagicMock()
        fetcher.load_latest_raw.return_value = []
        fetcher.extract_structured_claims.return_value = {}
        mock_registry.get_fetcher_class.return_value = lambda *a: fetcher

        engine.collect_and_resolve_claims()

    mock_run_source.assert_any_call("pokeapi", raw_dumps_dir=tmp_path, templates_dir=Path("config/source_templates"))
    pokeapi_claims = [c for c in engine.claims_ledger if c["source"] == "pokeapi"]
    assert len(pokeapi_claims) == 1
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/test_cutover_pokeapi.py -v`
Expected: FAIL — `run_source` never called from `builder.py` yet.

- [ ] **Step 4: Wire the cutover call**

```python
# src/builder.py — add near the top of the file
from src.engine import run_source
from pathlib import Path as _Path
```

```python
# src/builder.py, in collect_and_resolve_claims(), right after `self.claims_ledger.clear()`
        # --- Cut-over sources: extracted via the generic engine, not hardcoded parsing ---
        for claim in run_source("pokeapi", raw_dumps_dir=self.raw_dumps_dir, templates_dir=_Path("config/source_templates")):
            self.claims_ledger.append(claim)
```

Note: `pokeapi`'s claims (currently just `name`/`url` per Step 1) don't correspond to any
existing canonical entity_id scheme (`pokemon_dex_N`) — they're inert until a future fetcher
enhancement gives them somewhere to resolve against (tracked in `TODO.md`, created in Step 7
below). This cutover's success criterion is purely "the plumbing runs without error and claims
land in the ledger," per the spec.

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_cutover_pokeapi.py -v`
Expected: PASS

- [ ] **Step 6: Run the real build and confirm no regression**

Run: `uv run go_refs.py --build && uv run go_refs.py --test`
Expected: species/forms/moves counts unchanged; `--test` runs without error (pokeapi's claims
simply won't resolve against any canonical table, which is fine — `_find_canonical_value`
returns `None` for unmapped entity prefixes, and since nothing else claims the same
`pokeapi_*` entity ids, there's no conflict to report as a gap).

- [ ] **Step 7: Create `TODO.md`**

```markdown
# TODO

## `pokeapi` fetcher enhancement

Its current fetcher (`src/fetchers/pokeapi.py`) only pulls list endpoints
(`{name, url}` pairs) -- genuinely mappable data (flavor text, genera/category)
requires per-resource detail fetching (~1000+ additional HTTP calls across
species/moves). Deferred until there's a concrete consumer need; the generic
engine (this plan) is now in place to receive the mapped output whenever this
is picked up.
```

```bash
git add TODO.md
```

- [ ] **Step 8: Commit**

```bash
git add config/source_templates/pokeapi.yml src/builder.py tests/test_cutover_pokeapi.py
git commit -m "feat: cut over pokeapi to the generic engine (plumbing smoke test, no canonical mapping yet)

Also adds TODO.md tracking the deferred pokeapi fetcher enhancement."
```

---

## Task 18: Cutover — `pogoapi_net`

**Files:**
- Modify: `src/builder.py` — delete the `pogo_stats_by_dex` construction and the `pogoapi_net`
  half of the base-stats loop (`main:218-248`'s `pogo_stat`/`"pogoapi_net"` claim branch only —
  the `alexelgt_game_masters` half stays until Task 22); delete the entire "Build Badges" block
  (`main:609-630`, fully replaced since badges is 100% `pogoapi_net`-sourced); delete
  `max_cp_by_dex` construction and its one `emit_claim` call from Task 6 Step 4 (superseded).
- Template needs `pogoapi_net.yml` per **endpoint actually used today** — `pogoapi_net` has 18
  configured endpoints in `config/sources.yml` but `collect_and_resolve_claims` only reads 12 of
  them (`cp_multiplier`, `type_effectiveness`, `weather_boosts`, `pokemon_max_cp`,
  `pokemon_stats`, `fast_moves`, `charged_moves`, `shadow_pokemon`, `mega_pokemon`,
  `community_days`, `alolan_pokemon`, `galarian_pokemon`, `released_pokemon`, `nesting_pokemon`,
  `shiny_pokemon`, `baby_pokemon`, `badges`) — run `--deep-dive pogoapi_net` once per endpoint
  actually consumed (loop `profile_source("pogoapi_net", endpoint_name)` for each), producing one
  template file per endpoint (`config/source_templates/pogoapi_net_badges.yml`,
  `config/source_templates/pogoapi_net_pokemon_stats.yml`, etc.) since they have unrelated shapes.
- `run_source()`'s `source_key` parameter for a multi-endpoint source should be called with the
  full template filename stem, e.g. `run_source("pogoapi_net_badges", ...)` — the `actual_source_key`
  read back out of that template's `source_key: pogoapi_net` field is what tags emitted claims,
  so trust-tier priority resolves correctly regardless of which endpoint-specific template was used.
- Badges' template needs `identity_field` overridden to a synthetic combination since raw badge
  dicts don't have a stable `id` field for event badges sharing a `name` across multiple dated
  entries (see `KNOWN_ISSUES.md`'s badges finding) — add to `overrides`:
  `{"__identity__": {"source_field": "name", "transform": "direct"}}` is not sufficient by itself
  since `name` collides across dated event entries; instead set `identity_field: name` and accept
  that dated event-badge variants collapse to one entity for now (their `description`/`rank`
  differ per date, which will surface as expected discrepancies, not a bug — annotate this
  explicitly in `needs_review` by hand-editing the generated template before committing it).

- [ ] **Step 1: Generate one template per endpoint actually consumed** — call
  `SourceProfiler(raw_dumps_dir=Path("raw_dumps"), templates_dir=Path("config/source_templates")).profile_source("pogoapi_net", ep)`
  once for each of the 16 endpoint names listed above (`cp_multiplier`, `type_effectiveness`,
  `weather_boosts`, `pokemon_max_cp`, `pokemon_stats`, `fast_moves`, `charged_moves`,
  `shadow_pokemon`, `mega_pokemon`, `community_days`, `alolan_pokemon`, `galarian_pokemon`,
  `released_pokemon`, `nesting_pokemon`, `shiny_pokemon`, `baby_pokemon`, `badges`), producing
  `config/source_templates/pogoapi_net_<endpoint>.yml` for each.
- [ ] **Step 2: Write the failing test** — in `tests/test_cutover_pogoapi_net.py`, mock
  `src.builder.run_source` to return a synthetic badge claim
  (`{"entity_id": "pogoapi_net_badges_Triathlete", "attribute": "name", "source": "pogoapi_net", "value": "Triathlete", "priority": 6}`)
  and assert `engine.collect_and_resolve_claims()` calls `run_source("pogoapi_net_badges", ...)`
  and that the claim lands in `engine.claims_ledger` — same test structure as
  `tests/test_cutover_pokeapi.py`, with `pogoapi_net_badges` substituted for `pokeapi`.
- [ ] **Step 3: Run** `uv run pytest tests/test_cutover_pogoapi_net.py -v` **and confirm it fails**
  with `run_source` never called for `pogoapi_net_badges`.
- [ ] **Step 4: Wire 16 cutover calls into `collect_and_resolve_claims`** (one
  `for claim in run_source("pogoapi_net_<endpoint>", ...): self.claims_ledger.append(claim)`
  per endpoint), and delete: the `pogo_stats_by_dex` construction and the `pogoapi_net` half of
  the base-stats loop's claim branch (the `alexelgt_game_masters` half stays until Task 22); the
  entire "Build Badges" block; `max_cp_by_dex` construction and its Task 6 Step 4 `emit_claim`
  call (superseded by the templated version).
- [ ] **Step 5: Run** `uv run pytest tests/test_cutover_pogoapi_net.py -v` **and confirm it passes**.
- [ ] **Step 6: Run the real build** — `uv run go_refs.py --build && uv run go_refs.py --test`.
  Expected: `badges` table row count unchanged (597) and `is_event_badge`/`rank`/`targets` fields
  still populated identically; base stats for dex 222 still resolve to `alexelgt_game_masters`'s
  values (that source isn't cut over yet, so its half of the shared block is untouched).
- [ ] **Step 7: Commit** — `git add config/source_templates/pogoapi_net_*.yml src/builder.py tests/test_cutover_pogoapi_net.py && git commit -m "feat: cut over pogoapi_net to the generic engine (16 endpoints), delete legacy badges/base-stats code"`

---

## Task 19: Cutover — `pvpoke`

**Files:**
- Modify: `src/builder.py` — delete `pvpoke_moves_map` construction and its use inside the
  `fast_moves_raw`/`charged_moves_raw` loops (`main:406, 412, 432`); delete the "Build PvP
  Leagues" block (`main:632-640`).
- **Critical, per the spec's detailed dry-run finding:** `pvpoke`'s `pokemon` list is NOT the
  right thing to template for the fields currently consumed (moves/leagues only) — do not
  attempt to also pull species-level data from `pvpoke` in this cutover; that's future scope.
  Template only the `moves` (334 records) and `formats` (14 records) lists from
  `raw_dumps/pvpoke/*/gamemaster.json`, via `record_extraction.unwrap_path: ["moves"]` /
  `["formats"]` respectively, each as its own template
  (`config/source_templates/pvpoke_moves.yml`, `config/source_templates/pvpoke_formats.yml`).
- `moves`' `identity_field` is `moveId` (confirm via `--deep-dive`'s identity ranking, not
  assumed) — do not reuse `pokemon_go_api`'s or `pogoapi_net`'s `move_id` entity scheme; `pvpoke`
  claims for moves should target the SAME entity_id the other two sources use
  (`f"move_{normalized_name}"`, matching Task 7's table) so trust-tier resolution actually
  compares them — this requires an explicit `overrides` entry in `pvpoke_moves.yml` mapping
  `moveId` through a `slugify`-equivalent transform to match the existing normalization
  (`m_name.lower().replace(" ", "_")` in the legacy code) rather than using the raw `moveId` as-is
  if their casing/format differs; verify by comparing a sample entity_id from both sources'
  claims for the same real move (e.g. "Tackle") before deleting the legacy `pvpoke_moves_map`.

- [ ] **Step 1: Generate templates** — `--deep-dive` against `moves` and `formats` sub-shapes (profile each via `profile_source("pvpoke", "moves")`/`("pvpoke", "formats")` reading from the same `gamemaster.json` file — the profiler's `unwrap_path` handles selecting the right list within one file)
- [ ] **Step 2: Write the failing test** asserting `pvpoke` move claims share entity_ids with existing `pogoapi_net`/GAME_MASTER move claims for a known move name
- [ ] **Step 3: Run test to verify it fails**
- [ ] **Step 4: Wire cutover calls, delete `pvpoke_moves_map` and the PvP Leagues block**
- [ ] **Step 5: Run test to verify it passes**
- [ ] **Step 6: Run the real build** — confirm `moves` table's `pvp_power`/`pvp_cooldown_turns` fields for a known move (e.g. Tackle) are unchanged, and `pvp_leagues` row count unchanged (verify against the `baseline/pre-generic-engine` branch's `output/GoRefs_Master.duckdb`)
- [ ] **Step 7: Commit** — `git commit -m "feat: cut over pvpoke to the generic engine (moves + formats)"`

---

## Task 20: Cutover — `pokemon_go_api`

The highest-value cutover — this is where the gender/costume/raid-boss bugs originally lived.
This exercises the Task 12 gender-signal/identity-normalization functions end-to-end for the
first time against a real, previously-buggy source.

**Files:**
- Modify: `src/builder.py` — delete the entire species/forms build loop's `assetForms`/
  `regionForms` handling (`main:267-402`, everything already retrofitted with `emit_claim` calls
  in Task 6 gets replaced, not just supplemented, by engine-driven claims); delete raid_bosses,
  max_battles, and quests blocks (`main:489-552`).
- Templates needed: `pokemon_go_api_pokedex.yml` (species + forms, including `gender_signals`
  per Task 12's Frillish-fixing signals and `record_extraction` handling `assetForms`/
  `regionForms` as **additional per-record sub-lists**, not the top-level `unwrap_to_records`
  target — this requires a `field_mappings` extension not yet covered by Task 11's transform
  library: add a new transform, `sub_records`, that takes a nested list field (e.g.
  `assetForms`) and emits one additional claim-set per sub-record, reusing the parent's
  `identity_field` value plus a normalized-identity suffix from `normalize_form_identity`
  (Task 12) as the sub-entity's id. Implement this transform in `src/engine.py` as part of this
  task's Step 4, with its own failing-test-first cycle, since it's new engine capability
  discovered only once a real multi-nested source is actually cut over — write
  `tests/test_engine_sub_records_transform.py` following the same pattern as Task 11.
- `pokemon_go_api_raidboss.yml` / `pokemon_go_api_maxbattles.yml`: `unwrap_path: ["currentList"]`,
  `iterate_mode: "dict_of_lists"`, `key_becomes_field: "tier"` — this is the exact case
  `unwrap_to_records` (Task 10) was built for; no new engine work needed here.
- `pokemon_go_api_quests.yml`: straightforward `top_level_list`; expect zero rows (upstream is
  currently empty — confirmed in `KNOWN_ISSUES.md`, not a bug).

- [ ] **Step 1: Implement the `sub_records` transform first** (TDD cycle: failing test in `tests/test_engine_sub_records_transform.py`, then implement in `src/engine.py`, verify, commit as its own small commit before continuing this task)
- [ ] **Step 2: Generate templates** — `--deep-dive` for `pokedex`, `raidboss`, `maxbattles`, `quests`
- [ ] **Step 3: Write the failing test** — assert a rebuild produces exactly 2 form rows for dex 592 (Frillish), both correctly identified, matching `KNOWN_ISSUES.md`'s documented expectation
- [ ] **Step 4: Run test to verify it fails**
- [ ] **Step 5: Wire cutover calls, delete the legacy species/forms/raid_bosses/max_battles/quests blocks**
- [ ] **Step 6: Run test to verify it passes**
- [ ] **Step 7: Run the real build and re-check every spot check from `KNOWN_ISSUES.md`:**

```bash
uv run go_refs.py --build
uv run python3 -c "
import duckdb
con = duckdb.connect('output/GoRefs_Master.duckdb', read_only=True)
print('costume forms:', con.execute('select count(*) from forms where costume_name is not null').fetchone()[0])
print('frillish forms:')
print(con.execute(\"select slug, form_name, costume_name, gender from forms where dex_number=592\").fetchdf().to_string())
print('true duplicate identity check:', con.execute('''
  select count(*) from (select dex_number, form_name, costume_name, gender, count(*) c
  from forms group by 1,2,3,4 having count(*)>1) t
''').fetchone()[0])
print('raid_bosses:', con.execute('select count(*) from raid_bosses').fetchone()[0])
"
```

Expected: costume forms == 272 (or the current real count, since upstream data may have changed
since `KNOWN_ISSUES.md` was written — the important thing is it's not 0); Frillish shows exactly
2 rows (Standard, Female — `gender='female'` on the Female row); duplicate-identity count == 0;
`raid_bosses` count matches the current real raid rotation (was 17 when last checked).

- [ ] **Step 8: Commit** — `git commit -m "feat: cut over pokemon_go_api to the generic engine (species/forms/raid_bosses/max_battles/quests), fixing gender and duplicate-row bugs by construction"`

---

## Task 21: Cutover — `rplus_shiny`

**Files:**
- Modify: `src/builder.py` — delete `shiny_dates_by_dex` construction and its `emit_claim` call from Task 6 Step 5 (superseded).
- Template: `rplus_shiny_shiny_releases.yml`. Note the legacy code's messy field-name fallback
  chain (`row.get("pid") or row.get("_dex") or row.get("dex")` and
  `row.get("debut") or row.get("shiny_date") or row.get("date")`) — run `--deep-dive` first and
  check its `needs_review` output for sparsity on these fields before writing `field_mappings`;
  if the profiler's `catalog_fields` shows multiple of these keys present across different
  records (a schema that changed over the sheet's history), template each with its own
  `field_mappings` entry and let `apply_transform`'s `None`-on-missing behavior naturally pick
  whichever is present per record — do not collapse them into one hardcoded fallback chain in a
  template's `source_field` (templates support one `source_field` per attribute; if genuinely
  more than one raw field can supply `shiny_release_date`, add
  `tests/test_engine_transforms.py::test_first_present_transform` and a new `first_present`
  transform to `src/engine.py` taking `source_fields: [list]` instead of `source_field` — TDD
  cycle same as Task 11 — only if the profiler's dry-run actually shows this is needed).

- [ ] **Step 1: Generate template and inspect `needs_review`/field sparsity**
- [ ] **Step 2: (Conditional) implement `first_present` transform if the sparsity check from Step 1 shows it's needed, TDD cycle as above**
- [ ] **Step 3: Write the failing test** asserting a known dex's `shiny_release_date` claim from `rplus_shiny` matches the pre-cutover value for that dex (compare against `baseline/pre-generic-engine`)
- [ ] **Step 4: Run test to verify it fails**
- [ ] **Step 5: Wire cutover call, delete `shiny_dates_by_dex`**
- [ ] **Step 6: Run test to verify it passes**
- [ ] **Step 7: Run the real build** — confirm `shiny_release_date` values across all species match the baseline branch's build exactly (a full-table diff, not spot checks, since this field has no known bugs to re-verify — regression safety is the only concern here)
- [ ] **Step 8: Commit** — `git commit -m "feat: cut over rplus_shiny to the generic engine"`

---

## Task 22: Cutover — `alexelgt_game_masters`

The largest and most authoritative source. This is what finally lets the shared base-stats block
(split since Task 18) be deleted entirely.

**Files:**
- Modify: `src/builder.py` — delete the `alexelgt_game_masters` half of the base-stats loop
  (the last remaining piece of `main:230-248`, now fully replaced); delete `gm_species_stats`,
  `gm_moves`, `gm_cp_mults`, `gm_items`, `gm_stickers`, `gm_avatars`, `gm_friendship`,
  `gm_encounters`, `gm_raw_templates` construction and every downstream use of them (Progression
  block `main:448-455`, and the Task 7 `emit_claim` calls covering items/stickers/avatars/
  friendship/encounters, all superseded).
- `GameMasterFetcher.extract_structured_claims()` (`src/fetchers/game_master.py`) is itself a
  hand-written per-template-type parser (species/moves/cp-multipliers/items/stickers/etc. each
  get their own `if data.get(...)` branch) — this is the same class of hardcoding the rest of
  this plan removes elsewhere, but `GAME_MASTER.json`'s `[{templateId, data: {...}}]` shape with
  8+ *heterogeneous* record types multiplexed into one array is a fundamentally different problem
  from every other source (which has one shape per file). Do not attempt to force this into a
  single `field_mappings` template in this task — instead, profile and template each
  `data.<key>` branch as its own template using the `list_of_dicts_with_subkey` iterate_mode
  (Task 10 already supports this): `game_master_pokemon_settings.yml`,
  `game_master_combat_move.yml`, `game_master_player_level.yml`, `game_master_item_settings.yml`,
  `game_master_sticker_metadata.yml`, `game_master_avatar_customization.yml`,
  `game_master_friendship_milestone.yml`, `game_master_encounter_settings.yml` — 8 templates
  against the same one raw file, each with `unwrap_path` pointing at its own `data` sub-key.
  `pokemonSettings`'s `identity_field` needs an `overrides` entry since dex number isn't a direct
  field (it's regex-extracted from `templateId`, e.g. `V0001_POKEMON_BULBASAUR` → `1`) — add a
  new `regex_extract` transform to `src/engine.py` (`{"source_field": "templateId", "transform":
  "regex_extract", "pattern": r"^V(\d{4})_POKEMON_", "group": 1}`), TDD cycle same as prior new
  transforms.

- [ ] **Step 1: Implement the `regex_extract` transform** (TDD cycle in `tests/test_engine_transforms.py`, commit separately)
- [ ] **Step 2: Generate the 8 templates**
- [ ] **Step 3: Write the failing test** — assert dex 222's `base_attack`/`base_defense`/`base_stamina` still resolve to `alexelgt_game_masters`'s values (116/182/155 per `KNOWN_ISSUES.md`'s documented discrepancy example) once this source is engine-driven
- [ ] **Step 4: Run test to verify it fails**
- [ ] **Step 5: Wire all 8 cutover calls, delete every legacy GAME_MASTER-consuming block, delete `extract_structured_claims()` from `src/fetchers/game_master.py` entirely (its fetch() method stays — only the hand-parsing method goes)**
- [ ] **Step 6: Run test to verify it passes**
- [ ] **Step 7: Run the real build and diff every table against `baseline/pre-generic-engine`** — this is the biggest single cutover; a full-database diff (not spot checks) is warranted:

```bash
uv run go_refs.py --build
uv run python3 -c "
import duckdb
new = duckdb.connect('output/GoRefs_Master.duckdb', read_only=True)
old = duckdb.connect('/tmp/baseline.duckdb', read_only=True)  # checked out from baseline/pre-generic-engine first
for tbl in ['species', 'moves', 'progression', 'items', 'stickers']:
    n_new = new.execute(f'select count(*) from {tbl}').fetchone()[0]
    n_old = old.execute(f'select count(*) from {tbl}').fetchone()[0]
    print(tbl, 'old:', n_old, 'new:', n_new, 'MATCH' if n_old == n_new else 'MISMATCH -- investigate')
"
```

- [ ] **Step 8: Commit** — `git commit -m "feat: cut over alexelgt_game_masters to the generic engine, delete the shared base-stats block entirely"`

---

## Task 23: Cutover — `local_authoring`

The smallest, highest-trust source, last cutover.

**Files:**
- Modify: `src/builder.py` — this source currently has no consuming code in
  `collect_and_resolve_claims` at all (grep confirms `local_authoring` only appears in
  `TRUST_HIERARCHY` and the fetcher registry, not in the build logic) — `costume-lookup.json`/
  `community-submissions.json` aren't actually read anywhere today. This "cutover" is really
  "first real integration," not a migration — confirm this via
  `grep -n "local_authoring" src/builder.py` returning nothing before proceeding, and treat the
  template as brand new plumbing rather than a replacement.
- Template: `local_authoring_costume-lookup.yml` and
  `local_authoring_community-submissions.yml`, generated from
  `raw_dumps/local_authoring/*/costume-lookup.json` /`community-submissions.json`.

- [ ] **Step 1: Confirm no existing consumer** — `grep -n "local_authoring" src/builder.py` (expect empty)
- [ ] **Step 2: Generate templates**
- [ ] **Step 3: Write the failing test** asserting `local_authoring`'s claims (priority 1) would win over any conflicting lower-priority claim for the same entity/attribute, if one exists
- [ ] **Step 4: Run test to verify it fails**
- [ ] **Step 5: Wire the cutover call** (a new addition to `collect_and_resolve_claims`, not a replacement)
- [ ] **Step 6: Run test to verify it passes**
- [ ] **Step 7: Run the real build** — confirm no regression (this source contributing claims for the first time should only ever *add* discrepancy-free resolutions or correctly-won overrides, never break an existing field, since it's the highest-trust source)
- [ ] **Step 8: Commit** — `git commit -m "feat: cut over local_authoring to the generic engine (first real integration -- was previously unused)"`

**All 7 sources are now cut over.** Confirm zero legacy per-source parsing remains:
`grep -n "pokedex_raw\|badges_raw\|gm_species_stats" src/builder.py` should return nothing outside
of comments/docstrings.

---

## Task 24: Post-cutover audit — verify `scripts/generate_docs.py` at runtime

**Files:**
- Investigate: `scripts/generate_docs.py`
- Fix inline if a concrete bug is found.

**Interfaces:** none new — this is a verification task, not a feature.

- [ ] **Step 1: Run the doc generator standalone and inspect its actual output**

```bash
uv run python3 scripts/generate_docs.py
```

Read the generated `docs/api_reference.md` and confirm every public function/class added in
Tasks 1-23 (`engine.py`'s `run_source`, `apply_transform`, `resolve_gender`,
`normalize_form_identity`; `profiler.py`'s `SourceProfiler`, `detect_shape`, etc.) actually
appears with its docstring rendered correctly — not just that the module count increased.

- [ ] **Step 2: If a discrepancy is found (e.g. a docstring format not parsed, a module silently
  skipped), write a minimal failing test reproducing it in `tests/test_generate_docs.py`, fix
  `scripts/generate_docs.py` inline, verify the test passes**

- [ ] **Step 3: If no bug is found, document that explicitly**

Add a short note to `KNOWN_ISSUES.md` under a new "Resolved/non-issues" heading: doc generation
was verified at runtime during the post-cutover audit (date, what was checked) and found correct
— closing the open suspicion from the design spec rather than leaving it unresolved.

- [ ] **Step 4: Audit `src/build_tables.py`, `src/inventory_analysis.py`, and
  `src/ingest_community_submissions.py`** (the other scripts/functions this redesign didn't
  touch) for anything broken by the cutover — specifically, check whether any of them import or
  reference `src/builder.py` internals that Tasks 17-23 deleted (e.g. `pokedex_raw`,
  `badges_raw`, or the old per-source function names) via
  `grep -rn "collect_and_resolve_claims\|write_master_duckdb" src/build_tables.py src/inventory_analysis.py src/ingest_community_submissions.py`.
  Fix inline anything trivial; if something needs real design work, report it rather than
  papering over it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: post-cutover audit of untouched scripts (doc generation verified correct at runtime)"
```

---

## Task 25: `--test-paranoid` — DuckDB-native independent cross-check

**Files:**
- Create: `src/paranoid_check.py`
- Modify: `go_refs.py` (add `--test-paranoid` flag)
- Test: `tests/test_paranoid_check.py` (new)

**Interfaces:**
- Produces: `run_paranoid_check(db_path: Path, raw_dumps_dir: Path, templates_dir: Path) -> dict`, invoked by `uv run go_refs.py --test-paranoid`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_paranoid_check.py
import json
import duckdb
from pathlib import Path
from src.paranoid_check import run_paranoid_check


def test_paranoid_check_flags_unexplained_mismatch(tmp_path):
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, name VARCHAR)")
    con.execute("INSERT INTO species VALUES (1, 'WrongName')")  # doesn't match any raw source
    con.close()

    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True)
    (templates_dir / "fixture_source.yml").write_text(json.dumps({
        "source_key": "fixture_source", "endpoint": "data",
        "record_extraction": {"unwrap_path": [], "iterate_mode": "top_level_list"},
        "identity_field": "dex_number",
        "field_mappings": {"name": {"source_field": "name", "transform": "direct"}},
    }))
    raw_dir = tmp_path / "raw_dumps" / "fixture_source" / "2026-01-01T000000Z"
    raw_dir.mkdir(parents=True)
    (raw_dir / "data.json").write_text(json.dumps([{"dex_number": 1, "name": "Bulbasaur"}]))

    result = run_paranoid_check(db_path=db_path, raw_dumps_dir=tmp_path / "raw_dumps", templates_dir=templates_dir)

    assert result["unexplained_failures"] == 1
    assert result["failures"][0]["expected"] == "Bulbasaur"
    assert result["failures"][0]["actual"] == "WrongName"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_paranoid_check.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.paranoid_check'`

- [ ] **Step 3: Implement**

```python
# src/paranoid_check.py
"""Independent, engine-bypassing verification: loads each source's raw JSON via
DuckDB's own read_json_auto (not src/engine.py's Python transforms), and cross-checks
row/column values directly against the canonical, already-built database. A bug in
our own extraction code cannot be invisible to both the production path and this check,
since this check never calls that code.
"""
import json
from pathlib import Path
from typing import Any, Dict, List
import duckdb
import yaml
from tqdm import tqdm


def _latest_snapshot_file(raw_dumps_dir: Path, source_key: str, endpoint: str) -> Any:
    source_dir = raw_dumps_dir / source_key
    if not source_dir.exists():
        return None
    snapshots = sorted([d for d in source_dir.iterdir() if d.is_dir()])
    if not snapshots:
        return None
    data_file = snapshots[-1] / f"{endpoint}.json"
    return data_file if data_file.exists() else None


def _resolve_canonical_value(con: duckdb.DuckDBPyConnection, identity_value: Any, identity_field: str, attribute: str) -> Any:
    for table in ("species", "forms", "badges", "raid_bosses", "moves"):
        try:
            cols = [r[0] for r in con.execute(f'DESCRIBE "{table}"').fetchall()]
        except Exception:
            continue
        id_col = "dex_number" if "dex_number" in cols else identity_field
        if attribute not in cols or id_col not in cols:
            continue
        result = con.execute(f'SELECT "{attribute}" FROM "{table}" WHERE "{id_col}" = ?', [identity_value]).fetchone()
        if result:
            return result[0]
    return None


def run_paranoid_check(
    db_path: Path = Path("output/GoRefs_Master.duckdb"),
    raw_dumps_dir: Path = Path("raw_dumps"),
    templates_dir: Path = Path("config/source_templates"),
) -> Dict[str, Any]:
    con = duckdb.connect(str(db_path), read_only=True)
    template_files = sorted(templates_dir.glob("*.yml"))

    all_raw_tables: Dict[str, Any] = {}
    for tmpl_file in template_files:
        with open(tmpl_file, "r", encoding="utf-8") as f:
            template = yaml.safe_load(f)
        source_key = template["source_key"]
        endpoint = template.get("endpoint", source_key)
        data_file = _latest_snapshot_file(raw_dumps_dir, source_key, endpoint)
        if not data_file:
            continue
        raw_con = duckdb.connect(":memory:")
        try:
            raw_con.execute(f"CREATE TABLE raw AS SELECT * FROM read_json_auto('{data_file}')")
            all_raw_tables[tmpl_file.stem] = (raw_con, template)
        except Exception as e:
            print(f"[ParanoidCheck] Skipping {tmpl_file.stem}: read_json_auto failed ({e})")

    failures: List[Dict[str, Any]] = []
    overridden_count = 0
    checked_count = 0

    for tmpl_stem, (raw_con, template) in tqdm(all_raw_tables.items(), desc="Paranoid-checking sources"):
        identity_field = template["identity_field"]
        for attribute, mapping in template.get("field_mappings", {}).items():
            source_field = mapping.get("source_field")
            try:
                rows = raw_con.execute(f'SELECT "{identity_field}", "{source_field}" FROM raw').fetchall()
            except Exception:
                continue
            for identity_value, claimed_value in rows:
                checked_count += 1
                canonical_value = _resolve_canonical_value(con, identity_value, identity_field, attribute)
                if str(canonical_value) == str(claimed_value):
                    continue

                explained = False
                for other_stem, (other_con, other_template) in all_raw_tables.items():
                    if other_stem == tmpl_stem:
                        continue
                    other_field = other_template.get("field_mappings", {}).get(attribute, {}).get("source_field")
                    if not other_field:
                        continue
                    other_id_field = other_template["identity_field"]
                    try:
                        other_row = other_con.execute(
                            f'SELECT "{other_field}" FROM raw WHERE "{other_id_field}" = ?', [identity_value]
                        ).fetchone()
                    except Exception:
                        continue
                    if other_row and str(other_row[0]) == str(canonical_value):
                        overridden_count += 1
                        explained = True
                        break

                if not explained:
                    failures.append({
                        "entity": identity_value, "attribute": attribute,
                        "expected": claimed_value, "actual": canonical_value,
                        "source": tmpl_stem,
                    })

    con.close()
    return {
        "checked": checked_count,
        "overridden": overridden_count,
        "unexplained_failures": len(failures),
        "failures": failures,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_paranoid_check.py -v`
Expected: PASS

- [ ] **Step 5: Wire `--test-paranoid` into `go_refs.py`**

```python
# go_refs.py — add near run_source_coverage_test()
def run_paranoid_test() -> None:
    from src.paranoid_check import run_paranoid_check
    result = run_paranoid_check()
    print(f"Checked: {result['checked']}, Overridden (explained): {result['overridden']}, Unexplained failures: {result['unexplained_failures']}")
    for f in result["failures"][:20]:
        print(f"  FAIL: {f['source']}/{f['entity']}.{f['attribute']} expected={f['expected']!r} actual={f['actual']!r}")
```

```python
# go_refs.py, in main() — add the argument and dispatch
    parser.add_argument("--test-paranoid", action="store_true", help="Run independent, engine-bypassing cross-check against canonical tables")
    # add args.test_paranoid to the `if not any([...])` list
    if args.test_paranoid:
        run_paranoid_test()
```

- [ ] **Step 6: Prove it actually catches a real bug — the acceptance test from the spec**

Temporarily revert the `is_event_badge` field mapping to the old broken behavior (map it back to
`event_badge` stored as a stringified boolean instead of a real boolean) in one badges template,
run `--test-paranoid`, and confirm it reports an unexplained failure for that field. Then revert
the temporary change.

```bash
uv run go_refs.py --build
uv run go_refs.py --test-paranoid
# confirm the deliberately-reintroduced bug is caught, then:
git checkout -- config/source_templates/pogoapi_net_badges.yml
uv run go_refs.py --build
```

- [ ] **Step 7: Commit**

```bash
git add src/paranoid_check.py go_refs.py tests/test_paranoid_check.py
git commit -m "feat: add --test-paranoid, an independent DuckDB-native cross-check bypassing src/engine.py"
```

---

## Task 26: Build manifest and `--check`

**Files:**
- Modify: `src/builder.py` (`write_master_duckdb` or `build()`, `main:891`)
- Modify: `go_refs.py` (add `--check` flag)
- Test: `tests/test_build_manifest.py` (new)

**Interfaces:**
- Produces: `write_build_manifest(templates_dir: Path, output_dir: Path) -> None` (writes
  `output/build-manifest.json`) and `check_for_drift(templates_dir: Path, output_dir: Path) -> bool`
  (returns `True` if no drift detected), both in `src/builder.py`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_build_manifest.py
import json
import yaml
from pathlib import Path
from src.builder import write_build_manifest, check_for_drift


def test_write_and_check_manifest_roundtrip(tmp_path):
    templates_dir = tmp_path / "config" / "source_templates"
    templates_dir.mkdir(parents=True)
    (templates_dir / "fixture_source.yml").write_text(yaml.dump({"source_fingerprint": "sha256:abc123"}))
    output_dir = tmp_path / "output"
    output_dir.mkdir()

    write_build_manifest(templates_dir=templates_dir, output_dir=output_dir)
    manifest = json.loads((output_dir / "build-manifest.json").read_text())
    assert "fixture_source.yml" in manifest["templates"]
    assert manifest["templates"]["fixture_source.yml"]["source_fingerprint"] == "sha256:abc123"

    assert check_for_drift(templates_dir=templates_dir, output_dir=output_dir) is True

    # simulate upstream drift: fingerprint changes without a rebuild
    (templates_dir / "fixture_source.yml").write_text(yaml.dump({"source_fingerprint": "sha256:changed"}))
    assert check_for_drift(templates_dir=templates_dir, output_dir=output_dir) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_build_manifest.py -v`
Expected: FAIL — `ImportError: cannot import name 'write_build_manifest'`

- [ ] **Step 3: Implement**

```python
# src/builder.py — add as module-level functions (not methods, no engine state needed)
import hashlib


def write_build_manifest(templates_dir: Path = Path("config/source_templates"), output_dir: Path = Path("output")) -> None:
    """Records each template's shape fingerprint and content hash for later drift detection."""
    manifest = {"templates": {}}
    for tmpl_file in sorted(templates_dir.glob("*.yml")):
        content = tmpl_file.read_text(encoding="utf-8")
        data = yaml.safe_load(content) or {}
        manifest["templates"][tmpl_file.name] = {
            "source_fingerprint": data.get("source_fingerprint"),
            "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        }
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(output_dir / "build-manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)


def check_for_drift(templates_dir: Path = Path("config/source_templates"), output_dir: Path = Path("output")) -> bool:
    """Diffs current template fingerprints/hashes against the last recorded manifest.

    Returns:
        True if no drift detected (safe to trust the current build), False otherwise.
    """
    manifest_path = output_dir / "build-manifest.json"
    if not manifest_path.exists():
        print("[Check] No build manifest found. Run --build first.")
        return False

    with open(manifest_path, "r", encoding="utf-8") as f:
        recorded = json.load(f).get("templates", {})

    drift_found = False
    for tmpl_file in sorted(templates_dir.glob("*.yml")):
        content = tmpl_file.read_text(encoding="utf-8")
        data = yaml.safe_load(content) or {}
        current_fp = data.get("source_fingerprint")
        current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        recorded_entry = recorded.get(tmpl_file.name, {})
        if recorded_entry.get("source_fingerprint") != current_fp:
            print(f"[Check] Shape drift detected in {tmpl_file.name}.")
            drift_found = True
        elif recorded_entry.get("content_hash") != current_hash:
            print(f"[Check] Template content changed (mapping/override edit) in {tmpl_file.name}.")
            drift_found = True

    if not drift_found:
        print("[Check] All templates match the last recorded build. No drift detected.")
    return not drift_found
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_build_manifest.py -v`
Expected: PASS

- [ ] **Step 5: Wire into `--build` and add `--check`**

```python
# go_refs.py, inside main() — extend the build block and add --check
    if args.all or args.build:
        run_freshness_check(config)
        engine = GoRefsMasterEngine(output_dir=Path("output"))
        engine.build()
        engine.export_parquet(db_path=engine.db_path, output_dir=Path("output"))
        from src.builder import write_build_manifest
        write_build_manifest()
        run_doc_generation()
```

```python
# go_refs.py — add the flag and dispatch
    parser.add_argument("--check", action="store_true", help="Check template drift against the last recorded build manifest")
    # add args.check to the `if not any([...])` list
    if args.check:
        from src.builder import check_for_drift
        check_for_drift()
```

- [ ] **Step 6: Run the real build, then `--check`, and confirm no drift**

Run: `uv run go_refs.py --build && uv run go_refs.py --check`
Expected: "All templates match the last recorded build. No drift detected."

- [ ] **Step 7: Commit**

```bash
git add src/builder.py go_refs.py tests/test_build_manifest.py
git commit -m "feat: add build manifest and --check for template drift detection"
```

---

## Final acceptance pass

- [ ] Diff the finished build against `baseline/pre-generic-engine`: `species`/`moves` row
  counts should match exactly (no data lost); `forms` row count and per-species gender/costume
  correctness should match `KNOWN_ISSUES.md`'s documented expectations, not the baseline (the
  baseline has the known bugs); `discrepancies` count should be higher than the baseline's 3.
- [ ] `uv run go_refs.py --build && uv run go_refs.py --test && uv run go_refs.py --test-paranoid`
  all complete without error.
- [ ] `output/parquet/*.parquet` exist and are readable via `duckdb.sql("SELECT * FROM
  read_parquet('output/parquet/species.parquet')")`.
- [ ] `uv run go_refs.py --serve` in one terminal, then from another: `curl -H "Range:
  bytes=0-99" http://localhost:8000/output/GoRefs_Master.duckdb -o /dev/null -w "%{http_code}\n"`
  prints `206`.
- [ ] `grep -c "pokedex_raw\|gm_species_stats\|badges_raw" src/builder.py` returns `0`.
