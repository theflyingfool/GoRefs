from src.engine import apply_transform


def test_direct():
    assert apply_transform({"form": "FEMALE"}, {"source_field": "form", "transform": "direct"}) == "FEMALE"


def test_nested_path():
    record = {"names": {"English": "Bulbasaur"}}
    assert apply_transform(record, {"source_field": "names.English", "transform": "nested_path"}) == "Bulbasaur"


def test_nested_path_fallback():
    record = {"id": "BULBASAUR", "names": {}}
    mapping = {"source_field": "names.English", "transform": "nested_path", "fallback_field": "id"}
    assert apply_transform(record, mapping) == "BULBASAUR"


def test_boolean_from_truthy_int():
    assert apply_transform({"event_badge": 1}, {"source_field": "event_badge", "transform": "boolean"}) is True


def test_list_index():
    record = {"cpRange": [590, 637]}
    assert apply_transform(record, {"source_field": "cpRange", "transform": "list_index", "index": 0}) == 590
    assert apply_transform(record, {"source_field": "cpRange", "transform": "list_index", "index": 1}) == 637


def test_slugify():
    assert apply_transform({"form": "MEGA_X"}, {"source_field": "form", "transform": "slugify"}) == "mega-x"


# Edge case tests for testing thoroughness
def test_boolean_with_falsy_zero():
    """Falsy value (0) should return False, not None."""
    assert apply_transform({"event_badge": 0}, {"source_field": "event_badge", "transform": "boolean"}) is False


def test_boolean_with_falsy_empty_string():
    """Falsy value ("") should return False, not None."""
    assert apply_transform({"text": ""}, {"source_field": "text", "transform": "boolean"}) is False


def test_boolean_with_absent_field():
    """Absent field should return None, not False."""
    assert apply_transform({}, {"source_field": "missing_field", "transform": "boolean"}) is None


def test_list_index_out_of_range():
    """Out-of-range index should return None, not raise exception."""
    record = {"cpRange": [590, 637]}
    assert apply_transform(record, {"source_field": "cpRange", "transform": "list_index", "index": 5}) is None


def test_list_index_on_non_list():
    """Non-list value at source_field should return None, not raise exception."""
    record = {"cpRange": "not_a_list"}
    assert apply_transform(record, {"source_field": "cpRange", "transform": "list_index", "index": 0}) is None


def test_nested_path_missing_top_level_key():
    """Missing top-level key should return None, not raise KeyError."""
    record = {"id": "BULBASAUR"}
    result = apply_transform(record, {"source_field": "names.English", "transform": "nested_path"})
    assert result is None


def test_nested_path_missing_top_level_with_fallback():
    """Missing top-level key should use fallback_field."""
    record = {"id": "BULBASAUR"}
    mapping = {"source_field": "names.English", "transform": "nested_path", "fallback_field": "id"}
    assert apply_transform(record, mapping) == "BULBASAUR"


# regex_extract (Task 22): GAME_MASTER's pokemonSettings records carry no direct
# dex-number field -- it's embedded in the record's templateId string, e.g.
# "V0001_POKEMON_BULBASAUR" -> 1. A purely-digit capture group is int-cast (so
# "0001" -> 1, not the string "0001"), since builder.py's pokemon_dex_<n>
# entity_ids are built from an int-stringified dex number, never zero-padded.
def test_regex_extract_digit_group_is_int_cast():
    record = {"templateId": "V0001_POKEMON_BULBASAUR"}
    mapping = {"source_field": "templateId", "transform": "regex_extract", "pattern": r"^V(\d{4})_POKEMON_", "group": 1}
    assert apply_transform(record, mapping) == 1


def test_regex_extract_strips_leading_zeros():
    record = {"templateId": "V0222_POKEMON_CORSOLA"}
    mapping = {"source_field": "templateId", "transform": "regex_extract", "pattern": r"^V(\d{4})_POKEMON_", "group": 1}
    assert apply_transform(record, mapping) == 222


def test_regex_extract_no_match_returns_none():
    record = {"templateId": "COMBAT_V0013_MOVE_WRAP"}
    mapping = {"source_field": "templateId", "transform": "regex_extract", "pattern": r"^V(\d{4})_POKEMON_", "group": 1}
    assert apply_transform(record, mapping) is None


def test_regex_extract_non_digit_group_stays_string():
    record = {"uniqueId": "WRAP_FAST"}
    mapping = {"source_field": "uniqueId", "transform": "regex_extract", "pattern": r"^(\w+)_FAST$", "group": 1}
    assert apply_transform(record, mapping) == "WRAP"


def test_regex_extract_missing_field_returns_none():
    record = {}
    mapping = {"source_field": "templateId", "transform": "regex_extract", "pattern": r"^V(\d{4})_POKEMON_", "group": 1}
    assert apply_transform(record, mapping) is None


def test_regex_extract_non_string_field_returns_none():
    record = {"templateId": 12345}
    mapping = {"source_field": "templateId", "transform": "regex_extract", "pattern": r"^V(\d{4})_POKEMON_", "group": 1}
    assert apply_transform(record, mapping) is None
