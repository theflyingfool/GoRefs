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


def test_run_source_returns_empty_list_for_missing_template():
    claims = run_source(
        "does_not_exist",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )
    assert claims == []


def test_run_source_overrides_win_over_field_mappings_for_same_attribute():
    claims = run_source(
        "fixture_source_overrides",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )
    entity_1_claims = {c["attribute"]: c["value"] for c in claims if c["entity_id"] == "fixture_source_1"}
    # field_mappings says power comes from "power" (40); overrides says power comes from "name" ("Tackle").
    # overrides must win.
    assert entity_1_claims["power"] == "Tackle"


def test_run_source_without_entity_id_prefix_uses_actual_source_key():
    # Regression guard: templates written before entity_id_prefix existed (and any
    # template that simply doesn't set it) must keep namespacing entity_id under
    # actual_source_key, unchanged from before this field was introduced.
    claims = run_source(
        "fixture_source",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )
    entity_ids = {c["entity_id"] for c in claims}
    assert entity_ids == {"fixture_source_1", "fixture_source_2"}


def test_run_source_entity_id_prefix_overrides_source_key_for_entity_id_only():
    claims = run_source(
        "fixture_source_prefixed",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )
    assert claims  # sanity: fixture actually produced claims
    entity_ids = {c["entity_id"] for c in claims}
    assert entity_ids == {"custom_prefix_1", "custom_prefix_2"}
    # "source" and priority must still reflect the real source key, not the prefix.
    for c in claims:
        assert c["source"] == "fixture_source"
        assert "priority" in c


def test_run_source_identity_field_resolves_via_field_mappings_transform():
    """Task 22: pokemonSettings has no direct dex-number field -- identity_field
    "dex_number" only exists as an `overrides` entry (regex_extract on the
    injected templateId, see fixture_gm_pokemon_settings.yml). Before this task,
    run_source()'s raw_id = record.get(identity_field) was a plain dict lookup
    that never consulted field_mappings/overrides at all, so a transform-derived
    identity_field had nothing to read and every claim was silently dropped.
    """
    claims = run_source(
        "fixture_gm_pokemon_settings",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )
    entity_ids = {c["entity_id"] for c in claims}
    assert entity_ids == {"pokemon_dex_1", "pokemon_dex_222"}
    bulbasaur_claims = {c["attribute"]: c["value"] for c in claims if c["entity_id"] == "pokemon_dex_1"}
    assert bulbasaur_claims["base_attack"] == 118


def test_run_source_identity_field_plain_lookup_still_works_when_no_mapping_exists():
    # Regression guard: every pre-existing template (identity_field with no
    # matching field_mappings/overrides key at all) must keep using the plain
    # record.get(identity_field) lookup, unaffected by the transform-aware path.
    claims = run_source(
        "fixture_source",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )
    entity_ids = {c["entity_id"] for c in claims}
    assert entity_ids == {"fixture_source_1", "fixture_source_2"}


def test_run_source_emits_gender_claim_when_gender_signals_present():
    claims = run_source(
        "fixture_source_gender",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )
    gender_claims = {c["entity_id"]: c["value"] for c in claims if c["attribute"] == "gender"}
    assert gender_claims == {
        "fixture_source_gender_1": "female",
        "fixture_source_gender_2": "unknown",
    }
