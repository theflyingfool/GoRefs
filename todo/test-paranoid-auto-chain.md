## Idea (not pressing, may never happen): `--test-paranoid` auto-chains into `--test`, eventually "run everything"

**Status:** Open

Spitballed 2026-08-02 while designing the rebuilt `--test-paranoid`
(`docs/superpowers/specs/2026-08-02-data-parity-paranoid-check-design.md`).
Once the paranoid check produces its report, `--test-paranoid` could
automatically kick off the regular `--test` run that consumes it, instead
of that being a separate manual step. Further out, and much less certain:
`--test-paranoid` is explicitly meant to be over-the-top thorough, so it
could eventually grow into running essentially every database check this
project has (ledger replay, the paranoid field-coverage scan, whatever
else accumulates) as one single "throw everything at it" command. No
design work has gone into this, no task exists for it, and it may never
get built -- just don't want the idea lost.
