## Automatic re-profiling on source fingerprint drift

**Status:** Open

`SourceProfiler` computes and stores `source_fingerprint` per template, but
nothing currently diffs a fresh fetch's fingerprint against the stored one
to detect upstream schema drift automatically. Re-profiling today is manual
only (`--deep-dive <source>`). This was part of the original design intent
(see git history / `docs/superpowers/specs/2026-07-30-generic-ingestion-engine-design.md`
if still present) but was never scheduled as its own task. Worth doing once
the generic engine has been live long enough to have hit a real upstream
schema change.
