"""Tests for the `sub_records` template transform (Task 20).

This is new engine capability, discovered only once a real multi-nested source
(pokemon_go_api's pokedex.json, whose species records carry BOTH an `assetForms`
list AND a `regionForms` dict describing the same real-world gender/costume
variants inconsistently) is actually cut over. `sub_records` lets a template
declare one or more nested list/dict fields on a top-level record as additional
per-record sub-lists, each producing its own claim-set keyed by a normalized
identity (Task 12's `normalize_form_identity`) rather than a raw per-field
string -- so two different upstream representations of the same real variant
(e.g. `assetForms`'s `{"form": "FEMALE", "isFemale": false}` and
`regionForms`'s `"BLOOP_FEMALE"` key) collapse onto the SAME entity_id instead
of producing duplicate, inconsistently-tagged rows (the exact Frillish bug
documented in KNOWN_ISSUES.md).
"""
from pathlib import Path

from src.engine import run_source

FIXTURES = Path(__file__).parent / "fixtures"


def _run():
    return run_source(
        "fixture_source_subrecords",
        raw_dumps_dir=FIXTURES / "raw_dumps",
        templates_dir=FIXTURES / "source_templates",
    )


def test_sub_records_still_emits_parent_level_claims():
    claims = _run()
    name_claims = {c["entity_id"]: c["value"] for c in claims if c["attribute"] == "name"}
    assert name_claims == {"fixture_dex_1": "Bloop", "fixture_dex_2": "Squigglet"}


def test_sub_records_dedupes_the_same_real_variant_across_two_nested_fields():
    # entity 1's female variant is described BOTH by assetForms (form="FEMALE",
    # isFemale=False -- the unreliable flag) AND by regionForms's "BLOOP_FEMALE"
    # key. Both must resolve to exactly one form entity_id, not two.
    claims = _run()
    form_entity_ids = {c["entity_id"] for c in claims if "_form_" in c["entity_id"] and c["entity_id"].startswith("fixture_dex_1_")}
    assert len(form_entity_ids) == 1


def test_sub_records_resolves_gender_correctly_despite_unreliable_boolean_flag():
    claims = _run()
    form_gender_claims = {
        c["entity_id"]: c["value"]
        for c in claims
        if c["attribute"] == "gender" and c["entity_id"].startswith("fixture_dex_1_")
    }
    assert form_gender_claims and set(form_gender_claims.values()) == {"female"}


def test_sub_records_skips_the_placeholder_standard_entry_within_asset_forms():
    # assetForms's second entry for entity 1 (form=null, isFemale=false) carries
    # no identity information at all -- it's a placeholder for the base form,
    # which is handled separately (not via sub_records). It must not produce its
    # own spurious form entity.
    claims = _run()
    entity_1_form_ids = {c["entity_id"] for c in claims if c["entity_id"].startswith("fixture_dex_1_form_")}
    assert len(entity_1_form_ids) == 1


def test_sub_records_handles_a_record_with_no_gendered_variant():
    # entity 2 has one assetForms entry (a plain costume, no gender signal) and
    # an empty regionForms dict -- exactly one non-standard form entity, tagged
    # "unknown" gender, not "female".
    claims = _run()
    entity_2_form_claims = [c for c in claims if c["entity_id"].startswith("fixture_dex_2_form_")]
    entity_2_form_ids = {c["entity_id"] for c in entity_2_form_claims}
    assert len(entity_2_form_ids) == 1
    genders = {c["value"] for c in entity_2_form_claims if c["attribute"] == "gender"}
    assert genders == {"unknown"}
