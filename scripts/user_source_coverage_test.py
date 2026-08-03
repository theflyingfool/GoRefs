#!/usr/bin/env python3
"""Ledger-replay coverage suite for GoRefs.

Reads the _claims_ledger table the last --build produced, re-derives each
(entity_id, attribute)'s expected winner using the same trust-tier priority
the resolver used, and asserts the canonical table actually holds that value.
Does not independently re-parse raw JSON -- that duplication is what degraded
the previous version of this suite into a tautology.

Usage:
    PYTHONPATH=. uv run python scripts/user_source_coverage_test.py
"""
from pathlib import Path
from typing import Any, Dict, Optional
import duckdb
import pandas as pd


# Sentinel distinguishing "we don't yet know how to map this entity_id prefix
# to a canonical table" from "we looked and found no matching row/column".
# Claims against unmapped prefixes are not checkable yet -- they belong in an
# `unmapped` bucket, not `gaps`, or every future domain's claims would read as
# failures until this file is taught how to look them up.
_UNMAPPED = object()

# Claim attribute names that the resolver deliberately renames on the way into
# a canonical column (see builder.py's species-assembly loop, which maps the
# "generation" claim key onto the "gen" column). Keeping the alias here -- not
# in the builder -- avoids widening this task's scope into domain-emission code.
_ATTRIBUTE_ALIASES = {"generation": "gen"}

# pokemon_go_api's pokedex template emits raw "POKEMON_TYPE_x" strings as two
# separate claims, primary_type_raw/secondary_type_raw, that builder.py combines
# (strip the "POKEMON_TYPE_" prefix, capitalize, drop empties) into the single
# canonical `types` list column -- see builder.py's species-assembly loop for
# the identical transform. Neither claim maps 1:1 onto a column, so these two
# attributes need list-membership handling instead of whole-value equality.
_COMBINED_TYPE_ATTRIBUTES = {"primary_type_raw", "secondary_type_raw"}


class _TypesListMatch:
    """Sentinel canonical value for primary_type_raw/secondary_type_raw claims:
    the canonical `types` column is a list combining both claims, not a single
    scalar equal to either one on its own. Wraps that list so comparisons can
    check membership (after applying the same prefix-strip + capitalize
    transform builder.py applies) instead of doing whole-value equality."""

    def __init__(self, types_list: Any):
        self.types_list = types_list if isinstance(types_list, list) else []


class LedgerReplayTester:
    def __init__(self, db_path: Path = Path("output/GoRefs_Master.duckdb")):
        self.db_path = db_path
        self.con = duckdb.connect(str(db_path), read_only=True)
        self._canonical_cache: Dict[str, pd.DataFrame] = {}

    def _find_canonical_value(self, entity_id: str, attribute: str) -> Any:
        """Best-effort lookup: entity_id encodes the domain as its prefix
        (e.g. "pokemon_dex_1" -> species/forms tables keyed by dex_number).

        Returns `_UNMAPPED` when the entity_id's prefix isn't one this suite
        knows how to resolve yet (claim-tracked domains grow incrementally as
        later tasks cut over more sources). Returns None when the prefix IS
        mapped but no matching canonical row/column was actually found --
        that's a real gap, not an unmapped domain.
        """
        column = _ATTRIBUTE_ALIASES.get(attribute, attribute)
        if entity_id.startswith("pokemon_dex_"):
            dex_str = entity_id.replace("pokemon_dex_", "")
            if not dex_str.isdigit():
                return _UNMAPPED
            dex = int(dex_str)
            if attribute in _COMBINED_TYPE_ATTRIBUTES:
                df = self._load("species")
                if "types" in df.columns and "dex_number" in df.columns:
                    match = df[df["dex_number"] == dex]
                    if not match.empty:
                        return _TypesListMatch(self._normalize(match.iloc[0]["types"]))
                return None
            for table in ("species", "forms"):
                df = self._load(table)
                if column in df.columns and "dex_number" in df.columns:
                    match = df[df["dex_number"] == dex]
                    if not match.empty:
                        return self._normalize(match.iloc[0][column])
            return None
        elif entity_id.startswith("badge_"):
            badge_id = entity_id.replace("badge_", "")
            df = self._load("badges")
            if column in df.columns and "badge_id" in df.columns:
                match = df[df["badge_id"] == badge_id]
                if not match.empty:
                    return self._normalize(match.iloc[0][column])
            return None
        return _UNMAPPED  # unmapped entity prefixes aren't checkable yet

    @staticmethod
    def _values_match(claim_value: Any, canonical_value: Any) -> bool:
        """Compares a raw claim value to a resolved canonical value.

        Normally a straight stringified equality check. When canonical_value
        is a `_TypesListMatch` (primary_type_raw/secondary_type_raw), applies
        the same "POKEMON_TYPE_" prefix-strip + capitalize transform builder.py
        applies before checking whether the result is one of the two values
        combined into the canonical `types` list, since no single claim equals
        the whole list on its own.
        """
        if isinstance(canonical_value, _TypesListMatch):
            transformed = str(claim_value).replace("POKEMON_TYPE_", "").capitalize()
            return transformed in canonical_value.types_list
        return str(claim_value) == str(canonical_value)

    @staticmethod
    def _normalize(value: Any) -> Any:
        """Coerces numpy/pandas array-likes (e.g. a VARCHAR[] column value) into
        plain Python lists before str() comparison, so a canonical list column
        compares equal to the ledger's stringified Python list rather than to
        numpy's repr of the same data."""
        if hasattr(value, "tolist"):
            return value.tolist()
        return value

    def _load(self, table: str) -> pd.DataFrame:
        if table not in self._canonical_cache:
            try:
                self._canonical_cache[table] = self.con.execute(f'SELECT * FROM "{table}"').df()
            except Exception:
                self._canonical_cache[table] = pd.DataFrame()
        return self._canonical_cache[table]

    def run_suite(self) -> Dict[str, Any]:
        ledger = self.con.execute("SELECT * FROM _claims_ledger").df()
        by_source: Dict[str, Dict[str, int]] = {}
        total_gaps = 0
        total_unmapped = 0

        grouped = ledger.groupby(["entity_id", "attribute"])
        for (entity_id, attribute), group in grouped:
            winner_row = group.loc[group["priority"].astype(int).idxmin()]
            canonical_value = self._find_canonical_value(entity_id, attribute)
            is_unmapped = canonical_value is _UNMAPPED

            for _, claim_row in group.iterrows():
                source = claim_row["source"]
                by_source.setdefault(
                    source, {"matched": 0, "overridden": 0, "collision": 0, "gaps": 0, "unmapped": 0}
                )
                if is_unmapped:
                    by_source[source]["unmapped"] += 1
                    total_unmapped += 1
                elif self._values_match(claim_row["value"], canonical_value):
                    by_source[source]["matched"] += 1
                elif self._values_match(winner_row["value"], canonical_value) and claim_row["source"] != winner_row["source"]:
                    # A different, lower-priority source lost the resolution and
                    # the higher-priority winner's value is what's actually in
                    # canonical -- that's a legitimate cross-source override.
                    by_source[source]["overridden"] += 1
                elif self._values_match(winner_row["value"], canonical_value) and claim_row["source"] == winner_row["source"]:
                    # The SAME source emitted two disagreeing values for this
                    # (entity_id, attribute). One source shouldn't have two
                    # opinions about one real entity's attribute -- this means
                    # entity_id is colliding across two logically-different
                    # real-world things (e.g. the badge_id-collision bug this
                    # suite caught: distinct badges sharing one derived key).
                    # Surface it as its own bucket rather than silently folding
                    # it into `overridden`, where it would be indistinguishable
                    # from a normal trust-tier override.
                    by_source[source]["collision"] += 1
                else:
                    by_source[source]["gaps"] += 1
                    total_gaps += 1

        report_lines = [
            "| Source | Matched | Overridden | Collision | Gaps | Unmapped |",
            "|---|---|---|---|---|---|",
        ]
        for source, counts in sorted(by_source.items()):
            report_lines.append(
                f"| `{source}` | {counts['matched']} | {counts['overridden']} | {counts['collision']} | "
                f"{counts['gaps']} | {counts['unmapped']} |"
            )
        report_text = "\n".join(report_lines)
        Path("output").mkdir(exist_ok=True)
        Path("output/source_coverage_report.md").write_text(report_text, encoding="utf-8")
        print(report_text)
        print(f"\nTotal gaps: {total_gaps} (unmapped/not-yet-checkable claims: {total_unmapped})")

        return {"by_source": by_source, "total_gaps": total_gaps, "total_unmapped": total_unmapped}

    def close(self) -> None:
        self.con.close()


if __name__ == "__main__":
    tester = LedgerReplayTester()
    tester.run_suite()
    tester.close()
