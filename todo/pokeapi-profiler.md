## `pokeapi` profiler auto-discovery gap

**Status:** Open

`pokeapi` is a multi-endpoint source (`pokemon`, `pokemon_species`, `type`,
`move`), but unlike `pokemon_go_api` and `pogoapi_net`, its endpoints are
discovered dynamically at fetch time rather than declared statically in
`config/sources.yml`. The profiler (`src.profiler.SourceProfiler`) only knows
about endpoints listed in `config/sources.yml`, so neither
`uv run go_refs.py --deep-dive pokeapi` (assumes endpoint name == source key)
nor `--deep-dive all` (reads `sources.yml`'s `endpoints:` list) can currently
discover `pokeapi`'s per-endpoint raw dumps automatically. The `pokemon`
endpoint's template (`config/source_templates/pokeapi_pokemon.yml`, used by
this cutover) was generated with a direct `profiler.profile_source("pokeapi",
"pokemon")` call as a one-off workaround. Do not add a static `endpoints:`
list to `config/sources.yml` for `pokeapi` to fix this -- the fetcher's
`if not endpoints:` branch treats a non-empty `endpoints` config as
authoritative and would disable its dynamic index-discovery behavior
entirely. A real fix needs the profiler (or `--deep-dive`) taught to read a
multi-endpoint source's *actual* raw-dump directory contents when
`sources.yml` doesn't enumerate `endpoints`, rather than assuming a single
`{source_key}.json` file.
