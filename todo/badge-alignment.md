## GAME_MASTER badge alignment (from GoBuddy's evaluation, 2026-07-30)

**Status:** Open

GoBuddy's own ingestion does a two-pointer subsequence alignment against
GAME_MASTER specifically to keep a live FK
(`medal_progress_personal.medal_slug`) in sync with badge definitions.
GoRefs' `badges` table has no equivalent alignment step -- not a bug in
GoRefs itself (this repo has no such FK to maintain), but relevant if
GoRefs' badges table is ever consumed by GoBuddy or a similar downstream
project: that consumer would need to rebuild this alignment logic, not
reuse anything from here. Also relevant to `KNOWN_ISSUES.md`'s existing
"`badge_id` collisions" entry (382 badges collapsing onto 184 keys) --
fixing that collision is a prerequisite for any consumer-side alignment
being reliable.
