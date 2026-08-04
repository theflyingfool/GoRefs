## Idea (not scoped, not now): web page for flagging known-ambiguous data

**Status:** Open

Spitballed 2026-08-02, explicitly deferred -- needs real design work before
any implementation, not a task to pick up as-is. The idea: a section of the
web explorer where users could see/select fields GoRefs already knows are
ambiguous or unresolved (e.g. the `badge_id` collision above, or entity-ID
namespace gaps in `KNOWN_ISSUES.md`) and submit a correction or a vote.

Open questions, none answered yet:
- Don't want to force GitHub sign-in as the auth gate (excludes casual
  players who'd actually know the answer, e.g. "yes I have this exact GO
  Fest badge and here's what game_master calls mine").
- Also don't want fully anonymous/unverified submissions -- no spam-quality
  gate at all invites garbage data.
- One spitballed (unvalidated) idea: a Google Form requiring a Pokémon GO
  in-game username + friend code as a lightweight identity/anti-spam gate,
  not because it proves anything cryptographically, but because it raises
  the cost of drive-by garbage submissions and gives a way to follow up.
  Not committed to this approach.
- Whatever the mechanism, submissions should land somewhere reviewed before
  affecting canonical data -- this is not meant to auto-apply user input to
  `output/GoRefs_Master.duckdb`.

Needs a proper brainstorming/design pass (see `superpowers:brainstorming`)
before it becomes a real task -- flagging the idea here so it isn't lost,
not asking for it to be built.

**Update 2026-08-02 (Task 24 prep): this is further along than "spitballed" --
most of the plumbing already exists, unused.** `config/sources.yml`'s
`local_authoring` entry is explicitly named `"Confirmed Owner Submissions &
Overrides"` (`trust_tier: "confirmed_owner_submission"`, mapped to priority 1
in `builder.py`'s `TRUST_HIERARCHY` -- the highest trust level in the whole
system) and lists `data-authoring/community-submissions.json` as one of its
two source files (the other, `costume-lookup.json`, is live -- Task 23).
`src/ingest_community_submissions.py` already exists and is a real, if
minimal, CLI tool: `python src/ingest_community_submissions.py --csv <path>`
parses a CSV (its own docstring says "from Google Forms / GitHub Issue
Forms"), maps `pokemon_name`/`attribute`/`value`/`Timestamp` columns (with
fallback column-name aliases suggesting it was written against a specific
real form's export headers), and writes each row into
`community-submissions.json` tagged `trust_tier: "confirmed_owner_submission"`
-- the exact string that already resolves to priority 1. So the intended
design is: Google Form (or GitHub Issue Form) → CSV export → this script →
`community-submissions.json` → picked up automatically by the
`local_authoring` fetcher on its next snapshot → (needs a
`local_authoring_community-submissions.yml` template once real data exists,
not written yet since there's nothing to profile) → claims at priority 1,
same tier as `costume-lookup.json`.

**What's actually still missing, now more precisely scoped:**
1. No collection front-end exists yet -- no Google Form, no GitHub Issue Form
   template, nothing a real user would fill out.
2. **No verification/anti-spam gate at all.** The script hardcodes
   `trust_tier: "confirmed_owner_submission"` on every row unconditionally --
   it trusts the entire CSV blindly. Anyone who can get a row into that CSV
   (however that ends up working) gets treated as maximum-trust, higher than
   every upstream game-data source. This is the real design gap the
   "ambiguous data" idea above was circling -- not "should we let users
   submit data" (the pipe already exists) but "what stops garbage from
   riding in at the highest trust tier once it does."
3. No template for `community-submissions.json` yet (correctly deferred by
   Task 23, since there's no data to profile against).

Given priority-1 blind trust is a real correctness risk once any submission
path exists, don't wire up a Google Form or similar collection mechanism
without first deciding on real verification -- this is exactly why the
ambiguous-data-flagging idea above needs a proper design pass before
becoming a task, not a reason to rush the missing 20%.
