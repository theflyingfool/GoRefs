# pogoapi.net snapshot

A one-time full capture of every pogoapi.net `/api/v1/*.json` endpoint (47
files), taken because pogoapi.net is unmaintained/stale and may not stay
reachable indefinitely. This is a **vendored historical snapshot**, not a
live dependency — the ingestion pipeline does not fetch pogoapi.net going
forward. Data here is known to be stale in places (see
docs/v2-data-source-findings.md and the ingestion-consolidation plan for
specifics — e.g. its shadow_pokemon.json list is missing ~226 species
GAME_MASTER shows as shadow-eligible).

Fetched: 2026-07-28T06:03:11Z
Source: https://pogoapi.net/api/v1/<endpoint>.json

Purpose: preserve whatever unique, non-reproducible data this source holds
(e.g. medal/badge display names and descriptions, which GAME_MASTER does
not carry at all — confirmed by direct search) before it's lost. Future
updates to any derived reference data should diff against this committed
snapshot, not silently overwrite it — that's the point of committing it
before any processing happens, per owner decision.

This directory is intentionally NOT gitignored.
