## `--test`'s `needs_review` entries aren't surfaced

**Status:** Open

Templates can carry a `needs_review` list (low-confidence profiler guesses,
e.g. a fallback field that might produce a placeholder-looking value) but
`scripts/user_source_coverage_test.py`'s `LedgerReplayTester` doesn't
currently read or report on them as a distinct category -- a human has to
know to open `config/source_templates/*.yml` and grep for `needs_review`
manually. Would be a reasonable `--test` output addition: a summary list of
every unresolved `needs_review` entry across all templates.
