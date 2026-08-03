from src.engine import unwrap_to_records


def test_top_level_list():
    payload = [{"name": "a"}, {"name": "b"}]
    records = unwrap_to_records(payload, unwrap_path=[], iterate_mode="top_level_list", key_becomes_field=None)
    assert records == [{"name": "a"}, {"name": "b"}]


def test_dict_of_lists_with_key_becomes_field():
    payload = {"currentList": {"lvl1": [{"id": "BULBASAUR"}], "lvl5": [{"id": "SOLGALEO"}]}}
    records = unwrap_to_records(payload, unwrap_path=["currentList"], iterate_mode="dict_of_lists", key_becomes_field="tier")
    assert {"id": "BULBASAUR", "tier": "lvl1"} in records
    assert {"id": "SOLGALEO", "tier": "lvl5"} in records


def test_list_of_dicts_with_subkey():
    payload = [{"templateId": "X", "data": {"pokemonSettings": {"pokemonId": "BULBASAUR"}}}]
    records = unwrap_to_records(payload, unwrap_path=["data"], iterate_mode="list_of_dicts_with_subkey", key_becomes_field=None)
    assert records == [{"pokemonSettings": {"pokemonId": "BULBASAUR"}}]


def test_single_object():
    payload = {"only": "one record"}
    records = unwrap_to_records(payload, unwrap_path=[], iterate_mode="single_object", key_becomes_field=None)
    assert records == [{"only": "one record"}]


def test_list_of_dicts_with_subkey_key_becomes_field_injects_parent_template_id():
    """Task 22: GAME_MASTER's pokemonSettings sub-records carry no dex-number field
    of their own -- it's only derivable from the PARENT item's templateId, which
    list_of_dicts_with_subkey normally discards entirely (it returns only the
    descended-to sub-dict). Opt-in via key_becomes_field (same knob dict_of_lists
    already uses for its own per-group injection) so a template can recover the
    parent's templateId under a field name it then regex_extracts from -- without
    this, identity_field has no field to read at all.
    """
    payload = [{"templateId": "V0001_POKEMON_BULBASAUR", "data": {"pokemonSettings": {"pokemonId": "BULBASAUR"}}}]
    records = unwrap_to_records(
        payload,
        unwrap_path=["data", "pokemonSettings"],
        iterate_mode="list_of_dicts_with_subkey",
        key_becomes_field="templateId",
    )
    assert records == [{"pokemonId": "BULBASAUR", "templateId": "V0001_POKEMON_BULBASAUR"}]


def test_list_of_dicts_with_subkey_without_key_becomes_field_unchanged():
    """Backward-compat guard: key_becomes_field=None (the default for every
    template written before Task 22) must not inject anything -- identical to
    the pre-existing test_list_of_dicts_with_subkey behavior above.
    """
    payload = [{"templateId": "X", "data": {"pokemonSettings": {"pokemonId": "BULBASAUR"}}}]
    records = unwrap_to_records(payload, unwrap_path=["data"], iterate_mode="list_of_dicts_with_subkey", key_becomes_field=None)
    assert records == [{"pokemonSettings": {"pokemonId": "BULBASAUR"}}]


def test_list_of_dicts_with_subkey_heterogeneous():
    """Test that non-matching items (which would produce empty dicts) are excluded.

    This simulates GAME_MASTER data with mixed template types where only some
    items have the target subkey. Empty dicts should not be included in results.
    """
    payload = [
        {"templateId": "A", "data": {"pokemonSettings": {"pokemonId": "BULBASAUR"}}},
        {"templateId": "B", "data": {"itemSettings": {"itemId": "POTION"}}},
    ]
    records = unwrap_to_records(
        payload,
        unwrap_path=["data", "pokemonSettings"],
        iterate_mode="list_of_dicts_with_subkey"
    )
    # Only the first item matches; the second item lacks pokemonSettings, so would be empty
    assert records == [{"pokemonId": "BULBASAUR"}]
    # Verify no empty-dict record from the non-matching item
    assert {} not in records


def test_dict_of_scalars():
    """Task 23: local_authoring's costume-lookup.json is a flat dict where the
    WHOLE payload is the record set -- one scalar value per key (e.g.
    {"ANNIVERSARY": "Party hat", "COSTUME_1": ""}), not a list of dicts and not
    a dict-of-lists grouping. None of the 4 pre-existing iterate_modes can
    express "each key:value pair IS a one-field record" -- dict_of_scalars
    turns each pair into {dict_key_field: key, dict_value_field: value} so the
    rest of the templating machinery (identity_field, field_mappings) can
    operate on it exactly like any other record shape.
    """
    payload = {"ANNIVERSARY": "Party hat", "COSTUME_1": ""}
    records = unwrap_to_records(
        payload,
        unwrap_path=[],
        iterate_mode="dict_of_scalars",
        dict_key_field="costume_token",
        dict_value_field="display_name",
    )
    assert {"costume_token": "ANNIVERSARY", "display_name": "Party hat"} in records
    assert {"costume_token": "COSTUME_1", "display_name": ""} in records
    assert len(records) == 2


def test_dict_of_scalars_with_unwrap_path():
    """dict_of_scalars must still honor unwrap_path like every other mode, in
    case a future flat-dict source nests its lookup under a key instead of
    being the bare top-level payload (costume-lookup.json itself has no
    nesting, but the capability shouldn't be needlessly narrower than the
    other iterate_modes)."""
    payload = {"lookup": {"HALLOWEEN_2025": "Witch hat"}}
    records = unwrap_to_records(
        payload,
        unwrap_path=["lookup"],
        iterate_mode="dict_of_scalars",
        dict_key_field="token",
        dict_value_field="name",
    )
    assert records == [{"token": "HALLOWEEN_2025", "name": "Witch hat"}]


def test_dict_of_scalars_default_field_names():
    """Backward/forward-compat: if a template omits dict_key_field/
    dict_value_field, fall back to sane defaults ("key"/"value") rather than
    raising, so a minimal template still works."""
    payload = {"A": "b"}
    records = unwrap_to_records(payload, unwrap_path=[], iterate_mode="dict_of_scalars")
    assert records == [{"key": "A", "value": "b"}]


def test_dict_of_scalars_non_dict_node_returns_empty():
    """If the unwrapped node isn't actually a dict, return [] rather than raising,
    matching every other iterate_mode's defensive-empty-list convention."""
    records = unwrap_to_records([1, 2, 3], unwrap_path=[], iterate_mode="dict_of_scalars")
    assert records == []
