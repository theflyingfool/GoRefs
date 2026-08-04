## Port GoBuddy's transform logic into GoRefs' own canonical processing

**Status:** Open

2026-08-03: flagged from the GoBuddy side while implementation-planning its
ingestion swap to pull from this project. Right now, five-plus domains
(`forms`, `megaVariants`, `moves`, `formMoves`, `speciesEvolutions`, `medals`/
`medalTiers`, `playerLevels`/`playerLevelRewards`, `pvpRankRewards`/
`pvpRankRequirements`, and for this first cut `species`/`typeEffectiveness`/
`weatherBoosts` too) only reach real parity with GoBuddy's `reference.json`
via the `refjson_*` shim — a wholesale dump of GoBuddy's own already-processed
output, not independent GoRefs processing. That's fine as a stopgap, but it's
circular: GoBuddy currently processes all its sources itself (slug
generation, gap detection, comparative-gap rules, gender-split forms, etc.
in `scripts/ingest/transform/*.ts`), and GoRefs is just re-serving that
processed result back.

The real target: port that processing *logic* (not just consume its output)
into GoRefs' own Python pipeline (`src/builder.py` and friends), so GoRefs'
canonical tables converge on correctness using the same proven rules GoBuddy
already worked out, applied to GoRefs' own 7 independently-ingested sources
— not by copying GoBuddy's output forever. Each domain currently on the
`refjson_*` shim is a candidate for this, one at a time (matches the
existing "one-line swap once canonical catches up" pattern already used for
the shim-fallback domains). Big, not scoped, not started — logged so it
isn't lost.
