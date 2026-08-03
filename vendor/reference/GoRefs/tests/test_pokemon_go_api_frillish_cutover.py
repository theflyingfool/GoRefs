"""Regression test for Task 20: the Frillish gender/dedup bug documented in
KNOWN_ISSUES.md section 1 must be fixed by construction once pokemon_go_api's
species/forms are cut over to the generic engine.

Before the cutover: Frillish (dex 592) produced duplicate, inconsistently
tagged rows -- one from regionForms ("Frillish (Female)"), one from
assetForms (`{"form": "FEMALE", "isFemale": false}` -- isFemale is false on
the entry that IS the female variant), neither reliably tagged
`gender = "female"`. After the cutover, both should collapse onto ONE
Standard row and ONE Female row, with `gender = "female"` correctly set only
on the Female row.
"""
from pathlib import Path

from src.builder import GoRefsMasterEngine


def test_frillish_produces_exactly_two_correctly_identified_form_rows():
    engine = GoRefsMasterEngine(raw_dumps_dir=Path("raw_dumps"))
    canonical = engine.collect_and_resolve_claims()

    frillish_forms = [f for f in canonical["forms"] if f["dex_number"] == 592]
    assert len(frillish_forms) == 2, (
        f"Expected exactly 2 form rows for Frillish (dex 592), got "
        f"{len(frillish_forms)}: {frillish_forms}"
    )

    genders = sorted(f["gender"] for f in frillish_forms)
    assert genders == ["female", "unknown"]

    female_row = next(f for f in frillish_forms if f["gender"] == "female")
    standard_row = next(f for f in frillish_forms if f["gender"] == "unknown")
    assert standard_row["costume_name"] is None
    assert female_row["costume_name"] is None

    # Pins the sub_records ordering contract documented in
    # pokemon_go_api_pokedex.yml: regionForms is listed before assetForms, so
    # its humanized dict-key text ("Frillish Female") wins the tie-break over
    # assetForms's terser mapped value ("Female") for form_name on this
    # collapsed entity. If a future template reorder flips this, this
    # assertion (not just reasoning about resolve_attribute_claim's stable
    # sort) is what catches it.
    assert female_row["form_name"] == "Frillish Female"


def test_no_duplicate_form_identities_anywhere_in_the_build():
    # The generalized version of the Frillish check: across all 1024 species,
    # no two form rows should share the same (dex_number, form_name,
    # costume_name, gender) identity -- that was the exact shape of the
    # pre-cutover bug (21 species affected per KNOWN_ISSUES.md).
    engine = GoRefsMasterEngine(raw_dumps_dir=Path("raw_dumps"))
    canonical = engine.collect_and_resolve_claims()

    seen = set()
    duplicates = []
    for f in canonical["forms"]:
        key = (f["dex_number"], f["form_name"], f["costume_name"], f["gender"])
        if key in seen:
            duplicates.append(key)
        seen.add(key)
    assert duplicates == [], f"Duplicate form identities found: {duplicates}"
