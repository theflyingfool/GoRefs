# Pokémon GO Reference Knowledge Base (`go_refs`) - Complete API Reference

Auto-generated code documentation parsed from Python docstrings.

## Module `go_refs.py`

```text
Master CLI & Pipeline Runner for Pokémon GO Unified Reference Knowledge Base (`go_refs`).

Provides streamlined commands to fetch raw snapshots, execute the GoRefsMasterEngine build
pipeline producing `output/GoRefs_Master.duckdb`, and host the local web explorer server.
```

### Classes

#### `class GoRefsHTTPRequestHandler(http.server.SimpleHTTPRequestHandler)`
*Custom HTTP request handler for the GoRefs web application.*

Custom HTTP request handler for the GoRefs web application.

Routes root requests and asset paths to the `web/` directory, serves the single
master database from `output/GoRefs_Master.duckdb`, auto-generated API docs, and
Parquet exports -- with real HTTP Range support so remote clients (DuckDB's
httpfs, DuckDB-WASM reading Parquet) can read partial content without
downloading the whole file.

**Methods:**

- `do_GET(self) -> None`
- `_serve_range(self, range_header: str) -> None`
  - Serves a single-range byte request as 206 Partial Content.
- `end_headers(self) -> None`
- `do_OPTIONS(self) -> None`

### Functions

#### `def load_config(config_path: Path = Path('config/sources.yml')) -> dict`

*Loads and parses the YAML configuration file defining upstream data sources.*

Loads and parses the YAML configuration file defining upstream data sources.

Args:
    config_path (Path): Path to the YAML configuration file. Default is config/sources.yml.

Returns:
    dict: Parsed configuration dictionary containing source definitions.

Raises:
    FileNotFoundError: If the specified configuration file does not exist.

#### `def run_fetching(config: dict, force: bool = False) -> None`

*Executes raw snapshot fetching across all enabled upstream data sources.*

Executes raw snapshot fetching across all enabled upstream data sources.

Iterates over registered fetcher classes, downloads immutable timestamped snapshots,
and caches visual sprite assets into `raw_dumps/`.

Args:
    config (dict): Configuration dictionary containing source definitions.
    force (bool): If True, re-fetches snapshots regardless of existing local caches.

#### `def run_freshness_check(config: dict) -> None`

*Runs each enabled source's pre-flight freshness check without a full fetch.*

Runs each enabled source's pre-flight freshness check without a full fetch.

Unlike run_fetching(), this always executes as part of --build, regardless of
whether --fetch was also passed -- so a build never silently uses raw data that's
gone stale against its remote source without at least checking.

#### `def run_doc_generation() -> None`

*Executes automated docstring documentation generator scripts/generate_docs.py.*

Executes automated docstring documentation generator scripts/generate_docs.py.

#### `def run_deep_dive(target: str = 'all') -> None`

*Runs the schema profiler (src.profiler.SourceProfiler) to generate or*

Runs the schema profiler (src.profiler.SourceProfiler) to generate or
update config/source_templates/*.yml from the latest raw snapshot(s).

Args:
    target: "all" to profile every source in config/sources.yml, or a
        single source_key to profile just that source (endpoint name is
        assumed to match the source_key).

#### `def run_source_coverage_test() -> None`

*Executes the claims-ledger replay coverage suite against the last built*

Executes the claims-ledger replay coverage suite against the last built
output/GoRefs_Master.duckdb.

#### `def run_paranoid_check_cli(source: 'Optional[str]' = None) -> None`

*CLI entrypoint for --test-paranoid. Writes output/paranoid_check_report.md*

CLI entrypoint for --test-paranoid. Writes output/paranoid_check_report.md
and prints a one-line summary per source.

#### `def run_web_server(port: int = 8000) -> None`

*Starts the local web server hosting the single-page explorer UI and WASM SQL Console.*

Starts the local web server hosting the single-page explorer UI and WASM SQL Console.

Serves static assets from `web/`, API documentation from `docs/`, and the master DuckDB database.

Args:
    port (int): Port number on which to bind the HTTP server. Default is 8000.

#### `def main() -> None`

*Master CLI entrypoint for Pokémon GO Reference Knowledge Base (`go_refs.py`).*

Master CLI entrypoint for Pokémon GO Reference Knowledge Base (`go_refs.py`).

Parses command-line arguments (--fetch, --build, --serve, --docs, --all, --port, --config)
and dispatches pipeline stages sequentially.

---

## Module `scripts/user_source_coverage_test.py`

```text
Ledger-replay coverage suite for GoRefs.

Reads the _claims_ledger table the last --build produced, re-derives each
(entity_id, attribute)'s expected winner using the same trust-tier priority
the resolver used, and asserts the canonical table actually holds that value.
Does not independently re-parse raw JSON -- that duplication is what degraded
the previous version of this suite into a tautology.

Usage:
    PYTHONPATH=. uv run python scripts/user_source_coverage_test.py
```

### Classes

#### `class _TypesListMatch`
*Sentinel canonical value for primary_type_raw/secondary_type_raw claims:*

Sentinel canonical value for primary_type_raw/secondary_type_raw claims:
the canonical `types` column is a list combining both claims, not a single
scalar equal to either one on its own. Wraps that list so comparisons can
check membership (after applying the same prefix-strip + capitalize
transform builder.py applies) instead of doing whole-value equality.

**Methods:**

- `__init__(self, types_list: Any)`

#### `class LedgerReplayTester`

**Methods:**

- `__init__(self, db_path: Path = Path('output/GoRefs_Master.duckdb'))`
- `_find_canonical_value(self, entity_id: str, attribute: str) -> Any`
  - Best-effort lookup: entity_id encodes the domain as its prefix
- `staticmethod` `_values_match(claim_value: Any, canonical_value: Any) -> bool`
  - Compares a raw claim value to a resolved canonical value.
- `staticmethod` `_normalize(value: Any) -> Any`
  - Coerces numpy/pandas array-likes (e.g. a VARCHAR[] column value) into
- `_load(self, table: str) -> pd.DataFrame`
- `run_suite(self) -> Dict[str, Any]`
- `close(self) -> None`

---

## Module `src/__init__.py`

---

## Module `src/build_tables.py`

```text
DuckDB table building and dynamic schema exploration engine for Pokémon GO reference data.

Provides utilities for exploding raw client data snapshots, building exploration tables,
tracking schema inventories, and dynamically registering custom domain tables into the
unified Master DuckDB database (`output/GoRefs_Master.duckdb`).
```

### Functions

#### `def sanitize_table_name(name: str) -> str`

*Sanitizes an arbitrary string into a valid DuckDB table name.*

Sanitizes an arbitrary string into a valid DuckDB table name.

Replaces non-alphanumeric characters with underscores, merges consecutive underscores,
strips leading/trailing underscores, and converts the string to lowercase.

Args:
    name: The raw table name or file stem to sanitize.

Returns:
    A sanitized, lower-cased SQL-safe table name string.

Example:
    >>> sanitize_table_name("POGO-API.Net-v1/CP-Multiplier!")
    'pogo_api_net_v1_cp_multiplier'

#### `def build_exploration_tables(db_file: str = 'output/GoRefs_Master.duckdb', raw_dumps_dir: Path = Path('raw_dumps')) -> int`

*Dynamically builds raw exploration tables across all upstream data sources into DuckDB.*

Dynamically builds raw exploration tables across all upstream data sources into DuckDB.

Scans the `raw_dumps/` directory for all source folders (e.g., `alexelgt_game_masters`,
`pokemon_go_api`, `pogoapi_net`, `pvpoke`, `pokeapi`, `rplus_shiny`, `local_authoring`, or any
new raw directories). Explodes complex nested JSON payloads (such as `GAME_MASTER.json` into
`gm_*` tables) and loads flat raw JSON files into source-prefixed tables.

Args:
    db_file: Path to the target DuckDB database file. Defaults to
        `output/GoRefs_Master.duckdb`.
    raw_dumps_dir: Path to the root raw dumps directory containing source folders.
        Defaults to `Path("raw_dumps")`.

Returns:
    Total number of raw exploration tables created or updated in the database.

Raises:
    FileNotFoundError: If `raw_dumps_dir` does not exist.

#### `def register_custom_domain_table(db_file: Union[str, Path] = 'output/GoRefs_Master.duckdb', table_name: str = '', data: Union[pd.DataFrame, List[Dict[str, Any]], str] = None, source_key: str = 'custom_domain') -> bool`

*Dynamically registers a custom domain table or new source dataset into DuckDB.*

Dynamically registers a custom domain table or new source dataset into DuckDB.

Ensures extension support without breaking or altering pre-existing canonical
or raw schemas. Updates `schema_inventory` automatically.

Args:
    db_file: Path to the target DuckDB database file. Defaults to
        `output/GoRefs_Master.duckdb`.
    table_name: Raw or formatted table name to create/replace in the database.
    data: Data to ingest. Can be a `pandas.DataFrame`, a list of dictionaries,
        or a SQL SELECT statement string.
    source_key: Optional identifier tag for the source registering this table.
        Defaults to `"custom_domain"`.

Returns:
    True if registration succeeded, False otherwise.

Raises:
    ValueError: If table_name or data is invalid.

---

## Module `src/builder.py`

```text
Master build engine and DuckDB database creator for Pokémon GO reference knowledge base.

Orchestrates raw dataset ingestion across 7 data sources, applies trust hierarchy precedence,
resolves claims, logs field discrepancies, compares snapshot changes in a change history engine,
and generates the single Master DuckDB database (`output/GoRefs_Master.duckdb`) containing ONLY
clean normalized domain tables with ZERO source-prefixed table names and ZERO data dropped.
```

### Classes

#### `class GoRefsMasterEngine`
*Unified Master Build Engine for the Pokémon GO Reference Knowledge Base.*

Unified Master Build Engine for the Pokémon GO Reference Knowledge Base.

Orchestrates the ingestion of 7 data sources, resolves canonical attributes via source
precedence (1 > 2 > 3 > 4 > 5 > 6 > 7), logs field discrepancies, tracks snapshot diffs in
`change_history`, and writes to `output/GoRefs_Master.duckdb` with clean normalized tables.

**Methods:**

- `__init__(self, raw_dumps_dir: Path = Path('raw_dumps'), output_dir: Path = Path('output'), db_path: Optional[Path] = None)`
  - Initializes the GoRefsMasterEngine with workspace directories and source priorities.
- `emit_claim(self, entity_id: str, attribute: str, source: str, value: Any) -> None`
  - Appends one claim to the in-memory claims ledger, if the value is present.
- `register_custom_domain_table(self, table_name: str, data: Union[pd.DataFrame, List[Dict[str, Any]], str], source_key: str = 'custom_domain') -> bool`
  - Dynamically registers a custom domain table into output/GoRefs_Master.duckdb.
- `resolve_attribute_claim(self, entity_id: str, attribute: str, claims: List[Dict[str, Any]]) -> Tuple[Any, str]`
  - Resolves a canonical attribute value from competing source claims.
- `resolve_all_claims(self) -> Dict[Tuple[str, str], Any]`
  - Groups the claims ledger by (entity_id, attribute) and resolves each group.
- `collect_and_resolve_claims(self) -> Dict[str, Any]`
  - Loads raw snapshots across all 7 sources and builds deduplicated canonical datasets.
- `compute_and_record_diffs(self, con: duckdb.DuckDBPyConnection, canonical_data: Dict[str, Any]) -> int`
  - Snapshot Change / Diff Engine: Compares new canonical claims against Master DB state.
- `write_master_duckdb(self, canonical_data: Dict[str, Any]) -> int`
  - Writes canonical domain datasets into `output/GoRefs_Master.duckdb`.
- `build_all(self) -> Dict[str, int]`
  - Runs the complete GoRefs build pipeline.
- `export_parquet(self, db_path: Path, output_dir: Path) -> List[str]`
  - Exports every canonical (non-internal) table to Parquet for remote/WASM consumption.
- `build(self) -> Dict[str, int]`
  - Alias for build_all to run the full build pipeline.

### Functions

#### `def update_readme_counts(counts: Dict[str, int], readme_path: Path = Path('README.md')) -> None`

*Dynamically updates domain statistics and table counts in README.md when building.*

Dynamically updates domain statistics and table counts in README.md when building.

Args:
    counts: Dictionary containing count statistics per domain.
    readme_path: Path to README.md file. Defaults to `Path("README.md")`.

#### `def build_canonical_dataset(raw_dumps_dir: Path = Path('raw_dumps'), output_dir: Path = Path('output'))`

*Wrapper function entry point for building the Master dataset.*

Wrapper function entry point for building the Master dataset.

Args:
    raw_dumps_dir: Raw dumps directory path.
    output_dir: Output directory path.

---

## Module `src/engine.py`

```text
Generic, template-driven extraction engine for GoRefs sources.

The only code path that reads a config/source_templates/*.yml file at build
time. Everything here is source-agnostic -- source-specific knowledge lives
entirely in the template, not in this module.
```

### Functions

#### `def unwrap_to_records(payload: Any, unwrap_path: List[str], iterate_mode: str, key_becomes_field: Optional[str] = None, dict_key_field: str = 'key', dict_value_field: str = 'value') -> List[Dict[str, Any]]`

*Descends through unwrap_path, then yields records per iterate_mode.*

Descends through unwrap_path, then yields records per iterate_mode.

Args:
    payload: The raw, already-json.load()-ed source payload.
    unwrap_path: Dict keys to descend through before iterating, e.g. ["currentList"].
    iterate_mode: One of "top_level_list", "dict_of_lists",
        "list_of_dicts_with_subkey", "single_object", "dict_of_scalars".
    key_becomes_field: For "dict_of_lists", the dict key at the final unwrap
        level is injected onto each of its records under this field name
        (e.g. a raid tier name becomes each boss record's "tier" field).
    dict_key_field: For "dict_of_scalars" only -- the field name each dict
        key is injected under in its one-field record (e.g. "costume_token").
        Defaults to "key" so a minimal template still works.
    dict_value_field: For "dict_of_scalars" only -- the field name each
        dict's scalar value is injected under (e.g. "display_name").
        Defaults to "value".

Returns:
    List of record dicts.

#### `def _get_nested(record: Dict[str, Any], dotted_path: str) -> Any`

*Navigate through nested dict using dot-separated path.*

Navigate through nested dict using dot-separated path.

Args:
    record: Dict to navigate through
    dotted_path: Dot-separated path, e.g. "names.English"

Returns:
    The value at the path, or None if path doesn't exist.

#### `def apply_transform(record: Dict[str, Any], mapping: Dict[str, Any]) -> Any`

*Applies one template field_mappings entry's transform to a record.*

Applies one template field_mappings entry's transform to a record.

Args:
    record: A single extracted record (from unwrap_to_records).
    mapping: One field_mappings value, e.g.
        {"source_field": "names.English", "transform": "nested_path", "fallback_field": "id"}.

Returns:
    The transformed value, or None if the source field is absent.

#### `def resolve_gender(record: Dict[str, Any], gender_signals: List[Dict[str, Any]], context: Optional[Dict[str, Any]] = None) -> str`

*Evaluates every gender signal against a record; any one firing means "female".*

Evaluates every gender signal against a record; any one firing means "female".

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

#### `def normalize_form_identity(species_dex: int, species_slug: str, form_name: Optional[str], costume_name: Optional[str], gender: str) -> tuple`

*Builds a normalized identity tuple for deduplicating form records.*

Builds a normalized identity tuple for deduplicating form records.

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

#### `def _slugify_name(name: Optional[str]) -> str`

*Lowercases and hyphenates a display name for identity-stripping purposes only.*

Lowercases and hyphenates a display name for identity-stripping purposes only.

Not a display slug (that's builder.py's job) -- just enough normalization for
normalize_form_identity() to reliably strip a repeated species-name token from
a form/costume string, regardless of exact punctuation/casing.

#### `def _build_form_entity_id(entity_prefix: str, raw_id: Any, norm_identity: tuple) -> str`

*Builds a deterministic form entity_id from a normalized identity tuple.*

Builds a deterministic form entity_id from a normalized identity tuple.

Two different upstream fields describing the SAME real-world variant (e.g.
assetForms's unreliable `isFemale` boolean vs. regionForms's `..._FEMALE` key
text) normalize to the same tuple via normalize_form_identity(), and therefore
land on this same entity_id -- this is what makes the dedup automatic rather
than requiring an explicit dedup pass over raw strings.

#### `def apply_sub_records(parent_record: Dict[str, Any], parent_raw_id: Any, species_dex: int, species_name: Optional[str], entity_prefix: str, sub_record_configs: List[Dict[str, Any]], source: str, priority: int) -> List[Dict[str, Any]]`

*Extracts claims from a parent record's nested sub-lists (e.g. assetForms,*

Extracts claims from a parent record's nested sub-lists (e.g. assetForms,
regionForms), one additional claim-set per sub-record.

This is the fix for a source describing the same real-world form/gender/costume
variant inconsistently across two different nested fields (pokemon_go_api's
Frillish: once via `regionForms["FRILLISH_FEMALE"]`, once via `assetForms`'s
`{"form": "FEMALE", "isFemale": false}` -- isFemale is false on the entry that
IS the female variant). Every sub-record's identity is normalized via
normalize_form_identity() before being turned into an entity_id, so both
representations collapse onto the same entity rather than producing two
separate, inconsistently-tagged rows.

Args:
    parent_record: The top-level extracted record (e.g. one pokedex species).
    parent_raw_id: The parent's identity_field value (e.g. dexNr).
    species_dex: Numeric species dex number (passed separately from
        parent_raw_id since callers may one day key parents by something else).
    species_name: The parent's own display name, used only to strip a
        repeated species-name token out of form/costume text.
    entity_prefix: Same entity_id_prefix run_source() resolved for the parent.
    sub_record_configs: The template's `sub_records` list.
    source: Actual source key (for claim provenance).
    priority: Trust-hierarchy priority for this source.

Returns:
    List of claim dicts, same shape as run_source()'s top-level claims.

#### `def _get_latest_snapshot_dir(source_dir: Path) -> Optional[Path]`

*Returns the lexicographically-latest timestamped snapshot subdirectory, if any.*

Returns the lexicographically-latest timestamped snapshot subdirectory, if any.

#### `def _load_template_and_records(source_key: str, raw_dumps_dir: Path, templates_dir: Path) -> Optional[Dict[str, Any]]`

*Shared loader for run_source() and extract_transformed_records(): reads a*

Shared loader for run_source() and extract_transformed_records(): reads a
template, resolves its latest raw snapshot, and extracts records via
unwrap_to_records(). These two functions are the only code that reads
config/source_templates/*.yml -- everything else in this module operates on
already-extracted records or claims, and no other module reads templates at all.

Returns:
    None if the template or its raw snapshot is missing, else a dict with
    keys: template, records, actual_source_key, field_mappings, gender_signals,
    identity_field, priority, snapshot_dir.

#### `def extract_transformed_records(source_key: str, raw_dumps_dir: Path = Path('raw_dumps'), templates_dir: Path = Path('config/source_templates')) -> List[Dict[str, Any]]`

*Extracts one plain, field_mappings-transformed dict per record -- no entity_id,*

Extracts one plain, field_mappings-transformed dict per record -- no entity_id,
no claims ledger, no priority-based resolution.

For single-source domains with no cross-source arbitration (e.g. pokemon_go_api's
raid_bosses/max_battles/quests, whose only source is pokemon_go_api itself): there
is nothing to resolve claims AGAINST, so routing these through run_source()'s
entity_id/claims/ledger machinery buys nothing and actively loses information --
that machinery builds one entity_id per identity_field value, which collides for
domains needing a composite key run_source() cannot express (e.g. a raid boss's
real identity is (tier, id), not id alone -- two different raid tiers can feature
the same Pokemon id). Callers needing a composite key should build it themselves
from whatever field_mappings captured (e.g. a `key_becomes_field` value) plus this
function's returned dicts, entirely in caller-owned code -- no ledger involved.

Args:
    source_key: Template name (without .yml), same convention as run_source().
    raw_dumps_dir: Base directory containing raw_dumps/<source>/<timestamp>/*.json.
    templates_dir: Base directory containing config/source_templates/*.yml.

Returns:
    List of plain dicts: {attribute: transformed_value, ...} per extracted record,
    plus a "gender" key when the template declares gender_signals. Records whose
    every field_mappings value transforms to None still appear (as an empty dict),
    since there's no identity_field requirement to filter on unlike run_source().

#### `def run_source(source_key: str, raw_dumps_dir: Path = Path('raw_dumps'), templates_dir: Path = Path('config/source_templates'), parsed_dumps_dir: Optional[Path] = None) -> List[Dict[str, Any]]`

*Extracts claims from a source's latest raw snapshot, driven entirely by its template.*

Extracts claims from a source's latest raw snapshot, driven entirely by its template.

See _load_template_and_records()'s docstring for the "only two functions that read
templates" note. This function never writes to canonical tables -- callers
(GoRefsMasterEngine, --test-paranoid) are responsible for feeding the returned
claims into the ledger/resolver.

Args:
    source_key: e.g. "pokemon_go_api". Looks for a template named exactly
        "{source_key}.yml", or, for multi-endpoint sources, the caller should pass
        the specific "{source_key}_{endpoint}.yml" template name as source_key.
    raw_dumps_dir: Base directory containing raw_dumps/<source>/<timestamp>/*.json.
    templates_dir: Base directory containing config/source_templates/*.yml.

Returns:
    List of claim dicts: {"entity_id", "attribute", "source", "value", "priority"}.

---

## Module `src/fetchers/__init__.py`

---

## Module `src/fetchers/base.py`

```text
Base fetcher module for Pokémon GO reference data source fetchers.

Defines the abstract `BaseFetcher` base class and `FetcherRegistry` class for registering
and executing upstream data source fetchers with pre-flight check support, snapshot caching,
and raw payload storage.
```

### Classes

#### `class BaseFetcher`
*Abstract Base Fetcher for all Pokémon GO reference data sources.*

Abstract Base Fetcher for all Pokémon GO reference data sources.

Handles timestamped snapshot storage, pre-flight commit/ETag checks, raw data loading,
and local snapshot deduplication.

**Methods:**

- `__init__(self, source_key: str, config: Dict[str, Any], base_dump_dir: Path = Path('raw_dumps'))`
  - Initializes the BaseFetcher with source configuration and dump directory.
- `create_snapshot_dir(self) -> Path`
  - Creates a timestamped snapshot directory (e.g. raw_dumps/pogoapi_net/2026-07-29T185300Z).
- `get_latest_snapshot_dir(self, exclude_dir: Optional[Path] = None) -> Optional[Path]`
  - Returns the path to the most recent timestamped snapshot directory.
- `get_remote_head_meta(self, url: str) -> Dict[str, str]`
  - Performs a lightweight HTTP HEAD request to fetch remote ETag or Last-Modified header.
- `is_remote_unchanged(self, url: str, force: bool = False) -> Optional[Path]`
  - Pre-flight check to determine if the remote resource is unchanged.
- `save_meta(self, snapshot_dir: Path, etag: Optional[str] = None) -> None`
  - Saves metadata (etag, timestamp, source key) to the snapshot directory.
- `save_raw(self, snapshot_dir: Path, name: str, data: Any, is_json: bool = True) -> Path`
  - Saves raw fetched data to the snapshot directory.
- `compute_directory_hash(self, target_dir: Path) -> str`
  - Computes a unified SHA256 hash across all content files in a snapshot directory.
- `finalize_snapshot(self, new_snapshot_dir: Path, etag: Optional[str] = None, force: bool = False) -> Path`
  - Finalizes a snapshot directory and deduplicates content against previous snapshot.
- `load_latest_raw(self, name: str) -> Optional[Any]`
  - Loads raw data from the latest saved snapshot directory for offline processing.
- `fetch(self, force: bool = False) -> Path`
  - Abstract fetch method to be implemented by subclass fetchers.

#### `class FetcherRegistry`
*Global registry mapping data source keys to BaseFetcher subclass implementations.*

Global registry mapping data source keys to BaseFetcher subclass implementations.

**Methods:**

- `classmethod` `register(cls, source_key: str)`
  - Decorator to register a BaseFetcher subclass under a source key.
- `classmethod` `get_fetcher_class(cls, source_key: str) -> Optional[Type[BaseFetcher]]`
  - Retrieves a registered BaseFetcher class by its source key.
- `classmethod` `list_registered(cls) -> Dict[str, Type[BaseFetcher]]`
  - Returns a copy of all registered fetcher classes mapped by source key.

---

## Module `src/fetchers/game_master.py`

```text
Fetcher module for raw Niantic client GAME_MASTER.json dumps.

Fetches latest `GAME_MASTER.json` dumps from the `alexelgt/game_masters` repository. Structured
extraction (species stats, combat moves, CP multipliers, items, stickers, avatar items, friendship
milestones, and the raw template archive) is no longer done here -- see the game_master_*.yml
templates under config/source_templates/ and src/builder.py's collect_and_resolve_claims() (Task
22 cut this fetcher's former extract_structured_claims() hand-parser over to the generic
template-driven engine; only raw snapshot retrieval remains fetcher-owned).
```

### Classes

#### `class GameMasterFetcher(BaseFetcher)`
*Fetcher for raw Niantic client GAME_MASTER.json via alexelgt/game_masters repository.*

Fetcher for raw Niantic client GAME_MASTER.json via alexelgt/game_masters repository.

**Methods:**

- `fetch(self, force: bool = False) -> Path`
  - Fetches raw `GAME_MASTER.json` payload from the configured remote URL.

---

## Module `src/fetchers/local_authoring.py`

```text
Fetcher/archiver module for in-repo local authoring overrides.
```

### Classes

#### `class LocalAuthoringFetcher(BaseFetcher)`
*Fetcher/archiver for local hand-maintained authoring spreadsheets and costume lookups.*

Fetcher/archiver for local hand-maintained authoring spreadsheets and costume lookups.

**Methods:**

- `fetch(self, force: bool = False) -> Path`
  - Archives configured local authoring JSON files into a timestamped snapshot.

---

## Module `src/fetchers/pogoapi_net.py`

```text
Fetcher module for pogoapi.net static endpoints.
```

### Classes

#### `class PogoApiFetcher(BaseFetcher)`
*Fetcher for all static reference endpoints from pogoapi.net.*

Fetcher for all static reference endpoints from pogoapi.net.

**Methods:**

- `fetch(self, force: bool = False) -> Path`
  - Fetches all configured static reference JSON endpoints from pogoapi.net.

---

## Module `src/fetchers/pokeapi.py`

```text
Fetcher module for pokeapi.co endpoints.
```

### Classes

#### `class PokeApiFetcher(BaseFetcher)`
*Fetcher for base taxonomy endpoints from pokeapi.co.*

Fetcher for base taxonomy endpoints from pokeapi.co.

**Methods:**

- `fetch(self, force: bool = False) -> Path`
  - Fetches species, pokemon, type, and move limit endpoints from pokeapi.co.

---

## Module `src/fetchers/pokemon_go_api.py`

```text
Fetcher module for pokemon-go-api data endpoints and sprite asset icons.
```

### Classes

#### `class PokemonGoApiFetcher(BaseFetcher)`
*Fetcher for pokemon-go-api endpoints and sprite icon assets.*

Fetcher for pokemon-go-api endpoints and sprite icon assets.

**Methods:**

- `fetch(self, force: bool = False) -> Path`
  - Fetches pokedex, raidboss, maxbattles, quests, and types endpoints.
- `download_assets(self, max_sprites: int = 50) -> Path`
  - Downloads sprite icons from pokemon-go-api/assets into raw_dumps/assets/.

---

## Module `src/fetchers/pvpoke.py`

```text
Fetcher module for PvPoke open-source GameMaster data.
```

### Classes

#### `class PvPokeFetcher(BaseFetcher)`
*Fetcher for PvPoke open-source PvP data master.*

Fetcher for PvPoke open-source PvP data master.

**Methods:**

- `fetch(self, force: bool = False) -> Path`
  - Fetches latest PvPoke gamemaster.json dataset.

---

## Module `src/fetchers/rplus_shiny.py`

```text
Fetcher module for Rplus shiny releases sheet.
```

### Classes

#### `class RplusShinyFetcher(BaseFetcher)`
*Fetcher for per-form shiny release dates spreadsheet via opensheet.*

Fetcher for per-form shiny release dates spreadsheet via opensheet.

**Methods:**

- `fetch(self, force: bool = False) -> Path`
  - Fetches latest Rplus shiny release dates spreadsheet payload.

---

## Module `src/ingest_community_submissions.py`

```text
Ingestion script for community submissions.
Parses submitted CSV or JSON files (from Google Forms / GitHub Issue Forms)
and converts them into confirmed owner submission claim overrides.
```

### Functions

#### `def ingest_submission_csv(csv_path: Path)`

#### `def main()`

---

## Module `src/inventory_analysis.py`

```text
Schema inventory analysis tool for Master DuckDB database.
```

### Functions

#### `def analyze_exploration_inventory(db_path: str = 'output/GoRefs_Master.duckdb') -> List[Dict[str, Any]]`

*Analyzes the `schema_inventory` table across raw and canonical tables in DuckDB.*

Analyzes the `schema_inventory` table across raw and canonical tables in DuckDB.

Args:
    db_path: Path to the target DuckDB database file. Defaults to
        `output/GoRefs_Master.duckdb`.

Returns:
    List of inventory record dictionaries containing source, table_name, row_count,
    field_count, and sample_fields.

---

## Module `src/models.py`

```text
Pydantic data models for canonical entity schemas in Pokémon GO reference dataset.
```

### Classes

#### `class SpeciesModel(BaseModel)`
*Canonical schema model for a Pokémon species.*

Canonical schema model for a Pokémon species.

#### `class FormModel(BaseModel)`
*Canonical schema model for a Pokémon form or variant.*

Canonical schema model for a Pokémon form or variant.

#### `class MoveModel(BaseModel)`
*Canonical schema model for a combat move.*

Canonical schema model for a combat move.

#### `class DiscrepancyModel(BaseModel)`
*Schema model for cross-source attribute discrepancies.*

Schema model for cross-source attribute discrepancies.

---

## Module `src/paranoid_check.py`

```text
Rebuilt --test-paranoid: an engine-bypassing, dual-method field-coverage
completeness check. Determines, for every raw field of every in-scope source,
whether it reaches a canonical table column (CANONICAL), reaches only
_claims_ledger or a raw-passthrough table (CLAIMS_ONLY), or appears nowhere in
the built database at all (MISSING). Makes no relevance judgments -- reports
facts for a human to triage afterward.

Deliberately does not import anything from src/engine.py: a bug in that
module's own extraction logic must not be able to hide from this check by
also being present in this check's own code path.
```

### Functions

#### `def flatten_json_fields(node: Any, prefix: str = '') -> Set[str]`

*Recursively flattens a JSON-shaped value into a set of dotted field paths.*

Recursively flattens a JSON-shaped value into a set of dotted field paths.

Descends into dicts (each key becomes prefix.key) and into every item of a
list-of-dicts (unioning fields across ALL items, not just the first, since
real sources like GAME_MASTER's assetForms have heterogeneous item shapes).
A list of non-dict scalars is reported as its own path but not descended
into further -- there's nothing to flatten inside a plain string/number.

Args:
    node: A dict, list, or scalar value to flatten.
    prefix: The dotted path accumulated so far (empty string at the root).

Returns:
    Set of every dotted field path found, including intermediate container
    paths (e.g. both "names" and "names.English").

#### `def extract_fields_python_walk(data_file: Path) -> Set[str]`

*Method B: plain json.load + flatten_json_fields over EVERY record,*

Method B: plain json.load + flatten_json_fields over EVERY record,
unconditionally -- no sampling. Handles any top-level shape (list, dict,
or a dict-of-lists container) by flattening the whole payload as one tree;
flatten_json_fields already unions across every list item at every level,
so this naturally covers records nested inside a dict-of-lists container
too, without needing to know the source's specific unwrap/iterate shape.

#### `def extract_fields_duckdb_auto(data_file: Path) -> 'Tuple[Optional[Set[str]], List[str]]'`

*Method A: DuckDB's read_json_auto. Two real failure modes, both*

Method A: DuckDB's read_json_auto. Two real failure modes, both
handled here rather than left to crash or silently under-report:

1. A field appearing only after DuckDB's schema-inference sample window
   makes read_json_auto RAISE (it strictly validates every record
   against the schema it inferred from sampling) -- not silently omit
   the field, as an earlier draft of this design assumed. Caught here;
   signaled to the caller as fields=None so a single bad file can't
   crash the whole multi-source run.
2. Heterogeneous nested content (e.g. real GAME_MASTER.json's "data"
   field, which holds a different shape per templateType) gets typed
   MAP(VARCHAR, JSON) rather than a descendable STRUCT -- not a crash,
   but everything beneath that path is invisible to this method. Each
   such path is returned in collapsed_paths so callers can report ONE
   "cross-check unavailable below this path" line instead of treating
   every field Python's walk finds beneath it as a spurious mismatch.

Returns:
    (fields, collapsed_paths). fields is None on total parse failure
    (collapsed_paths is [] in that case); otherwise a Set[str] as
    before, with collapsed_paths listing any MAP(...)/bare-JSON leaf
    paths where further descent wasn't possible.

#### `def _split_top_level_commas(s: str) -> List[str]`

*Splits a STRUCT(...) body on commas that aren't nested inside another*

Splits a STRUCT(...) body on commas that aren't nested inside another
STRUCT(...)/LIST[...]'s own parens -- a plain str.split(",") would
incorrectly split "a STRUCT(x INT, y INT), b VARCHAR" in the middle of
the nested struct.

#### `def find_templates_for_source(source_key: str, templates_dir: Path) -> List[Dict[str, Any]]`

*Finds every template belonging to source_key by reading each YAML*

Finds every template belonging to source_key by reading each YAML
file's own source_key field -- NEVER by matching on filename, since
filenames don't reliably reflect source_key (e.g. game_master_*.yml
files declare source_key: alexelgt_game_masters internally).

#### `def find_raw_files_for_source(source_key: str, raw_dumps_dir: Path) -> List[Path]`

*Lists every raw data file (excluding .meta.json) in a source's latest*

Lists every raw data file (excluding .meta.json) in a source's latest
timestamped snapshot directory.

#### `def mapped_source_fields(templates: List[Dict[str, Any]]) -> Dict[str, Set[str]]`

*For each template, collects every source_field path declared in its*

For each template, collects every source_field path declared in its
field_mappings + overrides (overrides included since both represent a
conscious mapping decision -- this function doesn't care which one wins
at claim-resolution time, only whether the raw field was decided about
at all). Keyed by endpoint name so a source with multiple endpoint
templates (e.g. pogoapi_net) gets a separate mapped-field set per file.

#### `def canonical_attribute_names(db_path: Path) -> Set[str]`

*Every column name across every canonical domain table -- deliberately*

Every column name across every canonical domain table -- deliberately
excludes meta/passthrough tables (_claims_ledger, discrepancies,
change_history, game_master_templates) since a field merely existing in
one of those doesn't mean it was promoted into a real, modeled domain
column. This is a name-based heuristic (matching attribute names, not
tracing individual values end-to-end) -- sufficient for triage, not a
guaranteed-precise value trace. A human reviewing MISSING/CLAIMS_ONLY
findings is expected to verify the specific case, same as this project's
existing --test suite's own documented "unmapped is not verified"
caveat (see KNOWN_ISSUES.md).

#### `def claims_ledger_attributes(db_path: Path, source_key: str) -> Set[str]`

*Every distinct attribute name _claims_ledger holds a claim for, from*

Every distinct attribute name _claims_ledger holds a claim for, from
the given source.

#### `def classify_endpoint_fields(endpoint: str, python_fields: Set[str], mapped_fields: Set[str], canonical_attrs: Set[str], claims_attrs: Set[str]) -> Dict[str, List[str]]`

*Classifies every raw field found by the (unsampled) Python walk into*

Classifies every raw field found by the (unsampled) Python walk into
exactly one tier. A field is CANONICAL only if it's both mapped AND its
attribute name reaches a real domain-table column; CLAIMS_ONLY if mapped
and reaches _claims_ledger but not a domain column; MISSING otherwise --
including a field that IS in mapped_fields but never actually reached
either _claims_ledger or canonical (a real, if rarer, failure mode: the
mapping is declared but the data never made it through, e.g. a typo'd
source_field or a record where the field was always absent).

#### `def find_method_mismatches(python_fields: Set[str], duckdb_fields: Set[str]) -> List[str]`

*Fields the unsampled Python walk found that DuckDB's sampled*

Fields the unsampled Python walk found that DuckDB's sampled
read_json_auto missed -- the direction that matters, since Python's walk
processes every record unconditionally and is the ground truth here.

#### `def run_paranoid_check(db_path: Path, raw_dumps_dir: Path, templates_dir: Path, sources: 'Optional[List[str]]' = None) -> Dict[str, Any]`

*Runs the full dual-method field-coverage check across the given*

Runs the full dual-method field-coverage check across the given
sources (defaults to every in-scope source, never local_authoring).

Returns a dict:
    {
      "sources": {
        source_key: {
          "endpoints": {endpoint: {"CANONICAL": [...], "CLAIMS_ONLY": [...], "MISSING": [...]}},
          "untemplated_endpoints": [endpoint_names_with_no_template_at_all],
          "method_mismatches": {endpoint: [field, ...]},
          "duckdb_parse_failures": [endpoint_names_duckdb_could_not_parse],
          "collapsed_type_paths": {endpoint: [field_path_collapsed_to_MAP_or_JSON, ...]},
        },
      },
      "summary": {source_key: {"CANONICAL": n, "CLAIMS_ONLY": n, "MISSING": n}},
    }

#### `def render_paranoid_report_markdown(report: Dict[str, Any]) -> str`

*Renders run_paranoid_check()'s dict into a markdown report. Only*

Renders run_paranoid_check()'s dict into a markdown report. Only
MISSING and CLAIMS_ONLY fields are listed per endpoint -- CANONICAL
fields are working as intended and would just be noise; the summary
table still shows their count for context.

---

## Module `src/profiler.py`

```text
Source profiler: inspects raw JSON and proposes config/source_templates/*.yml templates.

Ranks identity-field candidates by uniqueness rather than checking a hardcoded
shortlist of field names -- a fixed shortlist was tried during design review and
missed pvpoke's real identity field (speciesId) entirely (see the spec's
"Profiler dry-run findings" section), which is exactly the kind of hardcoding
this whole project exists to move away from.
```

### Classes

#### `class SourceProfiler`
*Inspects a source's latest raw JSON snapshot and writes/updates its source template.*

Inspects a source's latest raw JSON snapshot and writes/updates its source template.

Templates live at config/source_templates/<source_key>.yml for single-endpoint
sources, or config/source_templates/<source_key>_<endpoint>.yml per endpoint for
multi-endpoint sources -- matching engine.run_source()'s documented template-name
lookup convention (Task 13). They drive the generic ingestion engine
(src/engine.py). Re-running the profiler after
upstream schema drift regenerates auto-detected fields (field_mappings,
gender_signals, identity_field, source_fingerprint) while preserving any
human-authored `overrides` verbatim -- overrides that reference a field
which no longer exists are flagged in `needs_review` rather than silently
dropped or silently kept broken.

**Methods:**

- `__init__(self, raw_dumps_dir: Path = Path('raw_dumps'), templates_dir: Path = Path('config/source_templates'))`
- `_resolve_path(self, record: Dict[str, Any], path: str) -> Any`
- `profile_source(self, source_key: str, endpoint: str) -> Optional[Path]`
- `profile_all_sources(self) -> None`

### Functions

#### `def detect_shape(payload: Any, max_depth: int = 4) -> List[Tuple[List[str], List[Dict[str, Any]]]]`

*Finds every point in payload where a list of record-shaped dicts appears.*

Finds every point in payload where a list of record-shaped dicts appears.

Two shapes are recognized:
  - a bare list of dicts (top-level or nested), recorded at its own path.
  - a "dict of lists" container -- a dict whose values are themselves lists
    of dicts (e.g. {"lvl1": [...], "lvl5": [...]}) -- recorded at the path of
    the container itself, with records being the concatenation of its list
    values. This mirrors engine.unwrap_to_records's iterate_mode="dict_of_lists",
    which resolves unwrap_path to this same container and iterates its values,
    rather than to any single one of its list-valued keys.

Returns:
    List of (path, records) tuples, in discovery order. Callers typically pick
    the shallowest-path, most-populous candidate as primary.

#### `def rank_identity_candidates(records: List[Dict[str, Any]], sample_n: int = 200) -> List[Tuple[str, int, int]]`

*Ranks every field by uniqueness-within-sample, not a hardcoded name shortlist.*

Ranks every field by uniqueness-within-sample, not a hardcoded name shortlist.

Returns:
    List of (field_name, unique_count, sampled_n) sorted by unique_count descending.

#### `def catalog_fields(records: List[Dict[str, Any]], sample_n: int = 200) -> Tuple[Counter, Dict[str, Counter], Dict[str, Any], int]`

*Catalogs every field's presence count, observed type(s), and one example value.*

Catalogs every field's presence count, observed type(s), and one example value.

Includes one level of nested-dict flattening (e.g. "names.English").

Returns:
    (field_presence, field_types, examples, sampled_n)

#### `def detect_gender_signals(records: List[Dict[str, Any]], sample_n: int = 200) -> List[Dict[str, Any]]`

*Scans records for fields that plausibly encode gender.*

Scans records for fields that plausibly encode gender.

Two signal types:
  - boolean_field: a field whose name mentions "female" and holds a bool
    (e.g. isFemale=True).
  - value_pattern: a field whose string values mention "female"
    (e.g. form="FEMALE").

Returns:
    List of signal dicts, sorted by field name within each signal type.

#### `def detect_range_pairs(examples: Dict[str, Any]) -> List[Tuple[str, List[Any]]]`

*Finds fields whose example value is a 2-element numeric list (e.g. a min/max pair).*

Finds fields whose example value is a 2-element numeric list (e.g. a min/max pair).

#### `def compute_shape_fingerprint(field_presence: Counter) -> str`

*Hashes the sorted set of field paths (not values) -- used to detect upstream drift.*

Hashes the sorted set of field paths (not values) -- used to detect upstream drift.

---

## Module `src/reference_shim.py`

```text
Wholesale loader for the reference_json_shim: a raw, unmodeled dump of
GoBuddy's reference.json into output/GoRefs_Master.duckdb, prefixed
refjson_* so it never collides with GoRefs' own canonical tables.

Deliberately not integrated with the fetcher/template/claims-ledger
machinery every other source uses -- this is a short-term stopgap, not a
new permanent source. See data-authoring/reference_json_shim/SOURCE.md.
```

### Functions

#### `def camel_to_snake(name: str) -> str`

*Converts a camelCase key (e.g. "formMoves") to snake_case ("form_moves").*

Converts a camelCase key (e.g. "formMoves") to snake_case ("form_moves").

#### `def load_reference_json_shim(json_path: Path = Path('data-authoring/reference_json_shim/reference.json'), db_path: Path = Path('output/GoRefs_Master.duckdb')) -> Dict[str, int]`

*Loads every top-level array in reference.json into its own*

Loads every top-level array in reference.json into its own
refjson_<snake_case_domain> table in output/GoRefs_Master.duckdb.

Each table is dropped and recreated fresh, so re-running this after
refreshing the copied reference.json is always safe. Table names never
collide with GoRefs' own canonical tables (all prefixed refjson_), so
this can be run before or after --build with no ordering dependency.

Args:
    json_path: Path to the copied reference.json snapshot.
    db_path: Path to the master DuckDB database to load tables into.

Returns:
    Dict mapping each created table name to its row count.

---
