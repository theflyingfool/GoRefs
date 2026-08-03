# Pokémon GO Open Reference Knowledge Base & API

A standalone, community-maintainable, provenance-aware reference knowledge base and master database for Pokémon GO.

> **Legal & Educational Disclaimer:**
> This repository is for educational and reference purposes only. All Pokémon names, images, trademarks, and game data are owned by Nintendo, Game Freak, The Pokémon Company, and Niantic. This project is provided "as-is" without warranty of any kind.

---

## 🌟 Philosophy & Architecture

- **Single Master Database (`output/GoRefs_Master.duckdb`):** Consolidates all canonical domain tables and 230+ raw source exploration tables into a single high-performance DuckDB database file.
- **Parquet Export (`output/parquet/`):** Every `--build` also exports each canonical domain table to its own `.parquet` file (stale files from prior builds are cleared first) — a remote/WASM-readable path that doesn't require downloading the full DuckDB file.
- **Git as a Database / WASM Web App:** Serves statically with in-browser client-side SQL execution via DuckDB WASM.
- **Provenance & Claims Preservation:** Tracks source origin (`alexelgt_game_masters`, `pokemon_go_api`, `pogoapi_net`, `pvpoke`, `pokeapi`, `rplus_shiny`, `local_authoring`). Conflict resolution applies strict trust hierarchy precedence while logging field discrepancies.
- **Snapshot Diffing & Change History:** Automatically records attribute-level state transitions and entity creations in `change_history`.

---

## 📊 Data Domains Included

1. **Species & Forms:** 1,024 canonical species, 1,967 forms (standard, regional variants, costumes, Megas, Gigantamax, shiny availability, shiny release dates, shadow availability, and sprite icon links).
2. **Combat Moves:** 317 fast & charged moves with PvE power, PvP power, turn durations, and energy stats.
3. **Player Progression & CP Multipliers:** Level 1 through 50+ CP multiplier curves (80 records).
4. **Type Effectiveness Matrix:** 324 attacking vs defending damage multiplier relations.
5. **Weather Boosts:** Weather conditions and boosted types (7 records).
6. **Events & Community Days:** 80 historical community day events and featured Pokémon.
7. **Cross-Source Claims Discrepancies:** Fully audited field discrepancies logged with source provenance.
8. **Master DuckDB Database:** Single master database `output/GoRefs_Master.duckdb` containing 100% of all data across all 7 sources in clean, normalized domain tables.

## 🗄️ Master Database Schema (`output/GoRefs_Master.duckdb`)

### Canonical Domain Tables

- **`species`**: `dex_number`, `slug`, `name`, `gen`, `can_mega_evolve`, `can_gigantamax`, `buddy_distance_km`, `base_attack`, `base_defense`, `base_stamina`, `max_cp_lvl40`, `localized_names` (JSON), `types` (JSON).
- **`forms`**: `slug`, `species_slug`, `dex_number`, `form_name`, `costume_name`, `gender`, `shiny_available`, `shiny_release_date`, `shadow_available`, `buddy_distance_km`, `base_attack`, `base_defense`, `base_stamina`, `max_cp_lvl40`, `image_url`, `shiny_image_url`.
- **`moves`**: `move_id`, `name`, `type`, `is_fast`, `pve_power`, `pve_duration_ms`, `pve_energy_delta`, `pvp_power`, `pvp_cooldown_turns`, `pvp_energy_cost`, `stat_buffs` (JSON).
- **`progression`**: `level`, `cp_multiplier`.
- **`type_effectiveness`**: `attacking_type`, `defending_type`, `multiplier`.
- **`weather_boosts`**: `weather`, `boosted_types` (JSON).
- **`community_days`**: `event_id`, `name`, `date`, `featured_pokemon`.
- **`raid_bosses`**: `tier`, `pokemon_id`, `name`, `form`, `costume`, `min_cp`, `max_cp`, `min_boosted_cp`, `max_boosted_cp`, `shiny_available`, `image_url`, `shiny_image_url`.
- **`max_battles`**: `tier`, `pokemon_id`, `name`, `form`, `costume`, `max_particles_cost`, `shiny_available`, `image_url`, `shiny_image_url`.
- **`quests`**: `quest_id`, `type`, `text`, `target`, `reward_type`, `reward_detail`.
- **`regional_species`**: `dex_number`, `name`, `region`.
- **`nesting_species`**: `dex_number`, `name`, `is_nesting`.
- **`baby_species`**: `dex_number`, `name`, `is_baby`.
- **`shadow_species`**: `dex_number`, `name`, `is_shadow`.
- **`mega_species`**: `dex_number`, `name`, `mega_name`, `first_evolution_energy`, `subsequent_evolution_energy`.
- **`badges`**: `badge_id`, `name`, `is_event_badge` (boolean), `description`, `rank`, `targets`.
- **`pvp_leagues`**: `league_id`, `cp_limit`, `meta`.
- **`discrepancies`**: `entity_id`, `attribute`, `resolved_value` (JSON), `winning_source`, `claims` (JSON).
- **`change_history`**: `timestamp`, `entity_id`, `attribute`, `old_value`, `new_value`, `source_key`.

---

## 🚀 Streamlined CLI & Pipeline Execution (`go_refs.py`)

We use **[`uv`](https://github.com/astral-sh/uv)** for fast, reproducible execution:

```bash
# 1. Fetch fresh raw snapshots from all 7 upstream sources
uv run go_refs.py --fetch

# 2. Build master DuckDB database (output/GoRefs_Master.duckdb) using GoRefsMasterEngine
uv run go_refs.py --build

# 3. Run source-by-source data coverage & precedence test suite (lowest to highest priority)
uv run go_refs.py --test

# 4. Start local HTTP web server hosting Web Explorer & WASM SQL Console (default port 8000)
uv run go_refs.py --serve

# Execute fetch, build (incl. Parquet export + docs), sequentially
uv run go_refs.py --all

# Specify custom port or configuration path
uv run go_refs.py --serve --port 8080 --config config/sources.yml

# Regenerate a source's extraction template (config/source_templates/) from its raw JSON
uv run go_refs.py --deep-dive <source_key>
```

### CLI Flags Reference

- `--fetch`: Download immutable timestamped snapshots from all enabled sources into `raw_dumps/`.
- `--build`: Run `GoRefsMasterEngine` from `src/builder.py` to compile `output/GoRefs_Master.duckdb`, export every canonical table to `output/parquet/`, and auto-generate code docs.
- `--test`: Run `scripts/user_source_coverage_test.py`'s `LedgerReplayTester` — replays the claims ledger a build produced and checks that each `(entity, attribute)`'s trust-tier winner actually landed in the canonical tables, reporting per-source `matched`/`overridden`/`collision`/`gaps`/`unmapped` counts (see `KNOWN_ISSUES.md` for what "unmapped" does and doesn't mean).
- `--docs`: Run `scripts/generate_docs.py` to auto-generate HTML/Markdown docstring documentation in `docs/`.
- `--deep-dive [SOURCE]`: Run `src/profiler.py`'s `SourceProfiler` against a source's latest raw snapshot to (re)generate its `config/source_templates/*.yml` extraction template; omit `SOURCE` to reprofile every source declared in `config/sources.yml`.
- `--serve`: Host local HTTP web server serving static UI assets from `web/`, API docs from `docs/`, and master database from `output/GoRefs_Master.duckdb`.
- `--all`: Execute fetch, build, and doc generation sequentially.
- `--port PORT`: Port for local web server (default: 8000).
- `--config PATH`: Path to source configuration file (default: `config/sources.yml`).

---

## 📚 API Reference & Code Documentation

Comprehensive, auto-generated docstring documentation is available for all modules, classes, and pipeline components:

- **[Interactive HTML API Reference](docs/api_reference.html)**: Styled interactive code documentation with search and symbol filtering.
- **[Markdown API Index](docs/index.md)**: Module index table with function and class counts.
- **[Monolithic API Reference (Markdown)](docs/api_reference.md)**: Full codebase Markdown API specification.

Docstrings are automatically scanned and documentation updated whenever running `--build` or `--docs`:
```bash
# Auto-generate documentation standalone
uv run go_refs.py --docs

# Or run direct script
python3 scripts/generate_docs.py
```

---

## 🖥️ Interactive DuckDB Web UI Launch

To explore `output/GoRefs_Master.duckdb` using DuckDB's built-in web interface:

```bash
duckdb output/GoRefs_Master.duckdb -ui
```

---

## 🛡️ Upstream Source Priority Hierarchy

When resolving canonical values across competing data sources:

1. **`confirmed_owner_submission`** (Local manual overrides in `data-authoring/` & `costume-lookup.json` — top priority)
2. **`authoritative_game_master`** (Niantic `GAME_MASTER.json` client data)
3. **`rplus_shiny`** (Community shiny release date records)
4. **`pokemon_go_api`** (Community Pokémon GO API)
5. **`pvpoke`** (PvPoke open-source PvP gamemaster)
6. **`pogoapi_net`** (Static hedge API)
7. **`pokeapi`** (Main-series Pokédex flavor text & categories)
8. **`unverified_claim`** (User submissions pending review)

---

## 📁 Repository Structure

```
GoRefs/
├── config/
│   ├── sources.yml                 # Upstream source endpoints & priority registry
│   └── source_templates/           # Per-source/endpoint YAML extraction templates (profiler-generated)
├── data-authoring/
│   ├── costume-lookup.json         # Manual costume codename lookups
│   └── community-submissions.json  # Approved user overrides
├── raw_dumps/                      # Versioned timestamped raw source snapshots
│   └── assets/                     # Downloaded sprite icon cache
├── src/
│   ├── fetchers/                   # Modular source fetchers (BaseFetcher)
│   ├── models.py                   # Canonical Pydantic schemas
│   ├── builder.py                  # GoRefsMasterEngine build engine (claims resolution & canonical assembly)
│   ├── engine.py                   # Generic, template-driven extraction engine (run_source(), claims emission)
│   ├── profiler.py                 # SourceProfiler: inspects raw JSON, generates/updates source_templates/*.yml
│   ├── build_tables.py             # DuckDB exploration table helper
│   ├── inventory_analysis.py       # DuckDB raw schema analyzer
│   └── ingest_community_submissions.py
├── output/
│   ├── GoRefs_Master.duckdb        # Sole Master DuckDB Database (Canonical + Raw Tables)
│   └── parquet/                    # Per-canonical-table Parquet export (remote/WASM-readable, rebuilt every --build)
├── web/                            # Single-Page Web Explorer & DuckDB-WASM UI
│   ├── index.html
│   ├── explorer.js
│   └── styles.css
├── go_refs.py                      # Streamlined Master CLI & Pipeline runner
└── pyproject.toml                  # Project metadata and dependencies (managed via uv)
```

