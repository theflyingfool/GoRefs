"""Task 22 regression test: alexelgt_game_masters cutover to the generic engine.

Runs the real templates against the real raw_dumps/alexelgt_game_masters snapshot
(not a synthetic fixture) -- the specific thing this task must prove is that dex
222's base stats still resolve to alexelgt_game_masters's values once this source
is engine-driven, matching the pre-cutover hand-parsed behavior exactly (see
game_master_pokemon_settings.yml's comment for why dex 222 specifically: it's
GAME_MASTER's clearest real example of the multiple-pokemonSettings-records-per-
dex collision this cutover has to replicate legacy's last-record-wins semantics
for, not the ledger resolver's own first-wins tie-break).
"""
from pathlib import Path

import duckdb

from src.engine import run_source

RAW_DUMPS = Path("raw_dumps")
TEMPLATES = Path("config/source_templates")
DB_PATH = Path("output/GoRefs_Master.duckdb")


def _collapse_last_claim_per_entity_attribute(claims):
    """Mirrors builder.py's collect_and_resolve_claims() collapse step."""
    last = {}
    for claim in claims:
        last[(claim["entity_id"], claim["attribute"])] = claim
    return last


def test_dex_222_base_stats_resolve_to_alexelgt_game_masters_values():
    claims = run_source("game_master_pokemon_settings", raw_dumps_dir=RAW_DUMPS, templates_dir=TEMPLATES)
    assert claims, "game_master_pokemon_settings produced no claims -- template or raw snapshot broken"

    last = _collapse_last_claim_per_entity_attribute(claims)
    resolved = {
        attribute: claim["value"]
        for (entity_id, attribute), claim in last.items()
        if entity_id == "pokemon_dex_222"
    }

    assert resolved["base_attack"] == 116
    assert resolved["base_defense"] == 182
    assert resolved["base_stamina"] == 155


def test_pokemon_settings_claims_land_on_pokemon_dex_entities():
    # entity_id_prefix: pokemon_dex must land species claims on the SAME
    # entity namespace pokemon_go_api's pokedex template already uses (Task
    # 20), not a "alexelgt_game_masters_<n>"-prefixed namespace nothing reads
    # back (the exact bug class Task 18's structural finding identified).
    claims = run_source("game_master_pokemon_settings", raw_dumps_dir=RAW_DUMPS, templates_dir=TEMPLATES)
    bulbasaur_claims = [c for c in claims if c["entity_id"] == "pokemon_dex_1"]
    assert bulbasaur_claims
    for c in bulbasaur_claims:
        assert c["source"] == "alexelgt_game_masters"
        assert c["priority"] == 2


def test_dex_222_canonical_species_row_matches_alexelgt_game_masters():
    """Exercises builder.py's actual collect_and_resolve_claims() collapse
    logic (not a local reimplementation, see the claim-level test above) by
    asserting against the real built database. This is the guard that would
    actually fail if the last-wins collapse were ever deleted from
    builder.py -- the claim-level test above only proves run_source() itself
    behaves correctly, not that builder.py wires it up right.
    """
    if not DB_PATH.exists():
        import pytest
        pytest.skip("output/GoRefs_Master.duckdb not built -- run `uv run go_refs.py --build` first")
    con = duckdb.connect(str(DB_PATH), read_only=True)
    row = con.execute(
        "select base_attack, base_defense, base_stamina from species where dex_number = 222"
    ).fetchone()
    assert row == (116, 182, 155)


def test_combat_move_claims_are_keyed_by_unique_id_not_numeric():
    claims = run_source("game_master_combat_move", raw_dumps_dir=RAW_DUMPS, templates_dir=TEMPLATES)
    assert claims
    wrap_claims = {c["attribute"]: c["value"] for c in claims if c["entity_id"] == "game_master_move_WRAP"}
    assert wrap_claims["type_raw"] == "POKEMON_TYPE_NORMAL"
    assert wrap_claims["power"] == 70.0
