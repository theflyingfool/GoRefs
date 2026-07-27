# Sub-project 7c: Compare View — Design

**Status:** Draft, deliberately lighter-weight than usual. Written alongside
7b per the owner's explicit instruction ("let's get both plans/specs
written even if we need to update 7c after running 7b"), since 7c consumes
7b's output (stable `pokemon_instance`/`tag` identity, `referenced_trainer`,
the export/import bundle shape) and its concrete UI needs may shift once
7b is real. Expect this doc to get a revision pass before its own
implementation plan is written.

**Depends on:** Sub-project 7b (identity + merge-gap closure) — specifically
needs `ExportBundle`/`exportTrainer` (§5) and the reconciled, cross-device-
stable `profile.id`/`pokemon_instance.uuid` that only exist after 7b ships.

## 1. What this is

A screen to look at two trainer collections side by side — the current
profile plus one other. "Other" can be: a second local profile (created
manually, or promoted from an imported friend export), or a friend's
profile imported specifically for comparison. Per the core architectural
decision established in 7b, the app treats all of these identically: once
imported, a friend's data is "just another local profile" — there is no
comparison-specific import path, only the reconciliation flow 7b already
builds.

## 2. Entry points

- **Stats page**: a new "Compare" section/tab. Two dropdowns (own account,
  other account) populated from `listProfiles()`.
- **A button on the compare screen itself that triggers import**, so a user
  doesn't have to detour through Settings to bring in a friend's file
  first. This calls the same import function 7b builds for Settings — not
  a separate one.

## 3. What gets compared (starting point, not final)

Owner's own framing, explicitly flagged as a starting point to design
further, not a finished spec:

- Top of page: two side-by-side trainer-name dropdowns.
- A third dropdown underneath: a handful of "common comparison models" —
  candidates to define during implementation, e.g. "who has more species
  registered," "shiny dex gap," "who's missing what the other has caught."
- A manual/free-form search option for more specialized comparisons,
  beyond the canned models above.

This needs its own follow-up brainstorm once 7b's real schema exists to
query against — the exact comparison models, what "gap" means per model
(e.g. does a shiny-gap comparison count `pokemon_instance` rows or
`form_personal.shiny`?), and the actual layout are all open.

## 4. Known future feature, explicitly not built here or in 7b

From the compare screen, select one specimen from each side and hit
"trade": moves that `pokemon_instance` row to the other profile, prompting
for new IVs (IVs change on trade), whether it was lucky (trade-only
attribute), and handling first-time registration/shiny-dex credit if the
receiving trainer hadn't registered that species/shiny before. This is a
real planned feature, not a vague idea, but has no schema or UX design yet
and depends on 7b's `pokemon_instance.uuid` existing to make "this specimen
moved to a different trainer" a well-defined operation. Tracked in
`docs/roadmap.md` per 7b's spec §8; not scoped further here.

## 5. Explicitly out of scope for 7c

- The trade flow above (§4).
- Any comparison model beyond whatever the follow-up brainstorm (§3)
  settles on for a first version.

## 6. Next step

Once 7b is implemented and merged, revisit this doc: confirm the export/
import interfaces it depends on didn't change shape, then run a dedicated
brainstorm on §3's actual comparison models and layout before writing an
implementation plan.
