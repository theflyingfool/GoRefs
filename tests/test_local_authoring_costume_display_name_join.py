"""Integration test for Task 23's local_authoring -> forms join.

costume-lookup.json's curated display names are only meaningful once joined
against real forms produced by pokemon_go_api_pokedex's sub_records (Task
20) -- costume tokens are shared strings, not per-entity identifiers, so this
test runs against the real raw_dumps/ snapshot (like
test_pokemon_go_api_frillish_cutover.py does) rather than a synthetic
fixture, to prove the join actually reaches real canonical output.
"""
from pathlib import Path

from src.builder import GoRefsMasterEngine


def test_curated_costume_token_reaches_forms_table():
    engine = GoRefsMasterEngine(raw_dumps_dir=Path("raw_dumps"))
    canonical = engine.collect_and_resolve_claims()

    # ANNIVERSARY is confirmed both (a) a real costume token carried by at
    # least one form's costume_name in the pokemon_go_api snapshot and (b) a
    # curated (non-empty) entry in costume-lookup.json ("Party hat").
    matches = [f for f in canonical["forms"] if f["costume_name"] == "ANNIVERSARY"]
    assert matches, "expected at least one real form with costume_name == 'ANNIVERSARY'"
    for f in matches:
        assert f["costume_display_name"] == "Party hat"


def test_uncurated_costume_token_leaves_display_name_none():
    engine = GoRefsMasterEngine(raw_dumps_dir=Path("raw_dumps"))
    canonical = engine.collect_and_resolve_claims()

    # ANNIVERSARY_2024 is confirmed present as a real costume token AND an
    # empty-string ("" = not yet curated) entry in costume-lookup.json.
    matches = [f for f in canonical["forms"] if f["costume_name"] == "ANNIVERSARY_2024"]
    assert matches, "expected at least one real form with costume_name == 'ANNIVERSARY_2024'"
    for f in matches:
        assert f["costume_display_name"] is None


def test_forms_with_no_costume_token_never_have_a_costume_display_name():
    # Note: form_name == "Standard" is NOT a safe proxy for "no costume" --
    # engine.apply_sub_records() also assigns "Standard" as the form_name for
    # a costume-ONLY assetForms/regionForms entry with no separate form of
    # its own (see engine.py's form_name_display fallback comment), so a
    # species' base row and a costume-only variant can both read
    # form_name == "Standard". costume_name is the actual signal to check.
    engine = GoRefsMasterEngine(raw_dumps_dir=Path("raw_dumps"))
    canonical = engine.collect_and_resolve_claims()

    no_costume_forms = [f for f in canonical["forms"] if f["costume_name"] is None]
    assert no_costume_forms
    assert all(f["costume_display_name"] is None for f in no_costume_forms)
