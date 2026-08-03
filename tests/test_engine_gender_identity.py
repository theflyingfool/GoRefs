from src.engine import resolve_gender, normalize_form_identity


def test_resolve_gender_boolean_field_signal():
    record = {"isFemale": True}
    signals = [{"signal_type": "boolean_field", "source_field": "isFemale", "when_true": "female"}]
    assert resolve_gender(record, signals) == "female"


def test_resolve_gender_value_pattern_signal_catches_frillish_bug():
    # This is the exact real-world case that broke: isFemale is False, but the
    # `form` value itself says FEMALE.
    record = {"form": "FEMALE", "isFemale": False}
    signals = [
        {"signal_type": "boolean_field", "source_field": "isFemale", "when_true": "female"},
        {"signal_type": "value_pattern", "source_field": "form", "pattern": "(?i)female", "value": "female"},
    ]
    assert resolve_gender(record, signals) == "female"


def test_resolve_gender_key_pattern_signal():
    record = {"names": {"English": "Frillish (Female)"}}
    signals = [{"signal_type": "key_pattern", "source_field": "__record_key__", "key_pattern": "(?i)_female$", "value": "female"}]
    assert resolve_gender(record, signals, context={"record_key": "FRILLISH_FEMALE"}) == "female"


def test_resolve_gender_no_signal_fires():
    record = {"form": "STANDARD"}
    signals = [{"signal_type": "boolean_field", "source_field": "isFemale", "when_true": "female"}]
    assert resolve_gender(record, signals) == "unknown"


def test_normalize_form_identity_collapses_duplicate_representations():
    # regionForms' "Frillish (Female)" and assetForms' form="FEMALE" should
    # normalize to the SAME identity tuple.
    ident_a = normalize_form_identity(592, "592-frillish", "Frillish (Female)", None, "female")
    ident_b = normalize_form_identity(592, "592-frillish", "Female", None, "female")
    assert ident_a == ident_b


def test_normalize_form_identity_collapses_gender_label_regardless_of_ordering():
    # A hypothetical source that puts the gender label BEFORE the species name
    # ("Female Frillish") should still collapse to the same identity as the
    # other two orderings -- the fold must not depend on the species name being
    # a prefix of the form string.
    ident_a = normalize_form_identity(592, "592-frillish", "Frillish (Female)", None, "female")
    ident_c = normalize_form_identity(592, "592-frillish", "Female Frillish", None, "female")
    assert ident_a == ident_c
