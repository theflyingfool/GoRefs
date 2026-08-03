"""Master build engine and DuckDB database creator for Pokémon GO reference knowledge base.

Orchestrates raw dataset ingestion across 7 data sources, applies trust hierarchy precedence,
resolves claims, logs field discrepancies, compares snapshot changes in a change history engine,
and generates the single Master DuckDB database (`output/GoRefs_Master.duckdb`) containing ONLY
clean normalized domain tables with ZERO source-prefixed table names and ZERO data dropped.
"""

import json
import re
import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import duckdb
import pandas as pd

import src.fetchers
from src.fetchers import FetcherRegistry
from src.engine import run_source, extract_transformed_records


TRUST_HIERARCHY: Dict[str, int] = {
    "confirmed_owner_submission": 1,
    "local_authoring": 1,
    "authoritative_game_master": 2,
    "alexelgt_game_masters": 2,
    "rplus_shiny": 3,
    "pokemon_go_api": 4,
    "pvpoke": 5,
    "pogoapi_net": 6,
    "pokeapi": 7,
    "unverified_claim": 8,
}


def update_readme_counts(counts: Dict[str, int], readme_path: Path = Path("README.md")) -> None:
    """Dynamically updates domain statistics and table counts in README.md when building.

    Args:
        counts: Dictionary containing count statistics per domain.
        readme_path: Path to README.md file. Defaults to `Path("README.md")`.
    """
    if not readme_path.exists():
        return

    content = readme_path.read_text(encoding="utf-8")

    summary_text = (
        f"1. **Species & Forms:** {counts.get('species', 0):,} canonical species, {counts.get('forms', 0):,} forms "
        f"(standard, regional variants, costumes, Megas, Gigantamax, shiny availability, shiny release dates, shadow availability, and sprite icon links).\n"
        f"2. **Combat Moves:** {counts.get('moves', 0):,} fast & charged moves with PvE power, PvP power, turn durations, and energy stats.\n"
        f"3. **Player Progression & CP Multipliers:** Level 1 through 50+ CP multiplier curves ({counts.get('progression', 0):,} records).\n"
        f"4. **Type Effectiveness Matrix:** {counts.get('type_effectiveness', 0):,} attacking vs defending damage multiplier relations.\n"
        f"5. **Weather Boosts:** Weather conditions and boosted types ({counts.get('weather_boosts', 0):,} records).\n"
        f"6. **Events & Community Days:** {counts.get('community_days', 0):,} historical community day events and featured Pokémon.\n"
        f"7. **Cross-Source Claims Discrepancies:** Fully audited field discrepancies logged with source provenance.\n"
        f"8. **Master DuckDB Database:** Single master database `output/GoRefs_Master.duckdb` containing 100% of all data across all 7 sources in clean, normalized domain tables."
    )

    pattern = r"## 📊 Data Domains Included\n\n(.*?)\n\n##"
    replacement = f"## 📊 Data Domains Included\n\n{summary_text}\n\n##"

    new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)
    readme_path.write_text(new_content, encoding="utf-8")


class GoRefsMasterEngine:
    """Unified Master Build Engine for the Pokémon GO Reference Knowledge Base.

    Orchestrates the ingestion of 7 data sources, resolves canonical attributes via source
    precedence (1 > 2 > 3 > 4 > 5 > 6 > 7), logs field discrepancies, tracks snapshot diffs in
    `change_history`, and writes to `output/GoRefs_Master.duckdb` with clean normalized tables.
    """

    def __init__(
        self,
        raw_dumps_dir: Path = Path("raw_dumps"),
        output_dir: Path = Path("output"),
        db_path: Optional[Path] = None
    ):
        """Initializes the GoRefsMasterEngine with workspace directories and source priorities.

        Args:
            raw_dumps_dir: Directory containing timestamped source snapshots.
            output_dir: Target directory for database and JSON outputs.
            db_path: Absolute or relative path to target Master DuckDB file.
                Defaults to `output_dir / "GoRefs_Master.duckdb"`.
        """
        self.raw_dumps_dir = raw_dumps_dir
        self.output_dir = output_dir
        self.db_path = db_path or (output_dir / "GoRefs_Master.duckdb")
        self.source_priorities = TRUST_HIERARCHY.copy()
        self.discrepancies: List[Dict[str, Any]] = []
        self.claims_ledger: List[Dict[str, Any]] = []

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

    def register_custom_domain_table(
        self,
        table_name: str,
        data: Union[pd.DataFrame, List[Dict[str, Any]], str],
        source_key: str = "custom_domain"
    ) -> bool:
        """Dynamically registers a custom domain table into output/GoRefs_Master.duckdb.

        Args:
            table_name: Name of the table to create.
            data: Dataframe, list of dicts, or SQL select string.
            source_key: Source classification label.

        Returns:
            True if registration succeeded, False otherwise.
        """
        from .build_tables import register_custom_domain_table as reg_func
        return reg_func(
            db_file=self.db_path,
            table_name=table_name,
            data=data,
            source_key=source_key
        )

    def resolve_attribute_claim(
        self,
        entity_id: str,
        attribute: str,
        claims: List[Dict[str, Any]]
    ) -> Tuple[Any, str]:
        """Resolves a canonical attribute value from competing source claims.

        Evaluates claims against source priority (lower priority number wins: 1 > 2 > 3 > ...).
        If multiple non-null claims exist and disagree, logs an entry in `discrepancies`.

        Args:
            entity_id: Unique entity key (e.g. "pokemon_dex_150").
            attribute: Attribute name (e.g. "base_attack").
            claims: List of claim dicts with keys "source", "value", and optional "trust_tier".

        Returns:
            Tuple of (resolved_value, winning_source_name).
        """
        valid_claims = [c for c in claims if c.get("value") is not None]
        if not valid_claims:
            return None, "unknown"

        sorted_claims = sorted(
            valid_claims,
            key=lambda c: self.source_priorities.get(c.get("source"), 99)
        )

        winning_claim = sorted_claims[0]
        winning_val = winning_claim.get("value")
        winning_src = winning_claim.get("source")

        distinct_vals = {json.dumps(c.get("value"), sort_keys=True) for c in valid_claims}
        if len(distinct_vals) > 1:
            self.discrepancies.append({
                "entity_id": entity_id,
                "attribute": attribute,
                "claims": valid_claims,
                "resolved_value": winning_val,
                "winning_source": winning_src
            })

        return winning_val, winning_src

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

    def collect_and_resolve_claims(self) -> Dict[str, Any]:
        """Loads raw snapshots across all 7 sources and builds deduplicated canonical datasets.

        Returns:
            Dictionary containing canonical domain lists and metadata.
        """
        self.discrepancies.clear()
        self.claims_ledger.clear()

        # --- Cut-over sources: extracted via the generic engine, not hardcoded parsing ---
        # pokeapi is multi-endpoint (pokemon/pokemon_species/type/move); only the "pokemon"
        # list endpoint (name/url pairs) is templated so far -- see TODO.md.
        for claim in run_source("pokeapi_pokemon", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")):
            self.claims_ledger.append(claim)

        # pogoapi_net cutover: 9 of its 12 consumed endpoints are templatable today
        # (top_level_list-of-dicts). The other 3 consumed endpoints -- shadow_pokemon,
        # alolan_pokemon, galarian_pokemon, released_pokemon, nesting_pokemon,
        # shiny_pokemon (dict-of-single-record-dicts keyed by id) and
        # type_effectiveness/weather_boosts (dict-of-scalars/lists-of-strings, not
        # entity records at all) -- have no shape unwrap_to_records supports yet, so
        # SourceProfiler.profile_source() returns None for them (see task-18-report.md).
        # Extending the engine for those shapes is out of scope here since every claim
        # emitted below lands under a "pogoapi_net_<raw_id>" entity_id that nothing in
        # collect_and_resolve_claims reads back (species/forms read "pokemon_dex_<n>",
        # badges reads via badges_list directly) -- these calls are additive ledger
        # entries only, matching Task 17's pokeapi precedent, not a source of canonical
        # output yet.
        for endpoint in (
            "cp_multiplier", "pokemon_max_cp", "pokemon_stats", "fast_moves",
            "charged_moves", "mega_pokemon", "community_days", "baby_pokemon", "badges",
        ):
            for claim in run_source(f"pogoapi_net_{endpoint}", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")):
                self.claims_ledger.append(claim)

        # pvpoke cutover (Task 19): moves + formats. pvpoke's "pokemon" list is
        # deliberately NOT templated here (species-level data is future scope per
        # the spec's dry-run finding) -- only "moves" (334 records) and "formats"
        # (14 records) are, via pvpoke_moves.yml / pvpoke_formats.yml.
        #
        # formats needs no join: entity_id_prefix="pvp_league" on the template makes
        # its claims land directly on "pvp_league_<title>", the same entity_id the
        # legacy code used, so they're appended straight to the ledger like any
        # other cut-over source.
        pvpoke_formats_claims = run_source("pvpoke_formats", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates"))
        for claim in pvpoke_formats_claims:
            self.claims_ledger.append(claim)

        # moves DOES need a join, and it's a genuine cross-source join the generic
        # engine's per-record apply_transform() cannot do: pvpoke's raw move records
        # only carry a string moveId (e.g. "ACID"), never pogoapi_net's numeric
        # move_id (e.g. 225) that the fast/charged-moves loop below uses to build
        # its "move_<id>" entity_id. So these claims are captured here under
        # pvpoke's own entity scheme ("pvpoke_<MOVEID>", the default entity_id_prefix
        # since pvpoke_moves.yml doesn't override it) rather than appended straight
        # to the ledger, then joined by normalized move name onto the numeric
        # "move_<id>" entity down in that loop -- replacing the legacy
        # `pvpoke_moves_map` + `m_name.lower().replace(" ", "_")` lookup, which had
        # been silently 100% broken (see task-19-report.md: it compared a lowercase
        # key against pvpoke's UPPERCASE raw moveId and never matched).
        pvpoke_moves_claims = run_source("pvpoke_moves", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates"))
        pvpoke_move_join: Dict[str, Dict[str, Any]] = {}
        for claim in pvpoke_moves_claims:
            raw_move_id = claim["entity_id"][len("pvpoke_"):]
            pvpoke_move_join.setdefault(raw_move_id.lower(), {})[claim["attribute"]] = claim["value"]
        for attrs in pvpoke_move_join.values():
            if "buffs" in attrs or "buff_target" in attrs or "buff_apply_chance" in attrs:
                attrs["stat_buffs"] = json.dumps({
                    "buffs": attrs.get("buffs"),
                    "buff_target": attrs.get("buff_target"),
                    "buff_apply_chance": attrs.get("buff_apply_chance"),
                })

        # 1. Game Master Claims -- cut over to the generic engine (Task 22).
        # alexelgt_game_masters is the largest and most authoritative source;
        # this finally lets the shared base-stats loop below (split across
        # sources since Task 18) collapse to alexelgt's contribution alone.
        # GameMasterFetcher.extract_structured_claims() (the hand-written,
        # per-template-type parser this replaces) is deleted entirely --
        # fetch() stays, since raw snapshot retrieval is unrelated to this
        # cutover.
        gm_fetcher = FetcherRegistry.get_fetcher_class("alexelgt_game_masters")("alexelgt_game_masters", {})

        # Species base stats (pokemonSettings): templated via
        # game_master_pokemon_settings.yml, entity_id_prefix: pokemon_dex so
        # claims land on the SAME pokemon_dex_<n> entities pokemon_go_api's
        # pokedex template already uses (Task 20). GAME_MASTER carries
        # multiple pokemonSettings records per dex (regional/costume/event
        # variants, e.g. dex 222 Corsola has 4: CORSOLA, CORSOLA_GALARIAN,
        # CORSOLA_NORMAL, CORSOLA_SPRING_2026, all matching the same
        # dex-number regex), so multiple claims collide on the same
        # (entity_id, attribute) pair. The legacy hand-parser built a plain
        # dict keyed by dex number, so the LAST raw record for a dex silently
        # overwrote every earlier one (verified directly: dex 222's legacy
        # base_attack/base_defense/base_stamina of 116/182/155, per
        # KNOWN_ISSUES.md, come from CORSOLA_SPRING_2026, the LAST of its 4
        # variant records, not the base species record). The ledger
        # resolver's own tie-break (a stable sort keeps the FIRST
        # same-priority claim) is the opposite rule, so this template's
        # claims are collapsed to last-claim-per-(entity_id, attribute) here
        # before merging into the shared ledger, replicating legacy
        # semantics exactly rather than silently changing which variant's
        # stats each species resolves to. (Verified against the real dump
        # that this per-attribute collapse is equivalent to legacy's
        # whole-dict overwrite for every one of the 1024 dex numbers: no
        # dex's last-in-file-order variant record is ever missing a stat
        # field that an earlier variant record had, so collapsing
        # attribute-by-attribute vs. replacing the whole stats dict at once
        # produce identical results here.)
        #
        # Deliberately NOT templated: primary_type_raw/secondary_type_raw.
        # See game_master_pokemon_settings.yml's comment -- emitting them
        # here would flip the canonical `types` column (read back from these
        # exact attribute names, populated today only by pokemon_go_api) to
        # whichever colliding variant record wins the last-wins collapse,
        # which is out of this task's scope (legacy only ever consumed
        # base_attack/base_defense/base_stamina/buddy_distance_km from
        # GAME_MASTER's species stats).
        gm_pokemon_settings_claims = run_source(
            "game_master_pokemon_settings", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        gm_species_last_claim: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for claim in gm_pokemon_settings_claims:
            gm_species_last_claim[(claim["entity_id"], claim["attribute"])] = claim
        for claim in gm_species_last_claim.values():
            self.claims_ledger.append(claim)
        # Per-dex lookup mirroring the shape the legacy gm_species_stats dict
        # provided (dex -> {base_attack, base_defense, base_stamina,
        # buddy_distance_km}), rebuilt from the collapsed claims above --
        # consumed a few lines down by the base-stats resolution loop and by
        # species/forms assembly further below.
        gm_species_stats: Dict[int, Dict[str, Any]] = {}
        for (entity_id, attribute), claim in gm_species_last_claim.items():
            if not entity_id.startswith("pokemon_dex_") or "_form_" in entity_id:
                continue
            dex_nr = int(entity_id[len("pokemon_dex_"):])
            gm_species_stats.setdefault(dex_nr, {})[attribute] = claim["value"]

        # Combat moves (combatMove): templated via game_master_combat_move.yml.
        # GAME_MASTER's moves only carry a STRING uniqueId (e.g. "WRAP") --
        # never pogoapi_net's numeric move_id -- so these claims land under a
        # separate "game_master_move_<uniqueId>" namespace by design (set via
        # that template's entity_id_prefix) and are joined onto the numeric
        # "move_<id>" moves entity by normalized name below, in the
        # fast/charged-moves loop -- the same class of cross-source join
        # Task 19 built for pvpoke's moves (see pvpoke_move_join above), now
        # applied to alexelgt so its higher-trust type/power/energy_delta
        # claims actually compete against pogoapi_net's for the first time
        # (previously they landed on a disjoint "move_<uniqueId>" entity that
        # nothing ever read back -- see task-19-report.md's FLAG and this
        # task's own report for the full analysis).
        gm_move_claims = run_source(
            "game_master_combat_move", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        gm_move_join: Dict[str, Dict[str, Any]] = {}
        for claim in gm_move_claims:
            raw_unique_id = claim["entity_id"][len("game_master_move_"):]
            gm_move_join.setdefault(raw_unique_id, {})[claim["attribute"]] = claim["value"]

        def _gm_move_lookup(pogo_name: Optional[str], is_fast: bool) -> Dict[str, Any]:
            """Normalizes a pogoapi_net move display name (e.g. "Fury Cutter")
            into GAME_MASTER's uniqueId spelling convention (e.g.
            "FURY_CUTTER", or "FURY_CUTTER_FAST" for fast moves) and looks it
            up against gm_move_join. The "_FAST" suffix is only tried when
            is_fast is True -- pogoapi_net's own charged_moves.json contains 3
            entries (Psywave, Metal Sound, Sand Attack) with fast-move-shaped
            stats (duration=500, positive energy_delta) that have no bare-name
            match in GAME_MASTER but DO have a same-named "_FAST" combat move;
            trying the suffix for charged moves too would silently apply that
            unrelated fast move's type/power/energy_delta to a charged-move
            entity (found and fixed during this task's own verification, not
            anticipated up front). Verified against real data with this fix in
            place: 307/317 (96.8%) of pogoapi_net's fast+charged moves match;
            the unmatched are genuinely absent from the live GAME_MASTER
            (Crush Claw, Leech Life, Horn Drill, Fissure, Myst Fire -- old or
            unreleased moves), pogoapi_net data-quality issues (Wildbold Storm
            is a pogoapi typo for GAME_MASTER's WILDBOLT_STORM; Water Gun
            Blastoise is word-order-reversed vs. GAME_MASTER's
            WATER_GUN_FAST_BLASTOISE), or exactly the 3 mislabeled-charged-move
            cases above -- none fuzzy-matched, since guessing at any of these
            spelling/labeling divergences risks a false match for some other,
            unrelated move.
            """
            if not pogo_name:
                return {}
            norm = re.sub(r"[^A-Z0-9]+", "_", pogo_name.upper()).strip("_")
            if is_fast:
                return gm_move_join.get(norm) or gm_move_join.get(f"{norm}_FAST") or {}
            return gm_move_join.get(norm) or {}

        def _strip_type_prefix(raw_type: Optional[str]) -> Optional[str]:
            if not raw_type:
                return None
            return raw_type.replace("POKEMON_TYPE_", "").capitalize()

        # Progression (cp_multipliers / playerLevel): templated via
        # game_master_player_level.yml, read via extract_transformed_records()
        # rather than run_source() -- there is exactly one playerLevel record,
        # and its real content (an 80-element array) needs to EXPAND into 80
        # progression rows, a shape run_source()'s one-entity-id-per-record
        # model can't express. The PRIMARY+FALLBACK mechanism this replaces
        # (fall back to pogoapi_net's raw cp_multiplier dump if GAME_MASTER's
        # comes back empty) is preserved unchanged at the "Build Progression"
        # section below -- verified against the real dump that GAME_MASTER's
        # cpMultiplier array is always populated (80/80 values present), so
        # the fallback is currently unexercised but intentionally kept, not
        # dead code removed.
        gm_player_level_records = extract_transformed_records(
            "game_master_player_level", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        gm_cp_mults: List[Dict[str, Any]] = []
        if gm_player_level_records:
            mults = gm_player_level_records[0].get("cp_multiplier_list") or []
            for idx, mult in enumerate(mults, start=1):
                gm_cp_mults.append({"level": float(idx), "cp_multiplier": mult})

        # Items / stickers / avatars / friendship / encounters (Task 22):
        # single-source domains (alexelgt is their only source), read via
        # extract_transformed_records() rather than run_source()'s claims
        # ledger -- per Task 20's raid_bosses/max_battles precedent, there is
        # no cross-source arbitration to do, so the ledger/resolved-claims
        # indirection buys nothing. Canonical output is one row per raw
        # record, unfiltered/undeduped, exactly matching the legacy plain-list
        # (`.append()`-only, never dict-collapsed) behavior these 5 domains
        # always had -- see each template's own comment for the specific
        # legacy-fallback-chain fields (asset_id, avatar_id, unlocked_features)
        # this replicates. emit_claim() calls are kept for discrepancy-log
        # audit-trail parity with the legacy code, even though there's no
        # cross-source competition to actually arbitrate for these domains.
        gm_item_records = extract_transformed_records(
            "game_master_item_settings", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        gm_items = []
        for r in gm_item_records:
            item_id = r.get("item_id")
            if item_id:
                self.emit_claim(f"item_{item_id}", "item_type", "alexelgt_game_masters", r.get("item_type"))
                self.emit_claim(f"item_{item_id}", "category", "alexelgt_game_masters", r.get("category"))
                self.emit_claim(f"item_{item_id}", "drop_trainer_level", "alexelgt_game_masters", r.get("drop_trainer_level"))
            gm_items.append({
                "item_id": item_id,
                "item_type": r.get("item_type"),
                "category": r.get("category"),
                "drop_trainer_level": r.get("drop_trainer_level"),
            })

        gm_sticker_records = extract_transformed_records(
            "game_master_sticker_metadata", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        gm_stickers = []
        for r in gm_sticker_records:
            sticker_id = r.get("sticker_id")
            asset_id = r.get("asset_id_raw") or r.get("sticker_url") or (str(r.get("pokemon_id_raw")) if r.get("pokemon_id_raw") else "")
            if sticker_id:
                self.emit_claim(f"sticker_{sticker_id}", "max_count", "alexelgt_game_masters", r.get("max_count"))
                self.emit_claim(f"sticker_{sticker_id}", "asset_id", "alexelgt_game_masters", asset_id)
            gm_stickers.append({
                "sticker_id": sticker_id,
                "max_count": r.get("max_count"),
                "asset_id": asset_id,
            })

        gm_avatar_records = extract_transformed_records(
            "game_master_avatar_customization", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        gm_avatars = []
        for r in gm_avatar_records:
            avatar_id = r.get("avatar_id")
            if avatar_id:
                self.emit_claim(f"avatar_{avatar_id}", "slot", "alexelgt_game_masters", r.get("slot"))
                self.emit_claim(f"avatar_{avatar_id}", "unlock_player_level", "alexelgt_game_masters", r.get("unlock_player_level"))
            gm_avatars.append({
                "avatar_id": avatar_id,
                "slot": r.get("slot"),
                "unlock_player_level": r.get("unlock_player_level"),
            })

        gm_friendship_records = extract_transformed_records(
            "game_master_friendship_milestone", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        gm_friendship = []
        for r in gm_friendship_records:
            milestone_level = r.get("milestone_level")
            # unlocked_features (legacy: a JSON array of every raw key on the
            # record whose name starts with "unlocked" and whose value is
            # truthy) -- verified exhaustively against the real dump that
            # exactly two such keys ever appear across all 6 real records;
            # recombined here in the same key order legacy produced.
            unlocked_keys = []
            if r.get("unlocked_trading"):
                unlocked_keys.append("unlockedTrading")
            if r.get("unlocked_lucky_friend_applicator"):
                unlocked_keys.append("unlockedLuckyFriendApplicator")
            unlocked_features = json.dumps(unlocked_keys)
            xp_reward = r.get("xp_reward")
            if milestone_level is not None:
                self.emit_claim(f"friendship_{milestone_level}", "unlocked_features", "alexelgt_game_masters", unlocked_features)
                self.emit_claim(f"friendship_{milestone_level}", "xp_reward", "alexelgt_game_masters", xp_reward)
            gm_friendship.append({
                "milestone_level": milestone_level,
                "unlocked_features": unlocked_features,
                "xp_reward": xp_reward,
            })

        gm_encounter_records = extract_transformed_records(
            "game_master_encounter_settings", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        gm_encounters = []
        for r in gm_encounter_records:
            # encounterSettings is always a single, constant-templateId record
            # (see game_master_encounter_settings.yml's comment) -- hardcoded
            # here rather than plumbed through key_becomes_field for a value
            # that never varies.
            template_id = "ENCOUNTER_SETTINGS"
            self.emit_claim(f"encounter_{template_id}", "spin_bonus_threshold", "alexelgt_game_masters", r.get("spin_bonus_threshold"))
            self.emit_claim(f"encounter_{template_id}", "excellent_throw_threshold", "alexelgt_game_masters", r.get("excellent_throw_threshold"))
            self.emit_claim(f"encounter_{template_id}", "great_throw_threshold", "alexelgt_game_masters", r.get("great_throw_threshold"))
            self.emit_claim(f"encounter_{template_id}", "nice_throw_threshold", "alexelgt_game_masters", r.get("nice_throw_threshold"))
            gm_encounters.append({
                "template_id": template_id,
                "spin_bonus_threshold": r.get("spin_bonus_threshold"),
                "excellent_throw_threshold": r.get("excellent_throw_threshold"),
                "great_throw_threshold": r.get("great_throw_threshold"),
                "nice_throw_threshold": r.get("nice_throw_threshold"),
            })

        # game_master_templates (raw_templates): a full-fidelity raw passthrough
        # -- extract_structured_claims()'s own docstring called this "100% of
        # every record template" (~18,479 total templates, only a few hundred
        # of which fall into the 8 selectively-templated domains above).
        # Selective field_mappings templating is the wrong tool for "preserve
        # everything verbatim"; kept as a direct raw-JSON passthrough here,
        # the same design decision Task 18 made for badges when templating
        # didn't fit the domain's actual requirement.
        raw_gm_templates = gm_fetcher.load_latest_raw("GAME_MASTER") or []
        gm_raw_templates = []
        for item in raw_gm_templates:
            if not isinstance(item, dict):
                continue
            template_id = item.get("templateId", "")
            data = item.get("data", {})
            if not isinstance(data, dict):
                continue
            record_type = next((k for k in data.keys() if k != "templateId"), "unknown")
            gm_raw_templates.append({
                "template_id": template_id,
                "record_type": record_type,
                "data_json": json.dumps(data),
            })

        # 2. Pokémon GO API Snapshots
        # raidboss/maxbattles/quests are no longer loaded here -- Task 20 cut
        # them over to extract_transformed_records() (see the "Build Raid
        # Bosses / Max Battles / Quests" block below), which reads their raw
        # snapshots itself via their templates. pokedex_raw is still loaded
        # directly since the species/forms loop below needs to iterate it for
        # scaffolding (dex_number/slug/name) even though its attribute values
        # are now read back from the templated pokedex claims.
        pg_api_fetcher = FetcherRegistry.get_fetcher_class("pokemon_go_api")("pokemon_go_api", {})
        pokedex_raw = pg_api_fetcher.load_latest_raw("pokedex") or []

        # 3. PoGO API Snapshots
        pogo_fetcher = FetcherRegistry.get_fetcher_class("pogoapi_net")("pogoapi_net", {})
        cp_mult_raw = pogo_fetcher.load_latest_raw("cp_multiplier") or []
        type_effect_raw = pogo_fetcher.load_latest_raw("type_effectiveness") or {}
        weather_raw = pogo_fetcher.load_latest_raw("weather_boosts") or {}
        max_cp_raw = pogo_fetcher.load_latest_raw("pokemon_max_cp") or []
        stats_raw = pogo_fetcher.load_latest_raw("pokemon_stats") or []
        fast_moves_raw = pogo_fetcher.load_latest_raw("fast_moves") or []
        charged_moves_raw = pogo_fetcher.load_latest_raw("charged_moves") or []
        shadow_raw = pogo_fetcher.load_latest_raw("shadow_pokemon") or {}
        mega_raw = pogo_fetcher.load_latest_raw("mega_pokemon") or {}
        community_days_raw = pogo_fetcher.load_latest_raw("community_days") or []
        alolan_raw = pogo_fetcher.load_latest_raw("alolan_pokemon") or {}
        galarian_raw = pogo_fetcher.load_latest_raw("galarian_pokemon") or {}
        released_raw = pogo_fetcher.load_latest_raw("released_pokemon") or {}
        nesting_raw = pogo_fetcher.load_latest_raw("nesting_pokemon") or {}
        shiny_pogoapi_raw = pogo_fetcher.load_latest_raw("shiny_pokemon") or {}
        baby_raw = pogo_fetcher.load_latest_raw("baby_pokemon") or {}
        badges_raw = pogo_fetcher.load_latest_raw("badges") or {}

        # 4. PvPoke Snapshots -- cut over to the generic engine (Task 19); see the
        # pvpoke_formats_claims / pvpoke_moves_claims / pvpoke_move_join block above.
        # No more hand-parsed pvpoke_raw / pvpoke_fetcher here.

        # 5. Rplus Shiny Snapshots -- cut over to the generic engine (Task 21);
        # see the rplus_shiny_claims / shiny_dates_by_dex block below. No more
        # hand-parsed shiny_raw / rplus_fetcher here.

        # Resolve species combat stats with priority resolution
        # (pogoapi_net's contribution to this loop was cut over to the templated
        # engine -- see the run_source("pogoapi_net_pokemon_stats", ...) call above.
        # Note: those templated claims land under entity_id "pogoapi_net_<pokemon_id>",
        # not "pokemon_dex_<d>", so they are not read back here or anywhere else yet
        # (see the comment above the cutover block) -- alexelgt_game_masters covers all
        # 1024 dex ids with priority 2 (beats pogoapi_net's priority 6), so pogoapi_net
        # never actually won this resolution even before the cutover; deleting its
        # branch changes no resolved value. The alexelgt_game_masters half stays until
        # Task 22 cuts that source over.)
        resolved_stats_by_dex = {}
        all_dex_ids = set(gm_species_stats.keys())
        for d in all_dex_ids:
            gm_stat = gm_species_stats.get(d, {})
            entity_id = f"pokemon_dex_{d}"

            resolved_entry = {}
            for stat_key in ["base_attack", "base_defense", "base_stamina"]:
                claims = []
                gm_val = gm_stat.get(stat_key)
                if gm_val is not None:
                    claims.append({"source": "alexelgt_game_masters", "value": gm_val})
                    # Not re-emitted via self.emit_claim here (Task 22): this
                    # exact claim is already in self.claims_ledger, appended
                    # by the game_master_pokemon_settings collapse step
                    # above -- emitting it again would just double-count an
                    # identical claim, not change any resolved value or
                    # discrepancy (resolve_attribute_claim/resolve_all_claims
                    # dedupe by distinct VALUE, not claim count).

                val, _ = self.resolve_attribute_claim(entity_id, stat_key, claims)
                resolved_entry[stat_key] = val

            resolved_stats_by_dex[d] = resolved_entry

        # Map max CP from pogoapi_net
        max_cp_by_dex = {}
        if isinstance(max_cp_raw, list):
            for m in max_cp_raw:
                d = m.get("pokemon_id")
                if d:
                    max_cp_by_dex[int(d)] = m.get("max_cp")

        # Map shiny release dates from rplus_shiny -- cut over to the generic
        # engine (Task 21). The raw sheet's `pid` field is "pm<dex_number>"
        # for base species (881 of 1331 records) or "pm<dex_number>.<suffix>"
        # for costume/event/mega variants (450 records, e.g. ".fFALL_2019",
        # ".cJAN_2020_NOEVOLVE", ".fMEGA"). The legacy code silently dropped
        # every suffixed record (it only ever matched a bare-digit pid after
        # stripping "pm"), and that filtering can't be expressed inside a
        # template: run_source()'s identity_field is a plain record.get() with
        # no regex/extraction applied to the value itself (see
        # engine.run_source()'s entity_id_prefix caveat comment). So
        # rplus_shiny_shiny_releases.yml uses identity_field: pid +
        # entity_id_prefix: pokemon_dex, producing one claim per record with
        # entity_id "pokemon_dex_pm<dex>" (base) or
        # "pokemon_dex_pm<dex>.<suffix>" (variant) -- filtered/remapped here in
        # builder.py, not in the template, mirroring how Task 19 kept a
        # source-specific filter in builder.py rather than forcing a
        # general-purpose engine transform for a single-task concern.
        #
        # 200 of the 881 base records have debut == "" (an empty string, not a
        # missing key) -- the legacy `and date_val` check treated that as no
        # claim at all (empty string is falsy), not an empty-string claim, so
        # the `claim["value"]` truthy check below replicates that exactly
        # (run_source()'s own filter is only `value is not None`, which would
        # otherwise let "" through).
        #
        # No base (non-suffixed) dex number appears more than once in the raw
        # snapshot (verified directly against raw_dumps/rplus_shiny), so
        # there's no claim-ordering/tie-break behavior to replicate beyond
        # this filter.
        rplus_shiny_claims = run_source("rplus_shiny_shiny_releases", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates"))
        shiny_dates_by_dex = {}
        base_pid_pattern = re.compile(r"^pokemon_dex_pm(\d+)$")
        for claim in rplus_shiny_claims:
            match = base_pid_pattern.match(claim["entity_id"])
            if not match or not claim["value"]:
                continue
            dex_nr = int(match.group(1))
            claim["entity_id"] = f"pokemon_dex_{dex_nr}"
            self.claims_ledger.append(claim)
            shiny_dates_by_dex[dex_nr] = str(claim["value"])

        # local_authoring cutover (Task 23) -- first real integration of this
        # source into collect_and_resolve_claims at all (previously it only
        # appeared in TRUST_HIERARCHY and the fetcher registry; costume-
        # lookup.json/community-submissions.json were never actually read
        # anywhere). community-submissions.json has no template and is never
        # called here: the file does not exist (not in data-authoring/, not in
        # any raw_dumps snapshot) -- config/sources.yml still lists it and
        # src/fetchers/local_authoring.py's fetch loop already warns/skips it
        # defensively. This is a known, pre-existing, aspirational/unpopulated
        # source, not something this task creates data for.
        #
        # costume-lookup.json is a flat dict-of-scalars lookup (verified: 62
        # entries, keys are raw costume tokens like "FASHION_2021_NOEVOLVE" --
        # the exact same strings pokemon_go_api_pokedex.yml's sub_records
        # already write into forms.costume_name -- values are curated display
        # names, or "" for the 5/62 tokens nobody has curated yet), not a
        # per-entity record set like every other cutover so far. It's routed
        # through run_source() with entity_id_prefix: costume_token, so each
        # claim's entity_id is "costume_token_<TOKEN>", not tied to any one
        # species/form. The forms-assembly loop further down re-joins each
        # form's own costume_name token back against this ledger to populate
        # a new costume_display_name field (see FormModel).
        #
        # Empty-string values must NOT become ledger claims -- an empty
        # curated name is "nobody has curated one yet", not "the display name
        # is blank" -- mirroring the exact same builder.py-side truthy filter
        # Task 21 already established for rplus_shiny's empty-string debut
        # dates (run_source()'s own filter is only `value is not None`, which
        # alone lets "" through; see test_run_source_alone_lets_empty_string_
        # through in tests/test_cutover_local_authoring.py).
        costume_lookup_claims = run_source("local_authoring_costume-lookup", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates"))
        for claim in costume_lookup_claims:
            if claim["attribute"] != "display_name":
                continue  # the "costume_token" field_mappings claim is inert -- nothing reads that attribute back
            if not claim["value"]:
                continue
            self.claims_ledger.append(claim)

        # Build Species and Forms -- cut over to the generic engine (Task 20).
        # See config/source_templates/pokemon_go_api_pokedex.yml for the full
        # identity_field/entity_id_prefix/sub_records reasoning. sub_records
        # (Task 20's new engine capability) handles assetForms/regionForms
        # entirely -- normalizing each variant's identity via
        # normalize_form_identity() before it becomes an entity_id -- which is
        # what fixes the Frillish gender/duplicate-row bug (KNOWN_ISSUES.md #1)
        # by construction: two different upstream fields describing the same
        # real variant land on the SAME entity_id instead of producing two
        # separate, inconsistently-tagged rows.
        pokedex_claims = run_source("pokemon_go_api_pokedex", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates"))
        for claim in pokedex_claims:
            self.claims_ledger.append(claim)

        # Distinct non-standard form entity_ids, in first-seen order, straight
        # from the templated claims -- mirrors the pvp_league_entity_ids
        # precedent above (formats). One row will be built per entity_id once
        # resolve_all_claims() has run, further down.
        non_standard_form_entity_ids = []
        seen_form_entities = set()
        for claim in pokedex_claims:
            eid = claim["entity_id"]
            if "_form_" in eid and eid not in seen_form_entities:
                seen_form_entities.add(eid)
                non_standard_form_entity_ids.append(eid)

        species_list = []
        forms_list = []
        # Per-dex species-level context non-standard forms need re-joined onto
        # them post-resolve (shiny availability/dates and base stats are
        # species-wide, not per-form, in this upstream source -- matching the
        # pre-cutover behavior of duplicating them onto every form row).
        species_context_by_dex: Dict[int, Dict[str, Any]] = {}

        for entry in pokedex_raw:
            dex_nr = entry.get("dexNr")
            names_dict = entry.get("names", {})
            name = names_dict.get("English", f"Pokemon #{dex_nr}")
            slug = f"{dex_nr}-{name.lower().replace(' ', '-').replace('♀', '-f').replace('♂', '-m')}"

            gen = entry.get("generation", 1)
            assets = entry.get("assets") or {}
            shiny_date = shiny_dates_by_dex.get(dex_nr)
            has_shiny = dex_nr in shiny_dates_by_dex or bool(assets.get("shinyImage")) or str(dex_nr) in shiny_pogoapi_raw

            b_stats = resolved_stats_by_dex.get(dex_nr, {})
            max_cp_val = max_cp_by_dex.get(dex_nr)
            gm_stat_entry = gm_species_stats.get(dex_nr, {})

            species_context_by_dex[dex_nr] = {
                "species_slug": slug,
                "shiny_available": has_shiny,
                "shiny_release_date": shiny_date,
                "buddy_distance_km": gm_stat_entry.get("buddy_distance_km"),
                "base_attack": b_stats.get("base_attack"),
                "base_defense": b_stats.get("base_defense"),
                "base_stamina": b_stats.get("base_stamina"),
                "max_cp_lvl40": max_cp_val,
            }

            species_list.append({
                "dex_number": dex_nr,
                "slug": slug,
                "name": name,
                "gen": gen,
                "can_mega_evolve": bool(entry.get("hasMegaEvolution")),
                "can_gigantamax": bool(entry.get("hasGigantamaxEvolution")),
                "buddy_distance_km": gm_stat_entry.get("buddy_distance_km"),
                "base_attack": b_stats.get("base_attack"),
                "base_defense": b_stats.get("base_defense"),
                "base_stamina": b_stats.get("base_stamina"),
                "max_cp_lvl40": max_cp_val,
                "localized_names": json.dumps(names_dict) if names_dict else None,
                "types": [t.get("type", "").replace("POKEMON_TYPE_", "").capitalize() for t in [entry.get("primaryType"), entry.get("secondaryType")] if t]
            })

            # Standard Form: NOT part of sub_records (it's the parent pokedex
            # record itself, not a nested assetForms/regionForms entry), so
            # it's built directly here -- using the same
            # "pokemon_dex_<dex>_form_standard" id engine._build_form_entity_id
            # would produce for an empty-suffix identity tuple, so the
            # read-back loop below can treat every form uniformly regardless
            # of which code path built it.
            standard_entity_id = f"pokemon_dex_{dex_nr}_form_standard"
            self.emit_claim(standard_entity_id, "shadow_available", "pogoapi_net", str(dex_nr) in shadow_raw)
            self.emit_claim(standard_entity_id, "shiny_available", "pokemon_go_api", has_shiny)
            forms_list.append({
                "slug": f"{slug}-standard",
                "species_slug": slug,
                "dex_number": dex_nr,
                "form_name": "Standard",
                "costume_name": None,
                "costume_display_name": None,  # Standard forms never carry a costume token to look up
                "gender": "unknown",
                "shiny_available": has_shiny,
                "shiny_release_date": shiny_date,
                "shadow_available": str(dex_nr) in shadow_raw,
                "buddy_distance_km": gm_stat_entry.get("buddy_distance_km"),
                "base_attack": b_stats.get("base_attack"),
                "base_defense": b_stats.get("base_defense"),
                "base_stamina": b_stats.get("base_stamina"),
                "max_cp_lvl40": max_cp_val,
                "image_url": assets.get("image"),
                "shiny_image_url": assets.get("shinyImage")
            })

        # Build Combat Moves
        # pvpoke's contribution (pvp_power/pvp_energy_cost/pvp_cooldown_turns/stat_buffs)
        # is emitted below via pvpoke_move_join (built above from the templated
        # pvpoke_moves claims) and read back from `resolved` further down, once
        # resolve_all_claims() has run -- not assembled inline here, matching the
        # pattern species/forms use (Task 8). The dict literals below seed those
        # keys as None; they get overwritten from `resolved` after it's computed.
        #
        # alexelgt_game_masters' contribution (Task 22: type/pve_power/
        # pve_energy_delta, via gm_move_join/_gm_move_lookup built above) is
        # emitted at the SAME canonical attribute names pogoapi_net already
        # uses on this exact entity, so it actually competes in trust-tier
        # resolution for the first time (alexelgt outranks pogoapi_net in
        # TRUST_HIERARCHY) rather than landing on a disjoint entity nothing
        # reads back. durationTurns is claimed too (for coverage/audit) but
        # deliberately has no canonical moves_list column -- no baseline row
        # ever had one, and only 69/324 GAME_MASTER moves carry it; adding a
        # new column for a field only ever available from one source and
        # covering a fifth of moves is a schema expansion out of this
        # cutover's scope.
        moves_list = []

        if isinstance(fast_moves_raw, list):
            for m in fast_moves_raw:
                m_name = m.get("name")
                m_id = m.get("move_id")
                norm_name = m_name.lower().replace(" ", "_") if m_name else None
                pvp_claims = pvpoke_move_join.get(norm_name, {}) if norm_name else {}
                gm_move_claims = _gm_move_lookup(m_name, is_fast=True)
                entity_id = f"move_{m_id}"
                self.emit_claim(entity_id, "type", "pogoapi_net", m.get("type"))
                self.emit_claim(entity_id, "is_fast", "pogoapi_net", True)
                self.emit_claim(entity_id, "pve_power", "pogoapi_net", m.get("power"))
                self.emit_claim(entity_id, "pve_duration_ms", "pogoapi_net", m.get("duration"))
                self.emit_claim(entity_id, "pve_energy_delta", "pogoapi_net", m.get("energy_delta"))
                self.emit_claim(entity_id, "type", "alexelgt_game_masters", _strip_type_prefix(gm_move_claims.get("type_raw")))
                self.emit_claim(entity_id, "pve_power", "alexelgt_game_masters", gm_move_claims.get("power"))
                self.emit_claim(entity_id, "pve_energy_delta", "alexelgt_game_masters", gm_move_claims.get("energy_delta"))
                self.emit_claim(entity_id, "duration_turns", "alexelgt_game_masters", gm_move_claims.get("duration_turns"))
                self.emit_claim(entity_id, "pvp_power", "pvpoke", pvp_claims.get("pvp_power"))
                self.emit_claim(entity_id, "pvp_energy_cost", "pvpoke", pvp_claims.get("pvp_energy_cost"))
                self.emit_claim(entity_id, "pvp_cooldown_turns", "pvpoke", pvp_claims.get("pvp_cooldown_turns"))
                moves_list.append({
                    "move_id": m_id,
                    "name": m_name,
                    "type": m.get("type"),
                    "is_fast": True,
                    "pve_power": m.get("power"),
                    "pve_duration_ms": m.get("duration"),
                    "pve_energy_delta": m.get("energy_delta"),
                    "pvp_power": None,
                    "pvp_energy_cost": None,
                    "pvp_cooldown_turns": None,
                    "stat_buffs": None
                })

        if isinstance(charged_moves_raw, list):
            for m in charged_moves_raw:
                m_name = m.get("name")
                m_id = m.get("move_id")
                norm_name = m_name.lower().replace(" ", "_") if m_name else None
                pvp_claims = pvpoke_move_join.get(norm_name, {}) if norm_name else {}
                gm_move_claims = _gm_move_lookup(m_name, is_fast=False)
                entity_id = f"move_{m_id}"
                self.emit_claim(entity_id, "type", "pogoapi_net", m.get("type"))
                self.emit_claim(entity_id, "is_fast", "pogoapi_net", False)
                self.emit_claim(entity_id, "pve_power", "pogoapi_net", m.get("power"))
                self.emit_claim(entity_id, "pve_duration_ms", "pogoapi_net", m.get("duration"))
                self.emit_claim(entity_id, "pve_energy_delta", "pogoapi_net", m.get("energy_delta"))
                self.emit_claim(entity_id, "type", "alexelgt_game_masters", _strip_type_prefix(gm_move_claims.get("type_raw")))
                self.emit_claim(entity_id, "pve_power", "alexelgt_game_masters", gm_move_claims.get("power"))
                self.emit_claim(entity_id, "pve_energy_delta", "alexelgt_game_masters", gm_move_claims.get("energy_delta"))
                self.emit_claim(entity_id, "duration_turns", "alexelgt_game_masters", gm_move_claims.get("duration_turns"))
                self.emit_claim(entity_id, "pvp_power", "pvpoke", pvp_claims.get("pvp_power"))
                self.emit_claim(entity_id, "pvp_energy_cost", "pvpoke", pvp_claims.get("pvp_energy_cost"))
                self.emit_claim(entity_id, "stat_buffs", "pvpoke", pvp_claims.get("stat_buffs"))
                moves_list.append({
                    "move_id": m_id,
                    "name": m_name,
                    "type": m.get("type"),
                    "is_fast": False,
                    "pve_power": m.get("power"),
                    "pve_duration_ms": m.get("duration"),
                    "pve_energy_delta": m.get("energy_delta"),
                    "pvp_power": None,
                    "pvp_energy_cost": None,
                    "pvp_cooldown_turns": None,
                    "stat_buffs": None
                })

        # Build Progression
        progression_list = gm_cp_mults if gm_cp_mults else []
        if not progression_list and isinstance(cp_mult_raw, list):
            for row in cp_mult_raw:
                progression_list.append({
                    "level": row.get("level"),
                    "cp_multiplier": row.get("multiplier")
                })

        # Build Type Effectiveness
        type_effectiveness_list = []
        if isinstance(type_effect_raw, dict):
            for atk_type, def_map in type_effect_raw.items():
                if isinstance(def_map, dict):
                    for def_type, mult in def_map.items():
                        type_effectiveness_list.append({
                            "attacking_type": atk_type,
                            "defending_type": def_type,
                            "multiplier": float(mult)
                        })

        # Build Weather Boosts
        weather_boosts_list = []
        if isinstance(weather_raw, dict):
            for weather, types_boosted in weather_raw.items():
                weather_boosts_list.append({
                    "weather": weather,
                    "boosted_types": types_boosted
                })

        # Build Community Days
        community_days_list = []
        if isinstance(community_days_raw, list):
            for cd in community_days_raw:
                event_id = str(cd.get("event_id") or cd.get("id") or f"cd-{cd.get('date')}")
                cd_name = str(cd.get("name") or cd.get("community_day_name") or "Community Day")
                cd_date = str(cd.get("date") or cd.get("event_date") or "")
                featured_pokemon = cd.get("featured_pokemon")
                entity_id = f"community_day_{event_id}"
                self.emit_claim(entity_id, "name", "pogoapi_net", cd_name)
                self.emit_claim(entity_id, "date", "pogoapi_net", cd_date)
                self.emit_claim(entity_id, "featured_pokemon", "pogoapi_net", featured_pokemon)
                community_days_list.append({
                    "event_id": event_id,
                    "name": cd_name,
                    "date": cd_date,
                    "featured_pokemon": featured_pokemon
                })

        # Build Raid Bosses / Max Battles / Quests -- cut over to the generic
        # engine (Task 20), via extract_transformed_records() rather than
        # run_source(). All three are single-source domains (pokemon_go_api is
        # their only source -- there is no cross-source claim to arbitrate),
        # and raid_bosses/max_battles need a COMPOSITE (tier, pokemon_id)
        # identity that run_source()'s single static entity_id_prefix cannot
        # express (the same pokemon_id can appear in more than one tier at
        # once, e.g. as both a mega and a tier-5 boss). Building the composite
        # entity_id here, from each record's own `tier` field (injected by
        # the templates' key_becomes_field) and `pokemon_id`, keeps that
        # composite-key logic in caller-owned code without inventing new
        # entity_id_prefix templating syntax for a domain that doesn't need
        # cross-source arbitration in the first place. See
        # config/source_templates/pokemon_go_api_raidboss.yml's comment for
        # the full reasoning.
        raid_boss_records = extract_transformed_records(
            "pokemon_go_api_raidboss", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        raid_bosses_list = []
        for r in raid_boss_records:
            entity_id = f"raid_boss_{r.get('tier')}_{r.get('pokemon_id')}"
            for attr in ("name", "form", "costume", "min_cp", "max_cp", "min_boosted_cp",
                         "max_boosted_cp", "shiny_available", "image_url", "shiny_image_url"):
                self.emit_claim(entity_id, attr, "pokemon_go_api", r.get(attr))
            raid_bosses_list.append({
                "tier": str(r.get("tier")),
                "pokemon_id": r.get("pokemon_id"),
                "name": r.get("name"),
                "form": r.get("form"),
                "costume": r.get("costume"),
                "min_cp": r.get("min_cp"),
                "max_cp": r.get("max_cp"),
                "min_boosted_cp": r.get("min_boosted_cp"),
                "max_boosted_cp": r.get("max_boosted_cp"),
                "shiny_available": r.get("shiny_available", False),
                "image_url": r.get("image_url"),
                "shiny_image_url": r.get("shiny_image_url"),
            })

        max_battle_records = extract_transformed_records(
            "pokemon_go_api_maxbattles", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        max_battles_list = []
        for r in max_battle_records:
            entity_id = f"max_battle_{r.get('tier')}_{r.get('pokemon_id')}"
            for attr in ("name", "form", "costume", "max_particles_cost", "shiny_available",
                         "image_url", "shiny_image_url"):
                self.emit_claim(entity_id, attr, "pokemon_go_api", r.get(attr))
            max_battles_list.append({
                "tier": str(r.get("tier")),
                "pokemon_id": r.get("pokemon_id"),
                "name": r.get("name"),
                "form": r.get("form"),
                "costume": r.get("costume"),
                "max_particles_cost": r.get("max_particles_cost"),
                "shiny_available": r.get("shiny_available", False),
                "image_url": r.get("image_url"),
                "shiny_image_url": r.get("shiny_image_url"),
            })

        # quests has a simple (non-composite) identity, so it could go through
        # run_source()'s ledger like species/forms/moves -- read the same way
        # as its raid_bosses/max_battles siblings anyway for consistency (all
        # three single-source pokemon_go_api domains built identically here).
        # Expect 0 rows against the real snapshot: upstream quests.json is
        # currently an empty list (confirmed pre-existing in KNOWN_ISSUES.md,
        # not a bug from this cutover) -- see
        # tests/test_pokemon_go_api_single_source_domains.py for coverage
        # against a synthetic non-empty fixture.
        quest_records = extract_transformed_records(
            "pokemon_go_api_quests", raw_dumps_dir=self.raw_dumps_dir, templates_dir=Path("config/source_templates")
        )
        quests_list = []
        for r in quest_records:
            quest_id = str(r.get("quest_id") or "")
            reward_detail = json.dumps(r.get("reward_detail")) if r.get("reward_detail") is not None else None
            entity_id = f"quest_{quest_id}"
            self.emit_claim(entity_id, "type", "pokemon_go_api", r.get("type"))
            self.emit_claim(entity_id, "text", "pokemon_go_api", r.get("text"))
            self.emit_claim(entity_id, "target", "pokemon_go_api", r.get("target"))
            self.emit_claim(entity_id, "reward_type", "pokemon_go_api", r.get("reward_type"))
            self.emit_claim(entity_id, "reward_detail", "pokemon_go_api", reward_detail)
            quests_list.append({
                "quest_id": quest_id,
                "type": r.get("type"),
                "text": r.get("text"),
                "target": r.get("target"),
                "reward_type": r.get("reward_type"),
                "reward_detail": reward_detail,
            })

        # Build Regional Species
        regional_species_list = []
        if isinstance(alolan_raw, dict):
            for name, d in alolan_raw.items():
                dex_number = d if isinstance(d, int) else None
                entity_id = f"regional_species_{name}"
                self.emit_claim(entity_id, "dex_number", "pogoapi_net", dex_number)
                self.emit_claim(entity_id, "region", "pogoapi_net", "Alola")
                regional_species_list.append({"dex_number": dex_number, "name": name, "region": "Alola"})
        if isinstance(galarian_raw, dict):
            for name, d in galarian_raw.items():
                dex_number = d if isinstance(d, int) else None
                entity_id = f"regional_species_{name}"
                self.emit_claim(entity_id, "dex_number", "pogoapi_net", dex_number)
                self.emit_claim(entity_id, "region", "pogoapi_net", "Galar")
                regional_species_list.append({"dex_number": dex_number, "name": name, "region": "Galar"})

        # Build Nesting Species
        nesting_species_list = []
        if isinstance(nesting_raw, dict):
            for name, d in nesting_raw.items():
                dex_number = d if isinstance(d, int) else None
                entity_id = f"nesting_species_{name}"
                self.emit_claim(entity_id, "dex_number", "pogoapi_net", dex_number)
                self.emit_claim(entity_id, "is_nesting", "pogoapi_net", True)
                nesting_species_list.append({"dex_number": dex_number, "name": name, "is_nesting": True})

        # Build Baby Species
        baby_species_list = []
        if isinstance(baby_raw, list):
            for item in baby_raw:
                if isinstance(item, dict):
                    dex_number = item.get("id")
                    baby_name = item.get("name")
                    baby_form = item.get("form")
                    entity_id = f"baby_species_{baby_name or item.get('id')}"
                    self.emit_claim(entity_id, "dex_number", "pogoapi_net", dex_number)
                    self.emit_claim(entity_id, "form", "pogoapi_net", baby_form)
                    self.emit_claim(entity_id, "is_baby", "pogoapi_net", True)
                    baby_species_list.append({"dex_number": dex_number, "name": baby_name, "form": baby_form, "is_baby": True})
        elif isinstance(baby_raw, dict):
            for name, d in baby_raw.items():
                dex_number = d if isinstance(d, int) else None
                entity_id = f"baby_species_{name}"
                self.emit_claim(entity_id, "dex_number", "pogoapi_net", dex_number)
                self.emit_claim(entity_id, "is_baby", "pogoapi_net", True)
                baby_species_list.append({"dex_number": dex_number, "name": name, "is_baby": True})

        # Build Shadow Species
        shadow_species_list = []
        if isinstance(shadow_raw, dict):
            for name, info in shadow_raw.items():
                d = info.get("pokemon_id") if isinstance(info, dict) else info
                dex_number = d if isinstance(d, int) else None
                entity_id = f"shadow_species_{name}"
                self.emit_claim(entity_id, "dex_number", "pogoapi_net", dex_number)
                self.emit_claim(entity_id, "is_shadow", "pogoapi_net", True)
                shadow_species_list.append({"dex_number": dex_number, "name": name, "is_shadow": True})

        # Build Mega Species
        mega_species_list = []
        if isinstance(mega_raw, list):
            for item in mega_raw:
                if isinstance(item, dict):
                    dex_number = item.get("pokemon_id") or item.get("id")
                    mega_species_name = item.get("pokemon_name") or item.get("name")
                    mega_name = item.get("mega_name")
                    first_evolution_energy = item.get("first_time_mega_energy_required") or item.get("first_evolution_energy")
                    subsequent_evolution_energy = item.get("mega_energy_required") or item.get("subsequent_evolution_energy")
                    entity_id = f"mega_species_{mega_species_name}"
                    self.emit_claim(entity_id, "dex_number", "pogoapi_net", dex_number)
                    self.emit_claim(entity_id, "mega_name", "pogoapi_net", mega_name)
                    self.emit_claim(entity_id, "first_evolution_energy", "pogoapi_net", first_evolution_energy)
                    self.emit_claim(entity_id, "subsequent_evolution_energy", "pogoapi_net", subsequent_evolution_energy)
                    mega_species_list.append({
                        "dex_number": dex_number,
                        "name": mega_species_name,
                        "mega_name": mega_name,
                        "first_evolution_energy": first_evolution_energy,
                        "subsequent_evolution_energy": subsequent_evolution_energy
                    })
        elif isinstance(mega_raw, dict):
            for name, info in mega_raw.items():
                if isinstance(info, dict):
                    dex_number = info.get("pokemon_id")
                    mega_name = info.get("mega_name")
                    first_evolution_energy = info.get("first_evolution_energy")
                    subsequent_evolution_energy = info.get("subsequent_evolution_energy")
                    entity_id = f"mega_species_{name}"
                    self.emit_claim(entity_id, "dex_number", "pogoapi_net", dex_number)
                    self.emit_claim(entity_id, "mega_name", "pogoapi_net", mega_name)
                    self.emit_claim(entity_id, "first_evolution_energy", "pogoapi_net", first_evolution_energy)
                    self.emit_claim(entity_id, "subsequent_evolution_energy", "pogoapi_net", subsequent_evolution_energy)
                    mega_species_list.append({
                        "dex_number": dex_number,
                        "name": name,
                        "mega_name": mega_name,
                        "first_evolution_energy": first_evolution_energy,
                        "subsequent_evolution_energy": subsequent_evolution_energy
                    })

        # Build Badges
        # entity_id/emit_claim calls removed here (Task 18 cutover) -- claims are now
        # emitted via run_source("pogoapi_net_badges", ...) above. badges_list itself
        # stays hand-built directly from badges_raw (not from the ledger) because the
        # "badges" canonical table is one row per raw record (597), not one row per
        # deduplicated entity (184 unique names once dated event-badge variants
        # collapse) -- see the pogoapi_net_badges.yml template's needs_review note and
        # task-18-report.md for why the generic engine's entity-deduplicated claims
        # model can't reproduce this table's row count.
        badges_list = []
        if isinstance(badges_raw, list):
            for item in badges_raw:
                if isinstance(item, dict):
                    badge_id = str(item.get("id") or item.get("name"))
                    name = item.get("name")
                    is_event = bool(item.get("event_badge", False))
                    description = item.get("description")
                    rank = item.get("rank")
                    targets = json.dumps(item.get("targets")) if item.get("targets") is not None else None
                    badges_list.append({
                        "badge_id": badge_id, "name": name, "is_event_badge": is_event,
                        "description": description, "rank": rank, "targets": targets,
                    })
        elif isinstance(badges_raw, dict):
            for b_id, b_info in badges_raw.items():
                if isinstance(b_info, dict):
                    name = b_info.get("name")
                    is_event = bool(b_info.get("event_badge", False))
                    description = b_info.get("description")
                    rank = b_info.get("rank")
                    targets = json.dumps(b_info.get("targets")) if b_info.get("targets") is not None else None
                    badges_list.append({
                        "badge_id": str(b_id), "name": name, "is_event_badge": is_event,
                        "description": description, "rank": rank, "targets": targets,
                    })

        resolved = self.resolve_all_claims()

        # Build PvP Leagues -- read back from `resolved` instead of hand-parsing
        # pvpoke_raw (Task 19 cutover). The distinct set of league entity_ids to
        # iterate comes from pvpoke_formats_claims (collected earlier from the
        # templated run_source("pvpoke_formats", ...) call), preserving first-seen
        # order and dedup'd, since `resolved` itself is an unordered dict keyed by
        # (entity_id, attribute) pair with no standalone list of known entities.
        pvp_league_entity_ids = []
        seen_league_entities = set()
        for claim in pvpoke_formats_claims:
            if claim["entity_id"] not in seen_league_entities:
                seen_league_entities.add(claim["entity_id"])
                pvp_league_entity_ids.append(claim["entity_id"])

        pvp_leagues_list = []
        for entity_id in pvp_league_entity_ids:
            league_id = entity_id[len("pvp_league_"):]
            pvp_leagues_list.append({
                "league_id": league_id,
                "cp_limit": resolved.get((entity_id, "cp_limit")),
                "meta": resolved.get((entity_id, "meta")),
            })

        # resolve_all_claims() re-resolves every (entity_id, attribute) pair present in the
        # ledger, including ones a pre-existing ad hoc call site (e.g. the base-stats loop
        # above) already resolved and logged via resolve_attribute_claim() directly. Both
        # call sites resolve the identical claim set, so they produce identical discrepancy
        # entries for the same pair -- dedupe here rather than removing either call site, so
        # neither one has to duplicate resolve_attribute_claim()'s priority/tie-break policy.
        seen_discrepancy_keys = set()
        deduped_discrepancies = []
        for d in self.discrepancies:
            key = (d["entity_id"], d["attribute"])
            if key in seen_discrepancy_keys:
                continue
            seen_discrepancy_keys.add(key)
            deduped_discrepancies.append(d)
        self.discrepancies = deduped_discrepancies

        for sp in species_list:
            entity_id = f"pokemon_dex_{sp['dex_number']}"
            for attr in ("name", "generation", "can_mega_evolve", "can_gigantamax",
                         "buddy_distance_km", "base_attack", "base_defense",
                         "base_stamina", "max_cp_lvl40"):
                key = (entity_id, attr)
                if key in resolved:
                    sp[attr if attr != "generation" else "gen"] = resolved[key]
            # primary_type_raw/secondary_type_raw (templated, raw "POKEMON_TYPE_x"
            # strings -- see pokemon_go_api_pokedex.yml's comment on why `types`
            # itself isn't a single field_mappings entry) are combined into the
            # canonical `types` display list here, the one place that consumes
            # them, rather than left as an inert claim nothing reads back.
            primary_raw = resolved.get((entity_id, "primary_type_raw"))
            secondary_raw = resolved.get((entity_id, "secondary_type_raw"))
            combined_types = [
                t.replace("POKEMON_TYPE_", "").capitalize()
                for t in (primary_raw, secondary_raw) if t
            ]
            if combined_types:
                sp["types"] = combined_types

        for f in forms_list:
            if f["form_name"] != "Standard":
                continue  # only the Standard form emits shadow/shiny claims today (Task 6, Step 5)
            entity_id = f"pokemon_dex_{f['dex_number']}_form_standard"
            for attr in ("shadow_available", "shiny_available"):
                key = (entity_id, attr)
                if key in resolved:
                    f[attr] = resolved[key]

        # Non-Standard forms (assetForms/regionForms, via sub_records -- Task 20):
        # one row per distinct entity_id the templated engine produced, built
        # entirely from `resolved` plus the species-level context captured
        # above. This is where the Frillish dedup actually surfaces: two
        # different upstream fields describing the same real variant landed on
        # the SAME entity_id (see pokemon_go_api_pokedex.yml), so this loop
        # naturally produces exactly one row per real-world variant.
        for entity_id in non_standard_form_entity_ids:
            dex_number = resolved.get((entity_id, "dex_number"))
            context = species_context_by_dex.get(dex_number, {})
            # local_authoring costume-lookup join (Task 23): this form's own
            # costume_name (a raw token like "FASHION_2021_NOEVOLVE") is looked
            # up against the costume_token_<token> claims local_authoring
            # contributed above -- an additive enrichment field, not a
            # replacement for costume_name (see FormModel.costume_display_name
            # docstring for why). None whenever there's no costume token at
            # all, or the token has no curated (non-empty) entry yet.
            costume_token = resolved.get((entity_id, "costume_name"))
            costume_display_name = (
                resolved.get((f"costume_token_{costume_token}", "display_name"))
                if costume_token else None
            )
            forms_list.append({
                "slug": entity_id,
                "species_slug": context.get("species_slug"),
                "dex_number": dex_number,
                "form_name": resolved.get((entity_id, "form_name")),
                "costume_name": costume_token,
                "costume_display_name": costume_display_name,
                "gender": resolved.get((entity_id, "gender"), "unknown"),
                "shiny_available": context.get("shiny_available"),
                "shiny_release_date": context.get("shiny_release_date"),
                "shadow_available": False,
                "buddy_distance_km": context.get("buddy_distance_km"),
                "base_attack": context.get("base_attack"),
                "base_defense": context.get("base_defense"),
                "base_stamina": context.get("base_stamina"),
                "max_cp_lvl40": context.get("max_cp_lvl40"),
                "image_url": resolved.get((entity_id, "image_url")),
                "shiny_image_url": resolved.get((entity_id, "shiny_image_url")),
            })

        for mv in moves_list:
            entity_id = f"move_{mv['move_id']}"
            # type/pve_power/pve_energy_delta (Task 22): now genuinely
            # contested between pogoapi_net and alexelgt_game_masters (see
            # the fast/charged-moves loop above); alexelgt wins per
            # TRUST_HIERARCHY whenever its move-name join found a match.
            for attr in ("type", "pve_power", "pve_energy_delta", "pvp_power", "pvp_energy_cost", "pvp_cooldown_turns", "stat_buffs"):
                key = (entity_id, attr)
                if key in resolved:
                    mv[attr] = resolved[key]

        return {
            "species": species_list,
            "forms": forms_list,
            "moves": moves_list,
            "progression": progression_list,
            "type_effectiveness": type_effectiveness_list,
            "weather_boosts": weather_boosts_list,
            "community_days": community_days_list,
            "raid_bosses": raid_bosses_list,
            "max_battles": max_battles_list,
            "quests": quests_list,
            "regional_species": regional_species_list,
            "nesting_species": nesting_species_list,
            "baby_species": baby_species_list,
            "shadow_species": shadow_species_list,
            "mega_species": mega_species_list,
            "badges": badges_list,
            "pvp_leagues": pvp_leagues_list,
            "items": gm_items,
            "stickers": gm_stickers,
            "avatar_items": gm_avatars,
            "friendship_levels": gm_friendship,
            "encounter_settings": gm_encounters,
            "game_master_templates": gm_raw_templates,
            "discrepancies": self.discrepancies,
            "_claims_ledger": self.claims_ledger
        }

    def compute_and_record_diffs(
        self,
        con: duckdb.DuckDBPyConnection,
        canonical_data: Dict[str, Any]
    ) -> int:
        """Snapshot Change / Diff Engine: Compares new canonical claims against Master DB state.

        Detects attribute modifications and records historical changes into `change_history`.

        Args:
            con: Open DuckDB connection to Master DB.
            canonical_data: Newly resolved canonical datasets dictionary.

        Returns:
            Number of change records appended to `change_history`.
        """
        con.execute("""
            CREATE TABLE IF NOT EXISTS change_history (
                timestamp VARCHAR,
                entity_id VARCHAR,
                attribute VARCHAR,
                old_value VARCHAR,
                new_value VARCHAR,
                source_key VARCHAR
            )
        """)

        existing_tables = [row[0] for row in con.execute("SHOW TABLES").fetchall()]
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        diff_records: List[Tuple[str, str, str, str, str, str]] = []

        domain_keys = {
            "species": "slug",
            "forms": "slug",
            "moves": "move_id",
            "progression": "level",
            "weather_boosts": "weather",
            "community_days": "event_id"
        }

        for domain, key_attr in domain_keys.items():
            if domain not in existing_tables:
                continue

            try:
                existing_rows = con.execute(f'SELECT * FROM "{domain}"').fetchall()
                cols = [col[0] for col in con.execute(f'DESCRIBE "{domain}"').fetchall()]
                if not cols or key_attr not in cols:
                    continue

                key_idx = cols.index(key_attr)
                existing_map = {}
                for row in existing_rows:
                    k = str(row[key_idx])
                    existing_map[k] = dict(zip(cols, row))

                new_rows = canonical_data.get(domain, [])
                for new_item in new_rows:
                    entity_key = str(new_item.get(key_attr))
                    entity_id = f"{domain}:{entity_key}"

                    if entity_key in existing_map:
                        old_item = existing_map[entity_key]
                        for attr, new_val in new_item.items():
                            if attr == key_attr:
                                continue
                            old_val = old_item.get(attr)

                            str_old = json.dumps(old_val, sort_keys=True) if isinstance(old_val, (list, dict)) else str(old_val) if old_val is not None else None
                            str_new = json.dumps(new_val, sort_keys=True) if isinstance(new_val, (list, dict)) else str(new_val) if new_val is not None else None

                            if str_old != str_new and (str_old is not None or str_new is not None):
                                diff_records.append((
                                    timestamp,
                                    entity_id,
                                    attr,
                                    str_old if str_old is not None else "",
                                    str_new if str_new is not None else "",
                                    "GoRefsMasterEngine"
                                ))
                    else:
                        diff_records.append((
                            timestamp,
                            entity_id,
                            "entity_created",
                            "",
                            entity_key,
                            "GoRefsMasterEngine"
                        ))
            except Exception as ex:
                print(f"Warning computing snapshot diff for domain '{domain}': {ex}")

        if diff_records:
            df_diff = pd.DataFrame(diff_records, columns=["timestamp", "entity_id", "attribute", "old_value", "new_value", "source_key"])
            con.register("tmp_diff_df", df_diff)
            con.execute("INSERT INTO change_history SELECT * FROM tmp_diff_df")
            con.unregister("tmp_diff_df")

        return len(diff_records)

    def write_master_duckdb(self, canonical_data: Dict[str, Any]) -> int:
        """Writes canonical domain datasets into `output/GoRefs_Master.duckdb`.

        Purges all source-prefixed raw exploration tables so that `GoRefs_Master.duckdb`
        contains ONLY clean normalized tables named by what the data IS.

        Args:
            canonical_data: Resolved canonical dataset dictionary.

        Returns:
            Total canonical table rows written.
        """
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        con = duckdb.connect(str(self.db_path))

        # 1. Purge all legacy source-prefixed tables to keep database 100% normalized
        all_existing_tables = [row[0] for row in con.execute("SHOW TABLES").fetchall()]
        for tbl in all_existing_tables:
            if any(tbl.startswith(prefix) for prefix in ("gm_", "pogoapi_net_", "pokemon_go_api_", "pvpoke_", "pokeapi_", "rplus_shiny_", "local_authoring_")) or tbl in ("schema_inventory", "import_errors", "raw_json", "templates"):
                con.execute(f'DROP TABLE IF EXISTS "{tbl}"')

        # 2. Compute and record diffs against existing state
        diff_count = self.compute_and_record_diffs(con, canonical_data)

        # 3. Write normalized domain tables
        tables_to_write = [
            ("species", canonical_data.get("species", [])),
            ("forms", canonical_data.get("forms", [])),
            ("moves", canonical_data.get("moves", [])),
            ("progression", canonical_data.get("progression", [])),
            ("type_effectiveness", canonical_data.get("type_effectiveness", [])),
            ("weather_boosts", canonical_data.get("weather_boosts", [])),
            ("community_days", canonical_data.get("community_days", [])),
            ("raid_bosses", canonical_data.get("raid_bosses", [])),
            ("max_battles", canonical_data.get("max_battles", [])),
            ("quests", canonical_data.get("quests", [])),
            ("regional_species", canonical_data.get("regional_species", [])),
            ("nesting_species", canonical_data.get("nesting_species", [])),
            ("baby_species", canonical_data.get("baby_species", [])),
            ("shadow_species", canonical_data.get("shadow_species", [])),
            ("mega_species", canonical_data.get("mega_species", [])),
            ("badges", canonical_data.get("badges", [])),
            ("pvp_leagues", canonical_data.get("pvp_leagues", [])),
            ("items", canonical_data.get("items", [])),
            ("stickers", canonical_data.get("stickers", [])),
            ("avatar_items", canonical_data.get("avatar_items", [])),
            ("friendship_levels", canonical_data.get("friendship_levels", [])),
            ("encounter_settings", canonical_data.get("encounter_settings", [])),
            ("game_master_templates", canonical_data.get("game_master_templates", [])),
            ("discrepancies", canonical_data.get("discrepancies", [])),
            ("_claims_ledger", [
                {**claim, "value": claim["value"] if isinstance(claim["value"], str) else str(claim["value"])}
                for claim in canonical_data.get("_claims_ledger", [])
            ])
        ]

        # Default schemas for tables if empty
        default_schemas = {
            "raid_bosses": "tier VARCHAR, pokemon_id VARCHAR, name VARCHAR, form VARCHAR, costume VARCHAR, min_cp INT, max_cp INT, min_boosted_cp INT, max_boosted_cp INT, shiny_available BOOLEAN, image_url VARCHAR, shiny_image_url VARCHAR",
            "max_battles": "tier VARCHAR, pokemon_id VARCHAR, name VARCHAR, form VARCHAR, costume VARCHAR, max_particles_cost INT, shiny_available BOOLEAN, image_url VARCHAR, shiny_image_url VARCHAR",
            "quests": "quest_id VARCHAR, type VARCHAR, text VARCHAR, target INT, reward_type VARCHAR, reward_detail VARCHAR",
            "baby_species": "dex_number INT, name VARCHAR, form VARCHAR, is_baby BOOLEAN",
            "mega_species": "dex_number INT, name VARCHAR, mega_name VARCHAR, first_evolution_energy INT, subsequent_evolution_energy INT",
            "badges": "badge_id VARCHAR, name VARCHAR, is_event_badge BOOLEAN, description VARCHAR, rank INT, targets VARCHAR",
            "discrepancies": "entity_id VARCHAR, attribute VARCHAR, resolved_value VARCHAR, winning_source VARCHAR, claims VARCHAR",
            "_claims_ledger": "entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT"
        }

        total_rows = 0
        for tbl_name, data_list in tables_to_write:
            con.execute(f'DROP TABLE IF EXISTS "{tbl_name}"')
            if data_list:
                df = pd.DataFrame(data_list)
                con.register("tmp_tbl_df", df)
                con.execute(f'CREATE TABLE "{tbl_name}" AS SELECT * FROM tmp_tbl_df')
                con.unregister("tmp_tbl_df")
                total_rows += len(df)
            else:
                schema_def = default_schemas.get(tbl_name, "id VARCHAR")
                con.execute(f'CREATE TABLE "{tbl_name}" ({schema_def})')

        con.close()
        return total_rows

    def build_all(self) -> Dict[str, int]:
        """Runs the complete GoRefs build pipeline.

        1. Collects raw claims across all 7 sources and resolves canonical datasets.
        2. Compares changes against existing state and updates `change_history` table.
        3. Writes normalized domain tables to `output/GoRefs_Master.duckdb` (purging source prefixes).
        4. Dynamically updates `README.md` statistics.

        Returns:
            Summary count statistics dictionary.
        """
        print("=" * 70)
        print(f"GoRefsMasterEngine: Building Normalized Master Database -> '{self.db_path}'")
        print("=" * 70)

        # 1. Collect & resolve canonical datasets across 7 sources
        print("Collecting raw claims and resolving canonical datasets across 7 sources...")
        canonical = self.collect_and_resolve_claims()

        # 2. Write normalized domain datasets into GoRefs_Master.duckdb with change_history diffs
        self.write_master_duckdb(canonical)

        counts = {
            "species": len(canonical.get("species", [])),
            "forms": len(canonical.get("forms", [])),
            "moves": len(canonical.get("moves", [])),
            "progression": len(canonical.get("progression", [])),
            "type_effectiveness": len(canonical.get("type_effectiveness", [])),
            "weather_boosts": len(canonical.get("weather_boosts", [])),
            "community_days": len(canonical.get("community_days", []))
        }

        # 3. Update README.md statistics
        update_readme_counts(counts)

        print(f"Build Complete: {counts['species']} species, {counts['forms']} forms, {counts['moves']} moves, "
              f"{len(canonical.get('discrepancies', []))} field discrepancies logged.")
        print("=" * 70)
        return counts

    def export_parquet(self, db_path: Path, output_dir: Path) -> List[str]:
        """Exports every canonical (non-internal) table to Parquet for remote/WASM consumption.

        Skips internal tables (prefixed with "_", e.g. "_claims_ledger") -- only the
        stable canonical domain tables need a browser-remote-read path.

        Clears any stale .parquet files from prior builds to ensure full rebuild semantics.

        Args:
            db_path: Path to the built GoRefs_Master.duckdb file.
            output_dir: Directory under which "parquet/" is created.

        Returns:
            List of table names exported.

        Raises:
            FileNotFoundError: If db_path does not exist.
        """
        if not db_path.exists():
            raise FileNotFoundError(f"Database file not found: {db_path}")

        parquet_dir = output_dir / "parquet"
        parquet_dir.mkdir(parents=True, exist_ok=True)

        # Clear stale .parquet files from prior builds to ensure full rebuild semantics
        for f in parquet_dir.glob("*.parquet"):
            f.unlink()

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

    def build(self) -> Dict[str, int]:
        """Alias for build_all to run the full build pipeline.

        Returns:
            Summary count statistics dictionary.
        """
        return self.build_all()


def build_canonical_dataset(raw_dumps_dir: Path = Path("raw_dumps"), output_dir: Path = Path("output")):
    """Wrapper function entry point for building the Master dataset.

    Args:
        raw_dumps_dir: Raw dumps directory path.
        output_dir: Output directory path.
    """
    engine = GoRefsMasterEngine(raw_dumps_dir=raw_dumps_dir, output_dir=output_dir)
    engine.build_all()


if __name__ == "__main__":
    build_canonical_dataset()
