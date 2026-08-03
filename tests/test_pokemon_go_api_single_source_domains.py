"""Tests for extract_transformed_records() against the pokemon_go_api
raid_bosses/max_battles/quests templates (Task 20).

These three domains have exactly one source (pokemon_go_api) and no
cross-source arbitration to do, and raid_bosses/max_battles need a composite
(tier, id) identity that run_source()'s single entity_id_prefix cannot express
-- so they're read via engine.extract_transformed_records() instead of
run_source(), per Task 20's design decision. Uses the REAL templates in
config/source_templates/ (curated by hand from the profiler's drafts) against
small synthetic fixtures, since quests' real upstream snapshot is currently
empty (confirmed pre-existing in KNOWN_ISSUES.md) and maxbattles' real
snapshot has no active rotation right now either.
"""
from pathlib import Path

from src.engine import extract_transformed_records

FIXTURES = Path(__file__).parent / "fixtures"
REAL_TEMPLATES = Path("config/source_templates")


def test_quests_template_extracts_records_from_a_synthetic_non_empty_fixture():
    records = extract_transformed_records(
        "pokemon_go_api_quests",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=REAL_TEMPLATES,
    )
    assert records == [{
        "quest_id": "Q1",
        "type": "catch",
        "text": "Catch 5 Pokemon",
        "target": 5,
        "reward_type": "stardust",
        "reward_detail": {"amount": 500},
    }]


def test_raidboss_template_injects_tier_via_key_becomes_field():
    records = extract_transformed_records(
        "pokemon_go_api_raidboss",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=REAL_TEMPLATES,
    )
    by_id = {r["pokemon_id"]: r for r in records}
    assert by_id["KYUREM"]["tier"] == "lvl5"
    assert by_id["KYUREM"]["min_cp"] == 1957
    assert by_id["KYUREM"]["max_cp"] == 2042
    assert by_id["KYUREM"]["min_boosted_cp"] == 2446
    assert by_id["AGGRON"]["tier"] == "mega"
    # AGGRON's fixture has no cpRangeBoost at all -- list_index must not emit a
    # spurious None/absent-key crash, it should simply not appear.
    assert "min_boosted_cp" not in by_id["AGGRON"]


def test_raidboss_composite_identity_distinguishes_same_pokemon_across_tiers():
    # The real bug this test guards: run_source()'s single entity_id_prefix
    # cannot express (tier, id) -- two raid tiers featuring the same species id
    # would collide onto one entity_id and silently lose a row. Verify the
    # tier+pokemon_id pairs extracted here are both present and distinct.
    records = extract_transformed_records(
        "pokemon_go_api_raidboss",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=REAL_TEMPLATES,
    )
    composite_keys = {(r["tier"], r["pokemon_id"]) for r in records}
    assert composite_keys == {("lvl5", "KYUREM"), ("mega", "AGGRON")}


def test_maxbattles_template_extracts_max_particles_cost():
    records = extract_transformed_records(
        "pokemon_go_api_maxbattles",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=REAL_TEMPLATES,
    )
    assert len(records) == 1
    r = records[0]
    assert r["tier"] == "maxlvl3"
    assert r["pokemon_id"] == "MACHAMP"
    assert r["max_particles_cost"] == 8000
    assert r["shiny_available"] is False
    assert "shiny_image_url" not in r  # null in the fixture -- must not appear as None
