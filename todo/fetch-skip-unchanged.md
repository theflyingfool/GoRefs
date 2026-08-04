## `--fetch` should skip sources with no upstream change

**Status:** Open

2026-08-03: flagged from the GoBuddy side alongside the "expose a
last-updated timestamp" item below, while designing its ingestion swap to
pull from this project. `--fetch` currently always re-fetches every source
fresh, unconditionally. It should check whether a source's upstream has
actually changed (e.g. via a cheap HEAD/ETag/hash check, source-dependent)
and skip writing a new `raw_dumps/<source>/<timestamp>/` snapshot when
nothing changed. Two motivations: (1) avoids redundant network calls on
every fetch, (2) directly reduces the `raw_dumps/` unbounded-growth problem
in the item just below — most of its ~20 accumulated snapshot dirs likely
represent runs where nothing upstream actually changed. Not started.
