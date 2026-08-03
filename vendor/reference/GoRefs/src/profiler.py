"""Source profiler: inspects raw JSON and proposes config/source_templates/*.yml templates.

Ranks identity-field candidates by uniqueness rather than checking a hardcoded
shortlist of field names -- a fixed shortlist was tried during design review and
missed pvpoke's real identity field (speciesId) entirely (see the spec's
"Profiler dry-run findings" section), which is exactly the kind of hardcoding
this whole project exists to move away from.
"""
import datetime
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml


def detect_shape(payload: Any, max_depth: int = 4) -> List[Tuple[List[str], List[Dict[str, Any]]]]:
    """Finds every point in payload where a list of record-shaped dicts appears.

    Two shapes are recognized:
      - a bare list of dicts (top-level or nested), recorded at its own path.
      - a "dict of lists" container -- a dict whose values are themselves lists
        of dicts (e.g. {"lvl1": [...], "lvl5": [...]}) -- recorded at the path of
        the container itself, with records being the concatenation of its list
        values. This mirrors engine.unwrap_to_records's iterate_mode="dict_of_lists",
        which resolves unwrap_path to this same container and iterates its values,
        rather than to any single one of its list-valued keys.

    Returns:
        List of (path, records) tuples, in discovery order. Callers typically pick
        the shallowest-path, most-populous candidate as primary.
    """
    candidates: List[Tuple[List[str], List[Dict[str, Any]]]] = []

    def is_record_list(v: Any) -> bool:
        return isinstance(v, list) and len(v) > 0 and all(isinstance(x, dict) for x in v[:20])

    def is_dict_of_lists(v: Any) -> bool:
        # A dict is a "dict of lists" container only when a strict MAJORITY of its
        # values are record-lists -- not merely "at least one". A bare `any()` check
        # over-triggers on the very common "one real list wrapped alongside unrelated
        # metadata" API shape, e.g. {"pokemon": [...], "meta": {"page": 1}}: that dict
        # has exactly one list-valued key, so `any()` would swallow it whole as a
        # (fake) dict-of-lists container at path [] instead of recursing to find the
        # simpler, more useful (["pokemon"], [...]) candidate. Requiring a strict
        # majority (>50% of values are record-lists) lets a single list amid
        # non-list siblings fall through to normal recursion, while still
        # recognizing homogeneous "tier container" shapes like
        # {"lvl1": [...], "lvl5": [...]} (all-list) or a lone list-valued key with no
        # non-list siblings (100% of one value).
        if not isinstance(v, dict) or len(v) == 0:
            return False
        list_count = sum(1 for x in v.values() if is_record_list(x))
        if list_count == 0:
            return False
        return list_count / len(v) > 0.5

    def walk(node: Any, path: List[str], depth: int) -> None:
        if depth > max_depth:
            return
        if is_record_list(node):
            candidates.append((path, node))
            return
        if isinstance(node, dict):
            if is_dict_of_lists(node):
                flattened: List[Dict[str, Any]] = []
                for v in node.values():
                    if is_record_list(v):
                        flattened.extend(v)
                candidates.append((path, flattened))
                return
            for key, sub in node.items():
                walk(sub, path + [key], depth + 1)

    walk(payload, [], 0)
    return candidates


def rank_identity_candidates(records: List[Dict[str, Any]], sample_n: int = 200) -> List[Tuple[str, int, int]]:
    """Ranks every field by uniqueness-within-sample, not a hardcoded name shortlist.

    Returns:
        List of (field_name, unique_count, sampled_n) sorted by unique_count descending.
    """
    sample = records[:sample_n]
    n = len(sample)
    field_values: Dict[str, List[Any]] = defaultdict(list)
    for rec in sample:
        for k, v in rec.items():
            if isinstance(v, (str, int)) and not isinstance(v, bool):
                field_values[k].append(v)

    ranked = []
    for field, values in field_values.items():
        if len(values) < n:
            continue  # only fields present on every sampled record are identity candidates
        ranked.append((field, len(set(values)), n))
    ranked.sort(key=lambda t: -t[1])
    return ranked


def catalog_fields(records: List[Dict[str, Any]], sample_n: int = 200) -> Tuple[Counter, Dict[str, Counter], Dict[str, Any], int]:
    """Catalogs every field's presence count, observed type(s), and one example value.

    Includes one level of nested-dict flattening (e.g. "names.English").

    Returns:
        (field_presence, field_types, examples, sampled_n)
    """
    field_presence: Counter = Counter()
    field_types: Dict[str, Counter] = defaultdict(Counter)
    examples: Dict[str, Any] = {}
    sample = records[:sample_n]

    for rec in sample:
        if not isinstance(rec, dict):
            continue
        for k, v in rec.items():
            field_presence[k] += 1
            field_types[k][type(v).__name__] += 1
            examples.setdefault(k, v)
            if isinstance(v, dict):
                for nk, nv in v.items():
                    key = f"{k}.{nk}"
                    field_presence[key] += 1
                    field_types[key][type(nv).__name__] += 1
                    examples.setdefault(key, nv)

    return field_presence, field_types, examples, len(sample)


def detect_gender_signals(records: List[Dict[str, Any]], sample_n: int = 200) -> List[Dict[str, Any]]:
    """Scans records for fields that plausibly encode gender.

    Two signal types:
      - boolean_field: a field whose name mentions "female" and holds a bool
        (e.g. isFemale=True).
      - value_pattern: a field whose string values mention "female"
        (e.g. form="FEMALE").

    Returns:
        List of signal dicts, sorted by field name within each signal type.
    """
    sample = records[:sample_n]
    boolean_fields, value_fields = set(), set()
    for rec in sample:
        for k, v in rec.items():
            if isinstance(v, bool) and re.search(r"(?i)female", k):
                boolean_fields.add(k)
            if isinstance(v, str) and re.search(r"(?i)female", v):
                value_fields.add(k)
    signals = []
    for f in sorted(boolean_fields):
        signals.append({"signal_type": "boolean_field", "source_field": f, "when_true": "female"})
    for f in sorted(value_fields):
        signals.append({"signal_type": "value_pattern", "source_field": f, "pattern": "(?i)female", "value": "female"})
    return signals


def detect_range_pairs(examples: Dict[str, Any]) -> List[Tuple[str, List[Any]]]:
    """Finds fields whose example value is a 2-element numeric list (e.g. a min/max pair)."""
    return [
        (k, v) for k, v in examples.items()
        if isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v)
    ]


def compute_shape_fingerprint(field_presence: Counter) -> str:
    """Hashes the sorted set of field paths (not values) -- used to detect upstream drift."""
    key_paths = sorted(field_presence.keys())
    return "sha256:" + hashlib.sha256(json.dumps(key_paths).encode("utf-8")).hexdigest()[:16]


class SourceProfiler:
    """Inspects a source's latest raw JSON snapshot and writes/updates its source template.

    Templates live at config/source_templates/<source_key>.yml for single-endpoint
    sources, or config/source_templates/<source_key>_<endpoint>.yml per endpoint for
    multi-endpoint sources -- matching engine.run_source()'s documented template-name
    lookup convention (Task 13). They drive the generic ingestion engine
    (src/engine.py). Re-running the profiler after
    upstream schema drift regenerates auto-detected fields (field_mappings,
    gender_signals, identity_field, source_fingerprint) while preserving any
    human-authored `overrides` verbatim -- overrides that reference a field
    which no longer exists are flagged in `needs_review` rather than silently
    dropped or silently kept broken.
    """

    def __init__(self, raw_dumps_dir: Path = Path("raw_dumps"), templates_dir: Path = Path("config/source_templates")):
        self.raw_dumps_dir = raw_dumps_dir
        self.templates_dir = templates_dir
        self.templates_dir.mkdir(parents=True, exist_ok=True)

    def _resolve_path(self, record: Dict[str, Any], path: str) -> Any:
        if not path:
            # Empty path means "the root object itself" (e.g. primary_path == []
            # joined to ""). Without this early return, path.split(".") on an
            # empty string yields [""], and the loop below would go looking for
            # a literal "" key on the root object -- always missing -- instead
            # of recognizing that the root object IS the node being resolved.
            return record
        node: Any = record
        for part in path.split("."):
            if not isinstance(node, dict) or part not in node:
                return None
            node = node[part]
        return node

    def profile_source(self, source_key: str, endpoint: str) -> Optional[Path]:
        snapshot_dirs = self.raw_dumps_dir / source_key
        if not snapshot_dirs.exists():
            print(f"[Profiler] No raw dumps found for '{source_key}', skipping.")
            return None
        snapshots = sorted([d for d in snapshot_dirs.iterdir() if d.is_dir()])
        if not snapshots:
            return None
        data_file = snapshots[-1] / f"{endpoint}.json"
        if not data_file.exists():
            print(f"[Profiler] No '{endpoint}.json' in latest snapshot for '{source_key}', skipping.")
            return None

        with open(data_file, "r", encoding="utf-8") as f:
            payload = json.load(f)

        candidates = detect_shape(payload)
        if not candidates:
            print(f"[Profiler] No record-shaped list found for '{source_key}/{endpoint}'.")
            return None
        candidates.sort(key=lambda c: (len(c[0]), -len(c[1])))
        primary_path, primary_records = candidates[0]

        identity_candidates = rank_identity_candidates(primary_records)
        identity_field = identity_candidates[0][0] if identity_candidates else "id"

        field_presence, field_types, examples, sample_n = catalog_fields(primary_records)
        gender_signals = detect_gender_signals(primary_records, sample_n)
        range_pairs = detect_range_pairs(examples)

        field_mappings: Dict[str, Any] = {}
        for field in field_presence:
            if "." in field:
                continue  # nested fields get folded in via a dedicated nested_path mapping only when needed
            field_mappings[field] = {"source_field": field, "transform": "direct"}
        for pair_field, _ in range_pairs:
            field_mappings.pop(pair_field, None)
            field_mappings[f"min_{pair_field}"] = {"source_field": pair_field, "transform": "list_index", "index": 0}
            field_mappings[f"max_{pair_field}"] = {"source_field": pair_field, "transform": "list_index", "index": 1}

        # Filename convention matches engine.run_source()'s documented lookup rule
        # (Task 13): a single-endpoint source's template is "{source_key}.yml";
        # a multi-endpoint source's template is "{source_key}_{endpoint}.yml" per
        # endpoint, since profile_all_sources() calls profile_source() once per
        # endpoint and each endpoint's shape/fields are independent -- collapsing
        # them into one file means every call but the last silently overwrites
        # its predecessor.
        if endpoint == source_key:
            template_path = self.templates_dir / f"{source_key}.yml"
        else:
            template_path = self.templates_dir / f"{source_key}_{endpoint}.yml"
        existing_overrides: Dict[str, Any] = {}
        if template_path.exists():
            with open(template_path, "r", encoding="utf-8") as f:
                existing = yaml.safe_load(f) or {}
            existing_overrides = existing.get("overrides", {})

        needs_review = []
        for attr, override_mapping in existing_overrides.items():
            source_field = override_mapping.get("source_field", "")
            probe_record = primary_records[0] if primary_records else {}
            if self._resolve_path(probe_record, source_field) is None and source_field not in field_presence:
                needs_review.append({
                    "field": attr,
                    "reason": f"override for '{attr}' references '{source_field}', which no longer exists in the new shape",
                })
                # the override itself is preserved verbatim in the file (a human must edit it),
                # but it is NOT merged into field_mappings below, so mapping falls back to auto-detected

        template = {
            "source_key": source_key,
            "endpoint": endpoint,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_fingerprint": compute_shape_fingerprint(field_presence),
            "record_extraction": {
                "unwrap_path": primary_path,
                # Judge mode by the node's actual type at primary_path, not by path
                # depth. A depth-based check (len(primary_path) > 0) mis-infers
                # top_level_list for a degenerate single-key dict-of-lists whose
                # flattened records live at the root (primary_path == []) -- the
                # root node there is still a dict, so top_level_list's
                # isinstance(node, list) check in engine.unwrap_to_records fails
                # and extracts zero records. _resolve_path("") now returns the
                # root object itself (see _resolve_path), so this check is safe
                # at any path depth, including the empty/root path.
                "iterate_mode": "dict_of_lists" if isinstance(
                    self._resolve_path(payload, ".".join(primary_path)), dict
                ) else "top_level_list",
            },
            "identity_field": identity_field,
            "field_mappings": field_mappings,
            "gender_signals": gender_signals,
            "overrides": existing_overrides,
            "needs_review": needs_review,
        }

        with open(template_path, "w", encoding="utf-8") as f:
            yaml.dump(template, f, sort_keys=False)

        if needs_review:
            for item in needs_review:
                print(f"[Profiler] WARNING: {source_key}: {item['reason']}")

        return template_path

    def profile_all_sources(self) -> None:
        sources_config_path = Path("config/sources.yml")
        if not sources_config_path.exists():
            return
        with open(sources_config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f)
        for source_key, source_conf in config.get("sources", {}).items():
            endpoints = source_conf.get("endpoints")
            if endpoints:
                for ep in endpoints:
                    self.profile_source(source_key, ep["name"])
            else:
                # single-endpoint source: use the source_key itself as a best-guess endpoint name
                self.profile_source(source_key, source_key)
