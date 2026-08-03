from src.profiler import detect_shape, rank_identity_candidates, catalog_fields


def test_detect_shape_finds_nested_dict_of_lists():
    payload = {"currentList": {"lvl1": [{"id": "A"}, {"id": "B"}]}, "graphics": {}}
    candidates = detect_shape(payload)
    assert candidates[0][0] == ["currentList"]
    assert len(candidates[0][1]) == 2


def test_detect_shape_recurses_past_single_list_amid_metadata_siblings():
    # A dict with exactly one list-valued key alongside unrelated non-list
    # metadata (pagination, counts, etc.) is a different shape from a
    # homogeneous "tier container" (all siblings are lists) -- it should NOT
    # be swallowed whole as a dict-of-lists candidate at path []. It should
    # recurse and find the simpler, more useful candidate at the list's own
    # path.
    payload = {"pokemon": [{"id": 1}, {"id": 2}], "meta": {"page": 1}}
    candidates = detect_shape(payload)
    assert (["pokemon"], [{"id": 1}, {"id": 2}]) in candidates
    assert candidates[0][0] == ["pokemon"]


def test_rank_identity_candidates_ranks_by_uniqueness():
    records = [{"speciesId": "bulbasaur", "dex": 1}, {"speciesId": "bulbasaur_shadow", "dex": 1}]
    candidates = rank_identity_candidates(records)
    by_field = {c[0]: c[1] for c in candidates}
    assert by_field["speciesId"] == 2  # unique
    assert by_field["dex"] == 1        # collides


def test_rank_identity_candidates_ranks_by_uniqueness_no_shortlist_names():
    # Field names invented for this test, absent from any plausible hardcoded
    # id-field shortlist (id, dexNr, pokemon_id, speciesId, ...). A shortlist-based
    # implementation patched to also recognize speciesId would still fail this,
    # proving the ranking is genuinely computed from uniqueness, not name matching.
    records = [{"zqx_handle": "a", "grp": 1}, {"zqx_handle": "b", "grp": 1}]
    candidates = rank_identity_candidates(records)
    by_field = {c[0]: c[1] for c in candidates}
    assert by_field["zqx_handle"] == 2  # unique
    assert by_field["grp"] == 1         # collides
    assert candidates[0][0] == "zqx_handle"  # ranked first by uniqueness


def test_catalog_fields_tracks_presence_and_sparsity():
    records = [{"a": 1, "b": "x"}, {"a": 2}]
    presence, types, examples, n = catalog_fields(records)
    assert presence["a"] == 2
    assert presence["b"] == 1
    assert n == 2
