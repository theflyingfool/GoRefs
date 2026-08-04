## `assets` source is defined but barely populated (20 sprites, no manifest)

**Status:** Open

2026-08-03: noticed while implementation-planning GoBuddy's ingestion swap.
`config/sources.yml` already defines `assets_base_url`
(`raw.githubusercontent.com/pokemon-go-api/assets`) and `asset_dump_dir`
(`raw_dumps/assets`) — the same underlying sprite source GoBuddy's own
sprite pipeline downloads from (indirectly, via pokemon-go-api's pokedex.json
image URLs). But `raw_dumps/assets/` currently has only 20 files
(`pm1.icon.png`-`pm20.icon.png`, base species icons only — no forms,
costumes, region variants, mega, or shiny art), no `.meta.json` tracking it
like every other source has, and no slug/species manifest mapping files to
species. Not usable as a real sprite source today. If this gets built out to
full coverage + a manifest, GoRefs could eventually become the sprite source
for consumers too (not just reference data), removing the need for a
downstream app to fetch sprites separately. Not started; flagged only as a
possibility worth not losing.
