# Reference data sources (all-time) + a starter prompt for an "ultimate ref DB/API" project

This doc has two parts:

1. Every external/reference data source this project has used or evaluated, from V1 through
   the current V2 pipeline, with what it provided and its current status.
2. A draft prompt for kicking off a separate project: a standalone reference database/API
   for Pokémon GO species/form/move/event data, usable by this app and potentially others.

Recovered old ingestion scripts and raw source data (V1-era, retired) live alongside this
file in `ref-db-source-archive/` — see that folder's README for what's there and what
wasn't recovered (old CSVs).

---

## 1. Data sources used across the project's history

### Live on `master` today

Verified against `scripts/ingest/fetch-reference-data.ts` on `master`, which fetches from
exactly these two APIs; nothing else is currently wired into the live build.

| Source | Data provided | Notes |
|---|---|---|
| **[pokemon-go-api](https://github.com/pokemon-go-api/pokemon-go-api)** (`pokemon-go-api.github.io/pokemon-go-api/api`) | Species, regional forms, costumes, Mega/Gigantamax forms, per-form sprite URLs (regular + shiny), evolutions, fast/charged moves (incl. elite/legacy, PvE+PvP combat stats), localized names (7 languages), its own raid-boss list | Primary V2 source. Vendored as a reference-only git submodule at `vendor/reference/pokemon-go-api` for provenance; not read by the build. Cutover: commit `87406a92`. |
| **[pokemon-go-api/assets](https://github.com/pokemon-go-api/assets)** | Sprite images, ID-keyed (`Pokemon/pm{id}.icon.png`, shiny/`form`/`costume` variants), pre-joined to pokemon-go-api's own tokens | Linked from the main pokemon-go-api project, no crosswalk needed. |
| **[pogoapi.net](https://pogoapi.net/documentation/)** | Player progression (XP/levels, badges/medals, friendship), PvP league rewards/ranking, move stats, type effectiveness, weather boosts, CP multiplier curve, buddy distances, capture/flee rates, power-up costs, Community Day history | Data-only, no sprites. |

### In flight on the unmerged `worktree-ingest-consolidation` branch (not on `master`)

These exist in the repo's history/branches but are **not** part of the currently shipping
pipeline — listed separately so they aren't mistaken for live.

| Source | Data provided | Notes |
|---|---|---|
| **GAME_MASTER.json** (raw Niantic client data-master, via [alexelgt/game_masters](https://github.com/alexelgt/game_masters)) | The authoritative raw upstream dump everything else derives from | An indexed parser (`scripts/ingest` on that branch, commit `53a2db5b`) is being built to eventually replace pogoapi.net directly, but isn't merged. |
| **pokemongo-shiny sheet** ([Rplus/pokemongo-shiny](https://github.com/Rplus/pokemongo-shiny), fetched via `opensheet.elk.sh`) | Per-form shiny-release dates | Only source with this granularity; module added on the branch (commit `f35dfe5d`), not on `master` yet. |
| **pogoapi.net full snapshot** (`vendor/pogoapi-snapshot/`, 47 endpoints) | Same coverage as the live pogoapi.net fetch, vendored as a static hedge | Committed on the branch (commit `2dfdc514`) since pogoapi.net is flagged stale/unmaintained and things like medal copy aren't reproducible elsewhere; not yet merged. |

### Retired (V1 pipeline, removed at the V2 cutover, commit `87406a92`)

| Source | Data provided | Why retired |
|---|---|---|
| **[PokeAPI](https://pokeapi.co)** | Original species/form base data | Non-GO taxonomy; pokemon-go-api covers GO-specific needs better. |
| **Bulbapedia** — ["Event Pokémon (GO)"](https://bulbapedia.bulbagarden.net/wiki/Event_Pok%C3%A9mon_(GO)) article, raw wikitext | Event-costume data — the only V1 source of costume/form rows | Superseded by pokemon-go-api's costume coverage. |
| **"Blank Pokedex Project (Living Column)" CSVs** (hand-authored/Obsidian-era spreadsheets — Basic, Forms, Gender w/ Dynamax) | Species/form skeleton | Superseded; root-caused the Espurr data-gap bug (duplicate row label). Old CSVs are in git history but were **not** recovered per instruction — CSV recreation is out of scope. Their content lives on indirectly: it was folded into `src/data/reference.json`, which is still the live, actively-edited dataset today — there is no separate retired "generated JSON" to recover (checked; see archive README). |
| **PokeMiners** (sprite dump) | Original hand-copied sprite set | Superseded by pokemon-go-api/assets automation (CHANGELOG v0.12.0). |
| **Dittobase** | One-off manual costume-name confirmation via web search | Never a pipeline source — used once to disambiguate two GO Tour: Hoenn 2023 costume tokens. |

### Still tracked as in-repo authoring inputs (not retired, not from an external pull)

| Source | Data provided | Notes |
|---|---|---|
| **`data-authoring/gigantamax-species.json`** | Hand-maintained Gigantamax species list | Currently on `master`. Diverged from pokemon-go-api's live list (32 vs. 15) — a known open discrepancy, not a resolved one. |
| **`data-authoring/event-pokemon.csv`** | Manual event/costume corrections | Currently on `master`. Live authoring input layered on top of the ingestion pipeline. |

### Provenance-chain only (credited by the vendored pokemon-go-api project, not fetched directly by this repo)

| Source | What it's for |
|---|---|
| [sora10pls/holoholo-text](https://github.com/sora10pls/holoholo-text/) | Localized name/string translations |
| [Leek Duck](https://leekduck.com/boss/) | Current raid boss list |
| [Snacknap](https://www.snacknap.com/max-battles) | Current Max Battle list |
| [PokeBattler](https://www.pokebattler.com/) | Raid difficulty calculations |

---

## 2. Draft prompt: "ultimate reference DB/API" project

This is a starting point to tweak, not a finished spec — the goal is a standalone,
versioned reference dataset/API for Pokémon GO that GoBuddy (and potentially other
tools) can consume, instead of each consumer re-deriving the same joins across
pokemon-go-api, pogoapi.net, and GAME_MASTER.json.

```
You are designing a standalone reference database + API for Pokémon GO game data,
meant to be consumed by multiple downstream apps (starting with a personal living-dex
tracker called GoBuddy), not just one.

## Problem

Today, GoBuddy's ingestion pipeline pulls from several independent upstream sources
(pokemon-go-api, pogoapi.net, raw GAME_MASTER.json, a shiny-release-date spreadsheet)
that each cover part of the picture, drift out of sync with each other, and sometimes
disagree (e.g. Gigantamax species lists). There is no single, versioned, queryable
source of truth for "everything about Pokémon GO species/forms/moves/events" — every
consumer has to re-solve the same cross-source joins, dedup, and gap-filling.

## Goal

Design (and eventually build) a reference database + thin API that:

- Merges species, regional forms, costumes, Mega/Gigantamax/Shadow variants, moves
  (fast + charged, PvE and PvP stats, elite/legacy status), type effectiveness,
  evolution chains, CP multiplier curves, and shiny availability (including release
  dates) into one normalized schema. (Shadow is sourced today via pogoapi.net's
  `shadow_pokemon.json`; Purified and other variants are candidate scope — not yet
  confirmed against any source above, so don't assume they're in until sourced.)
- Tracks event-driven data over time: Community Days, raid rotations, event costumes —
  with an explicit validity window (start/end date) rather than only "current state,"
  so historical queries ("was X shiny-available in March 2024?") are possible. (Spawn
  bonuses are candidate scope, not sourced by anything in section 1 — confirm a source
  exists before committing to it.)
- Resolves conflicts between upstream sources explicitly (e.g. flags "pokemon-go-api
  says Gigantamax list is 15, a legacy manual list says 32 — here's the diff") rather
  than silently picking one.
- Is versioned and diffable: consumers should be able to pin a version and see a
  changelog between versions, since Niantic's GAME_MASTER changes with nearly every
  update.
- Ships as both (a) a downloadable snapshot (SQLite/JSON) for fully offline/local-first
  consumers like GoBuddy, and (b) an optional hosted read API for consumers that want
  live queries instead of managing their own copy.
- Is sourced primarily from GAME_MASTER.json (the raw Niantic client dump) as the
  ground truth, with pokemon-go-api, pogoapi.net, and community sources (Leek Duck,
  community shiny-date tracking) layered in only for data GAME_MASTER doesn't contain
  (human-readable names/descriptions, historical event calendars, shiny dates).

## Constraints

- No dependency on any single upstream source staying alive — design the ingestion
  pipeline so any one source (pogoapi.net going dark, a GitHub repo disappearing) can
  be dropped or replaced without a schema change.
- Local-first friendly: the primary distribution format must work fully offline.
- Attribution: preserve per-field provenance (which source contributed which value)
  so downstream consumers and this project both can credit sources correctly.

## What I need from you

1. A proposed normalized schema (entities + relationships) covering the data above.
2. A recommended ingestion/merge strategy across GAME_MASTER.json, pokemon-go-api,
   pogoapi.net, and community sources, including how to detect and surface conflicts.
3. A versioning/changelog approach that works for a dataset that changes with every
   Niantic game update.
4. A distribution plan: snapshot format(s) + whether a hosted API is worth building
   now or later, and what the minimal viable version of each looks like.
5. Flag anything here that conflicts with running this fully local-first, before
   assuming a hosted component is required.
```

---

*Compiled 2026-07-29. See `ref-db-source-archive/` for recovered V1-era ingestion
scripts and raw source data referenced above.*
