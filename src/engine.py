"""Generic, template-driven extraction engine for GoRefs sources.

The only code path that reads a config/source_templates/*.yml file at build
time. Everything here is source-agnostic -- source-specific knowledge lives
entirely in the template, not in this module.
"""
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


def unwrap_to_records(
    payload: Any,
    unwrap_path: List[str],
    iterate_mode: str,
    key_becomes_field: Optional[str] = None,
    dict_key_field: str = "key",
    dict_value_field: str = "value",
) -> List[Dict[str, Any]]:
    """Descends through unwrap_path, then yields records per iterate_mode.

    Args:
        payload: The raw, already-json.load()-ed source payload.
        unwrap_path: Dict keys to descend through before iterating, e.g. ["currentList"].
        iterate_mode: One of "top_level_list", "dict_of_lists",
            "list_of_dicts_with_subkey", "single_object", "dict_of_scalars".
        key_becomes_field: For "dict_of_lists", the dict key at the final unwrap
            level is injected onto each of its records under this field name
            (e.g. a raid tier name becomes each boss record's "tier" field).
        dict_key_field: For "dict_of_scalars" only -- the field name each dict
            key is injected under in its one-field record (e.g. "costume_token").
            Defaults to "key" so a minimal template still works.
        dict_value_field: For "dict_of_scalars" only -- the field name each
            dict's scalar value is injected under (e.g. "display_name").
            Defaults to "value".

    Returns:
        List of record dicts.
    """
    # Special handling for list_of_dicts_with_subkey since payload may be a list
    if iterate_mode == "list_of_dicts_with_subkey":
        records = []
        if isinstance(payload, list):
            for item in payload:
                sub = item
                for key in unwrap_path:
                    sub = sub.get(key, {}) if isinstance(sub, dict) else {}
                if isinstance(sub, dict) and sub:
                    # Opt-in (key_becomes_field set): inject the PARENT item's
                    # templateId onto the sub-record under the given field name.
                    # Descending to the sub-dict (e.g. data.pokemonSettings)
                    # otherwise discards the parent item entirely, but some
                    # heterogeneous-array sources (GAME_MASTER) carry their only
                    # identity information (e.g. a dex number, embeddable only
                    # via regex on templateId) at the parent level, not inside
                    # the sub-dict itself. Non-destructive copy so the original
                    # payload is never mutated; matches dict_of_lists' existing
                    # key_becomes_field convention (reusing the same template
                    # knob rather than inventing a second one), and defaults to
                    # off (None) so every template written before this existed
                    # is unaffected.
                    if key_becomes_field:
                        sub = dict(sub)
                        sub[key_becomes_field] = item.get("templateId") if isinstance(item, dict) else None
                    records.append(sub)
        return records

    # For other modes, apply unwrap_path normally
    node = payload
    for key in unwrap_path:
        if not isinstance(node, dict) or key not in node:
            return []
        node = node[key]

    if iterate_mode == "top_level_list":
        return [r for r in node if isinstance(r, dict)] if isinstance(node, list) else []

    if iterate_mode == "dict_of_lists":
        records: List[Dict[str, Any]] = []
        if isinstance(node, dict):
            for group_key, group_list in node.items():
                if not isinstance(group_list, list):
                    continue
                for item in group_list:
                    if isinstance(item, dict):
                        record = dict(item)
                        if key_becomes_field:
                            record[key_becomes_field] = group_key
                        records.append(record)
        return records

    if iterate_mode == "single_object":
        return [node] if isinstance(node, dict) else []

    if iterate_mode == "dict_of_scalars":
        # The whole (unwrapped) payload IS the record set: one scalar value
        # per key (e.g. costume-lookup.json's {"ANNIVERSARY": "Party hat"}),
        # not a list of dicts and not a dict-of-lists grouping. Turn each pair
        # into a one-field record so identity_field/field_mappings can operate
        # on it like any other record shape (Task 23).
        if not isinstance(node, dict):
            return []
        return [{dict_key_field: k, dict_value_field: v} for k, v in node.items()]

    return []


def _get_nested(record: Dict[str, Any], dotted_path: str) -> Any:
    """Navigate through nested dict using dot-separated path.

    Args:
        record: Dict to navigate through
        dotted_path: Dot-separated path, e.g. "names.English"

    Returns:
        The value at the path, or None if path doesn't exist.
    """
    node: Any = record
    for part in dotted_path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def apply_transform(record: Dict[str, Any], mapping: Dict[str, Any]) -> Any:
    """Applies one template field_mappings entry's transform to a record.

    Args:
        record: A single extracted record (from unwrap_to_records).
        mapping: One field_mappings value, e.g.
            {"source_field": "names.English", "transform": "nested_path", "fallback_field": "id"}.

    Returns:
        The transformed value, or None if the source field is absent.
    """
    transform = mapping.get("transform", "direct")
    source_field = mapping.get("source_field")

    if transform == "direct":
        return record.get(source_field)

    if transform == "nested_path":
        value = _get_nested(record, source_field)
        if value is None and mapping.get("fallback_field"):
            value = record.get(mapping["fallback_field"])
        return value

    if transform == "boolean":
        value = record.get(source_field)
        return bool(value) if value is not None else None

    if transform == "list_index":
        value = record.get(source_field)
        index = mapping.get("index", 0)
        if isinstance(value, list) and len(value) > index:
            return value[index]
        return None

    if transform == "slugify":
        value = record.get(source_field)
        if value is None:
            return None
        return str(value).lower().replace("_", "-").replace(" ", "-")

    if transform == "regex_extract":
        value = record.get(source_field)
        if not isinstance(value, str):
            return None
        pattern = mapping.get("pattern")
        group = mapping.get("group", 1)
        match = re.search(pattern, value)
        if not match:
            return None
        captured = match.group(group)
        if captured is None:
            return None
        # A purely-digit capture (e.g. GAME_MASTER's templateId "V0001_..." -> "0001")
        # is int-cast so it matches builder.py's int-stringified entity_id convention
        # (pokemon_dex_1, never pokemon_dex_0001) -- see engine.run_source()'s
        # entity_id_prefix caveat comment on identity VALUE format mismatches.
        return int(captured) if captured.isdigit() else captured

    raise ValueError(f"Unknown transform: {transform!r}")


def resolve_gender(
    record: Dict[str, Any],
    gender_signals: List[Dict[str, Any]],
    context: Optional[Dict[str, Any]] = None,
) -> str:
    """Evaluates every gender signal against a record; any one firing means "female".

    This is the generalized fix for a source encoding "this is the female variant"
    inconsistently across fields (a boolean flag, a form-name string, or a dict key
    name) -- rather than trusting one hardcoded field, every declared signal is checked.

    Args:
        record: The extracted record.
        gender_signals: List of signal dicts from a template's `gender_signals`.
        context: Optional extra values not on the record itself, e.g. {"record_key":
            "FRILLISH_FEMALE"} for key_pattern signals sourced from a dict key rather
            than a record field.

    Returns:
        "female" if any signal fires, else "unknown".
    """
    context = context or {}
    for signal in gender_signals:
        signal_type = signal.get("signal_type")
        if signal_type == "boolean_field":
            if bool(record.get(signal["source_field"])) is True:
                return signal.get("when_true", "female")
        elif signal_type == "value_pattern":
            value = record.get(signal["source_field"])
            if isinstance(value, str) and re.search(signal["pattern"], value):
                return signal.get("value", "female")
        elif signal_type == "key_pattern":
            key_value = context.get("record_key", "")
            if re.search(signal["key_pattern"], str(key_value)):
                return signal.get("value", "female")
    return "unknown"


def normalize_form_identity(
    species_dex: int,
    species_slug: str,
    form_name: Optional[str],
    costume_name: Optional[str],
    gender: str,
) -> tuple:
    """Builds a normalized identity tuple for deduplicating form records.

    Strips a leading repeat of the species' own name from form_name (this is what
    caused "592-frillish-frillish-female"-style duplicate slugs), and folds any
    form_name that's purely a gender label (e.g. "Female") into the gender field
    rather than treating it as a distinct form -- so the same real-world variant,
    however it's spelled across different upstream fields, collapses to one tuple.

    Args:
        species_dex: Species dex number.
        species_slug: e.g. "592-frillish".
        form_name: Raw form name, e.g. "Frillish (Female)" or "Female" or None.
        costume_name: Raw costume name, or None.
        gender: Already-resolved gender ("female" or "unknown").

    Returns:
        (species_dex, normalized_form_token, normalized_costume_token, gender)
    """
    species_name_part = species_slug.split("-", 1)[1] if "-" in species_slug else species_slug

    def _normalize_token(raw: Optional[str]) -> Optional[str]:
        if not raw:
            return None
        token = raw.lower().strip()
        token = re.sub(r"\(female\)|\(male\)", "", token).strip()
        token = re.sub(r"[^a-z0-9]+", "-", token).strip("-")
        if not token:
            return None
        # Strip standalone "female"/"male" tokens wherever they appear -- leading,
        # trailing, or in the middle -- not just as an exact-string match. This is
        # what makes "frillish-female", "female-frillish", and bare "female" all
        # fold the same way regardless of how a source orders the gender label
        # relative to the species/form name, once gender is already captured
        # separately in the `gender` field.
        token = re.sub(r"(?:^|-)(?:female|male)(?:-|$)", "-", token)
        token = token.strip("-")
        token = re.sub(r"-{2,}", "-", token).strip("-")
        if not token:
            return None
        # strip a leading or trailing repeat of the species' own name, e.g.
        # "frillish-costume" -> "costume", "costume-frillish" -> "costume",
        # or a bare repeat of the species name -> None (no extra identity info).
        if token == species_name_part:
            token = None
        elif token.startswith(species_name_part + "-"):
            token = token[len(species_name_part) + 1 :] or None
        elif token.endswith("-" + species_name_part):
            token = token[: -(len(species_name_part) + 1)] or None
        return token or None

    form_token = _normalize_token(form_name)
    if form_token == "standard":
        form_token = None

    costume_token = _normalize_token(costume_name)

    return (species_dex, form_token, costume_token, gender)


def _slugify_name(name: Optional[str]) -> str:
    """Lowercases and hyphenates a display name for identity-stripping purposes only.

    Not a display slug (that's builder.py's job) -- just enough normalization for
    normalize_form_identity() to reliably strip a repeated species-name token from
    a form/costume string, regardless of exact punctuation/casing.
    """
    if not name:
        return ""
    return re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")


def _build_form_entity_id(entity_prefix: str, raw_id: Any, norm_identity: tuple) -> str:
    """Builds a deterministic form entity_id from a normalized identity tuple.

    Two different upstream fields describing the SAME real-world variant (e.g.
    assetForms's unreliable `isFemale` boolean vs. regionForms's `..._FEMALE` key
    text) normalize to the same tuple via normalize_form_identity(), and therefore
    land on this same entity_id -- this is what makes the dedup automatic rather
    than requiring an explicit dedup pass over raw strings.
    """
    _, form_token, costume_token, gender = norm_identity
    parts = [p for p in (form_token, costume_token) if p]
    if gender and gender != "unknown":
        parts.append(gender)
    suffix = "_".join(parts) if parts else "standard"
    return f"{entity_prefix}_{raw_id}_form_{suffix}"


def apply_sub_records(
    parent_record: Dict[str, Any],
    parent_raw_id: Any,
    species_dex: int,
    species_name: Optional[str],
    entity_prefix: str,
    sub_record_configs: List[Dict[str, Any]],
    source: str,
    priority: int,
) -> List[Dict[str, Any]]:
    """Extracts claims from a parent record's nested sub-lists (e.g. assetForms,
    regionForms), one additional claim-set per sub-record.

    This is the fix for a source describing the same real-world form/gender/costume
    variant inconsistently across two different nested fields (pokemon_go_api's
    Frillish: once via `regionForms["FRILLISH_FEMALE"]`, once via `assetForms`'s
    `{"form": "FEMALE", "isFemale": false}` -- isFemale is false on the entry that
    IS the female variant). Every sub-record's identity is normalized via
    normalize_form_identity() before being turned into an entity_id, so both
    representations collapse onto the same entity rather than producing two
    separate, inconsistently-tagged rows.

    Args:
        parent_record: The top-level extracted record (e.g. one pokedex species).
        parent_raw_id: The parent's identity_field value (e.g. dexNr).
        species_dex: Numeric species dex number (passed separately from
            parent_raw_id since callers may one day key parents by something else).
        species_name: The parent's own display name, used only to strip a
            repeated species-name token out of form/costume text.
        entity_prefix: Same entity_id_prefix run_source() resolved for the parent.
        sub_record_configs: The template's `sub_records` list.
        source: Actual source key (for claim provenance).
        priority: Trust-hierarchy priority for this source.

    Returns:
        List of claim dicts, same shape as run_source()'s top-level claims.
    """
    species_slug = f"{species_dex}-{_slugify_name(species_name)}"
    claims: List[Dict[str, Any]] = []

    for config in sub_record_configs:
        list_field = config.get("list_field")
        container_type = config.get("container_type", "list")
        raw_container = parent_record.get(list_field)
        sub_field_mappings = config.get("field_mappings", {})
        sub_gender_signals = config.get("gender_signals", [])

        if container_type == "dict":
            if not isinstance(raw_container, dict):
                continue
            items = list(raw_container.items())
        else:
            if not isinstance(raw_container, list):
                continue
            items = [(None, item) for item in raw_container if isinstance(item, dict)]

        for record_key, sub_record in items:
            if not isinstance(sub_record, dict):
                continue

            context = {"record_key": record_key} if record_key is not None else {}
            gender = resolve_gender(sub_record, sub_gender_signals, context=context) if sub_gender_signals else "unknown"

            sub_values: Dict[str, Any] = {}
            for attribute, mapping in sub_field_mappings.items():
                value = apply_transform(sub_record, mapping)
                if value is not None:
                    sub_values[attribute] = value

            # Identity text: for dict-keyed sub-lists (regionForms), the dict key
            # itself (e.g. "UNOWN_A", "FRILLISH_FEMALE") is ALWAYS preferred over
            # any mapped field value -- some sources put a genuinely useless,
            # completely non-distinguishing display name on every sub-record
            # (pokemon_go_api's regionForms: EVERY one of Unown's 28 regionForms
            # entries has names.English == "Unown", the species' own name, with
            # the real per-letter identity living only in the dict key). Using
            # the mapped field there would make normalize_form_identity's
            # species-name-repeat-stripping collapse all 28 letters onto one
            # identity -- a second, independent duplicate-row bug of the same
            # shape as the gender one, caught by this task's own dedup test.
            # List-keyed sub-lists (assetForms) have no dict key, so they fall
            # back to whatever field_mappings captured (e.g. "form").
            if record_key is not None:
                identity_text = str(record_key)
            else:
                identity_text = sub_values.get("form_name")

            costume_name_raw = sub_values.get("costume_name")

            # A sub-record with no identity text, no costume, and no gender signal
            # firing carries zero identity information beyond the species itself --
            # this is the placeholder "base form" entry some sources
            # (pokemon_go_api's assetForms) repeat alongside real variants. It is
            # NOT a distinct form and must not produce a spurious entity; the
            # base/standard form is handled separately by the caller from the
            # parent record itself.
            if not identity_text and not costume_name_raw and gender == "unknown":
                continue

            norm_identity = normalize_form_identity(
                species_dex, species_slug, identity_text, costume_name_raw, gender
            )
            entity_id = _build_form_entity_id(entity_prefix, parent_raw_id, norm_identity)

            # Display text: humanize whichever raw text drove identity/mapping
            # (e.g. "UNOWN_A" -> "Unown A", "FEMALE" -> "Female") for the claim's
            # actual form_name value -- prefer a mapped field_mappings value over
            # the bare identity text when both exist (a future source might map
            # a genuinely more specific display string there), but humanize
            # either way for consistency with the legacy display style this
            # replaces.
            raw_display_text = sub_values.get("form_name") or identity_text
            # A sub-record with no identity text at all (e.g. a costume-only
            # assetForms entry: costume set, form=null) is still a real,
            # distinct variant -- it passed the placeholder-skip check above
            # because costume_name_raw is present -- so it must still get a
            # form_name rather than silently ending up NULL. "Standard" matches
            # the legacy convention this replaces (a costume applied to the
            # base form, with no separate form of its own).
            form_name_display = raw_display_text.replace("_", " ").title() if raw_display_text else "Standard"

            claims.append({"entity_id": entity_id, "attribute": "dex_number", "source": source, "value": species_dex, "priority": priority})
            if form_name_display:
                claims.append({"entity_id": entity_id, "attribute": "form_name", "source": source, "value": form_name_display, "priority": priority})
            if costume_name_raw:
                claims.append({"entity_id": entity_id, "attribute": "costume_name", "source": source, "value": costume_name_raw, "priority": priority})
            claims.append({"entity_id": entity_id, "attribute": "gender", "source": source, "value": gender, "priority": priority})
            for attribute, value in sub_values.items():
                if attribute in ("form_name", "costume_name"):
                    continue
                claims.append({"entity_id": entity_id, "attribute": attribute, "source": source, "value": value, "priority": priority})

    return claims


def _get_latest_snapshot_dir(source_dir: Path) -> Optional[Path]:
    """Returns the lexicographically-latest timestamped snapshot subdirectory, if any."""
    if not source_dir.exists():
        return None
    snapshots = sorted([d for d in source_dir.iterdir() if d.is_dir()])
    return snapshots[-1] if snapshots else None


def _load_template_and_records(
    source_key: str,
    raw_dumps_dir: Path,
    templates_dir: Path,
) -> Optional[Dict[str, Any]]:
    """Shared loader for run_source() and extract_transformed_records(): reads a
    template, resolves its latest raw snapshot, and extracts records via
    unwrap_to_records(). These two functions are the only code that reads
    config/source_templates/*.yml -- everything else in this module operates on
    already-extracted records or claims, and no other module reads templates at all.

    Returns:
        None if the template or its raw snapshot is missing, else a dict with
        keys: template, records, actual_source_key, field_mappings, gender_signals,
        identity_field, priority, snapshot_dir.
    """
    from src.builder import TRUST_HIERARCHY  # local import avoids a circular import at module load

    template_path = templates_dir / f"{source_key}.yml"
    if not template_path.exists():
        return None
    with open(template_path, "r", encoding="utf-8") as f:
        template = yaml.safe_load(f)

    actual_source_key = template.get("source_key", source_key)
    endpoint = template.get("endpoint", source_key)
    source_dir = raw_dumps_dir / actual_source_key
    snapshot_dir = _get_latest_snapshot_dir(source_dir)
    if not snapshot_dir:
        return None

    data_file = snapshot_dir / f"{endpoint}.json"
    if not data_file.exists():
        return None
    with open(data_file, "r", encoding="utf-8") as f:
        payload = json.load(f)

    extraction = template.get("record_extraction", {})
    records = unwrap_to_records(
        payload,
        unwrap_path=extraction.get("unwrap_path", []),
        iterate_mode=extraction.get("iterate_mode", "top_level_list"),
        key_becomes_field=extraction.get("key_becomes_field"),
        dict_key_field=extraction.get("dict_key_field", "key"),
        dict_value_field=extraction.get("dict_value_field", "value"),
    )

    field_mappings = dict(template.get("field_mappings", {}))
    field_mappings.update(template.get("overrides", {}))  # overrides always win
    gender_signals = template.get("gender_signals", [])
    identity_field = template.get("identity_field", "id")
    priority = TRUST_HIERARCHY.get(actual_source_key, 99)

    return {
        "template": template,
        "records": records,
        "actual_source_key": actual_source_key,
        "field_mappings": field_mappings,
        "gender_signals": gender_signals,
        "identity_field": identity_field,
        "priority": priority,
        "snapshot_dir": snapshot_dir,
    }


def extract_transformed_records(
    source_key: str,
    raw_dumps_dir: Path = Path("raw_dumps"),
    templates_dir: Path = Path("config/source_templates"),
) -> List[Dict[str, Any]]:
    """Extracts one plain, field_mappings-transformed dict per record -- no entity_id,
    no claims ledger, no priority-based resolution.

    For single-source domains with no cross-source arbitration (e.g. pokemon_go_api's
    raid_bosses/max_battles/quests, whose only source is pokemon_go_api itself): there
    is nothing to resolve claims AGAINST, so routing these through run_source()'s
    entity_id/claims/ledger machinery buys nothing and actively loses information --
    that machinery builds one entity_id per identity_field value, which collides for
    domains needing a composite key run_source() cannot express (e.g. a raid boss's
    real identity is (tier, id), not id alone -- two different raid tiers can feature
    the same Pokemon id). Callers needing a composite key should build it themselves
    from whatever field_mappings captured (e.g. a `key_becomes_field` value) plus this
    function's returned dicts, entirely in caller-owned code -- no ledger involved.

    Args:
        source_key: Template name (without .yml), same convention as run_source().
        raw_dumps_dir: Base directory containing raw_dumps/<source>/<timestamp>/*.json.
        templates_dir: Base directory containing config/source_templates/*.yml.

    Returns:
        List of plain dicts: {attribute: transformed_value, ...} per extracted record,
        plus a "gender" key when the template declares gender_signals. Records whose
        every field_mappings value transforms to None still appear (as an empty dict),
        since there's no identity_field requirement to filter on unlike run_source().
    """
    loaded = _load_template_and_records(source_key, raw_dumps_dir, templates_dir)
    if loaded is None:
        return []

    out: List[Dict[str, Any]] = []
    for record in loaded["records"]:
        transformed: Dict[str, Any] = {}
        for attribute, mapping in loaded["field_mappings"].items():
            value = apply_transform(record, mapping)
            if value is not None:
                transformed[attribute] = value
        if loaded["gender_signals"]:
            transformed["gender"] = resolve_gender(record, loaded["gender_signals"])
        out.append(transformed)
    return out


def run_source(
    source_key: str,
    raw_dumps_dir: Path = Path("raw_dumps"),
    templates_dir: Path = Path("config/source_templates"),
    parsed_dumps_dir: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Extracts claims from a source's latest raw snapshot, driven entirely by its template.

    See _load_template_and_records()'s docstring for the "only two functions that read
    templates" note. This function never writes to canonical tables -- callers
    (GoRefsMasterEngine, --test-paranoid) are responsible for feeding the returned
    claims into the ledger/resolver.

    Args:
        source_key: e.g. "pokemon_go_api". Looks for a template named exactly
            "{source_key}.yml", or, for multi-endpoint sources, the caller should pass
            the specific "{source_key}_{endpoint}.yml" template name as source_key.
        raw_dumps_dir: Base directory containing raw_dumps/<source>/<timestamp>/*.json.
        templates_dir: Base directory containing config/source_templates/*.yml.

    Returns:
        List of claim dicts: {"entity_id", "attribute", "source", "value", "priority"}.
    """
    loaded = _load_template_and_records(source_key, raw_dumps_dir, templates_dir)
    if loaded is None:
        return []

    template = loaded["template"]
    records = loaded["records"]
    actual_source_key = loaded["actual_source_key"]
    field_mappings = loaded["field_mappings"]
    gender_signals = loaded["gender_signals"]
    identity_field = loaded["identity_field"]
    priority = loaded["priority"]
    snapshot_dir = loaded["snapshot_dir"]

    # entity_id_prefix (optional): builder.py's row-assembly code reads resolved
    # claims back out under domain-specific prefixes it constructs itself (e.g.
    # "pokemon_dex_<n>", "badge_<id>", "move_<id>" -- grep `entity_id = f"` in
    # builder.py for the full list), NOT under the real source key. Without this
    # field, entity_id below is namespaced by actual_source_key and never lines
    # up with what builder.py looks for, so the claims are inert. A cutover task
    # that wants its claims to actually reach canonical output must set this
    # field to match builder.py's prefix scheme for that domain.
    #
    # Defaults to actual_source_key so templates that don't set it are unaffected
    # (backward compatible with every template written before this field existed).
    #
    # CAUTION when setting this: the *value* half of entity_id must also match
    # exactly, not just the prefix. builder.py's "pokemon_dex_<n>" keys are built
    # from an int-typed dex_number, stringified via plain f"..." (e.g.
    # "pokemon_dex_25", never "pokemon_dex_025" or "pokemon_dex_25.0"). If
    # raw_id here is a string with different formatting (leading zeros, a float
    # repr, etc.) than str(int(dex_number)), the entity_id will silently fail to
    # match and the claim will never resolve into the canonical row -- with no
    # error, just a claim that quietly goes nowhere. (A pre-existing instance of
    # this exact mismatch class already exists in builder.py:396, using a
    # string raw_pid instead of an int-coerced one; see Task 6's review.) Make
    # sure identity_field's raw values coerce to the same string builder.py
    # expects before wiring entity_id_prefix to a real domain in a future task.
    entity_prefix = template.get("entity_id_prefix", actual_source_key)

    claims: List[Dict[str, Any]] = []
    for record in records:
        # Identity resolution normally reads identity_field straight off the raw
        # record (a plain dict lookup) -- but some sources (GAME_MASTER's
        # pokemonSettings) have no direct field holding their real identity at
        # all; it only exists as a field_mappings/overrides-computed value (e.g.
        # a regex_extract on an injected templateId, see fixture_gm_pokemon_
        # settings.yml / game_master_pokemon_settings.yml). When identity_field
        # is itself a key in field_mappings, route it through apply_transform
        # instead of a raw lookup. For every pre-existing template this is a
        # verified no-op: identity_field's mapping (where one exists at all) is
        # always a "direct" transform on that exact same source_field, so
        # apply_transform(record, mapping) == record.get(identity_field)
        # exactly -- see test_run_source_identity_field_plain_lookup_still_
        # works_when_no_mapping_exists and Task 22's report for the full
        # per-template audit.
        if identity_field in field_mappings:
            raw_id = apply_transform(record, field_mappings[identity_field])
        else:
            raw_id = record.get(identity_field)
        if raw_id is None:
            continue
        entity_id = f"{entity_prefix}_{raw_id}"

        for attribute, mapping in field_mappings.items():
            value = apply_transform(record, mapping)
            if value is not None:
                claims.append({
                    "entity_id": entity_id,
                    "attribute": attribute,
                    "source": actual_source_key,
                    "value": value,
                    "priority": priority,
                })

        if gender_signals:
            gender = resolve_gender(record, gender_signals)
            claims.append({
                "entity_id": entity_id,
                "attribute": "gender",
                "source": actual_source_key,
                "value": gender,
                "priority": priority,
            })

        sub_record_configs = template.get("sub_records")
        if sub_record_configs:
            # species_name is looked up via whichever field_mappings entry is
            # literally named "name" -- the same convention every cut-over
            # template already uses for its primary display name -- rather than
            # a new template key, so sub_records needs no extra template wiring
            # beyond declaring the mapping it already has.
            species_name = None
            name_mapping = field_mappings.get("name")
            if name_mapping:
                species_name = apply_transform(record, name_mapping)
            claims.extend(apply_sub_records(
                parent_record=record,
                parent_raw_id=raw_id,
                species_dex=raw_id,
                species_name=species_name,
                entity_prefix=entity_prefix,
                sub_record_configs=sub_record_configs,
                source=actual_source_key,
                priority=priority,
            ))

    if parsed_dumps_dir is not None:
        out_dir = parsed_dumps_dir / actual_source_key / snapshot_dir.name
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / "claims.jsonl", "w", encoding="utf-8") as f:
            for claim in claims:
                f.write(json.dumps(claim) + "\n")

    return claims
