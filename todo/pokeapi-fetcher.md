## `pokeapi` fetcher enhancement

**Status:** Open

Its current fetcher (`src/fetchers/pokeapi.py`) only pulls list endpoints
(`{name, url}` pairs) -- genuinely mappable data (flavor text, genera/category)
requires per-resource detail fetching (~1000+ additional HTTP calls across
species/moves). Deferred until there's a concrete consumer need; the generic
engine (this plan) is now in place to receive the mapped output whenever this
is picked up.
