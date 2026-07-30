// Typed, parse-only accessor over the pokemongo-shiny community sheet
// (https://github.com/Rplus/pokemongo-shiny), fetched via opensheet.elk.sh.
// Same convention as sources/game-master.ts and sources/pokemon-go-api.ts:
// takes already-`JSON.parse()`d content, not a file path.
//
// Resolving the correct tab (see SHINY_SHEET_URL below) required live
// network access to Google Sheets/opensheet.elk.sh, done once during
// implementation of this module -- not re-derived at runtime.

// The sheet's own "info" tab (gid=0, opensheet path 'info') documents its
// canonical machine-readable data source as:
//   https://opensheet.elk.sh/<id>/'pm2026'
// (single quotes required: unquoted, opensheet/Sheets parses "pm2026" as
// A1-notation cell range PM2026 on the *first* tab and errors with "Range
// (info!PM2026) exceeds grid limits", not as a sheet name -- this bit us
// during resolution, hence documenting it here).
//
// Verified directly against the live sheet (2026-07-27): fetching this URL
// returns 1521 rows shaped exactly like the brief's expected record
// (family_dex/debut/pid/group/tag?/order?/suffix?), zero duplicate `pid`
// values, and is more current (includes a 2026-07-04 entry) than either of
// the two alternates also present in the workbook:
//   - "pm" (hidden tab): different, incompatible shape (`index` field, no
//     `family_dex`, slash-delimited dates) -- not this data.
//   - "pmtest" (hidden tab): same shape and byte-identical to the previously
//     "known-working" `.../4` numeric-index URL, but that numeric index is
//     NOT stable -- opensheet indexes by tab position *including hidden
//     tabs*, confirmed by downloading the workbook and reading
//     xl/workbook.xml's <sheet> order (info=0, pm2026=1, _LastKnownGood=2,
//     pmtest=3, pm=4 at time of writing); inserting or reordering any tab
//     silently repoints index 4 at a different sheet. "pm2026" is also the
//     sheet the workbook's own README/info tab points at, i.e. the intended
//     public data source, not a WIP/test tab.
// If "pm2026" is ever renamed/removed, re-run the resolution steps in this
// comment's git history (fetch the info tab, or download
// `.../export?format=xlsx` and inspect xl/workbook.xml for the current tab
// list) rather than falling back to a numeric index.
export const SHINY_SHEET_URL = "https://opensheet.elk.sh/1l1CXHdge8_2F2ifjMY71f23DJ_98Ei2QNZ9rPdBd8jQ/'pm2026'";

/** Cache-relative path, same "<source>/<file>"-ish convention as PGAPI_FILES/GAME_MASTER_CACHE_PATH. */
export const SHINY_SHEET_CACHE_PATH = "shiny-sheet.json";

export interface ShinySheetRecord {
  /** National-ish family/dex grouping id, as a string (e.g. "1", "999"). Not necessarily a Pokémon GO dex number for every row -- see `group` for the human-readable family name. */
  family_dex: string;
  /** ISO date (YYYY-MM-DD) this pid became available/shiny. */
  debut: string;
  /** Matches pokemon-go-api/assets' filename convention: `pm{id}`, `pm{id}.f{FORM}`, `pm{id}.c{COSTUME}`. */
  pid: string;
  group: string;
  /** Present as "" (not absent) on plenty of real rows -- kept as-is (not coerced to undefined), since absent vs. empty-string is a distinction a later transform step may care about. */
  tag?: string;
  order?: string;
  suffix?: string;
  [key: string]: unknown;
}

export interface ShinySheetSource {
  all(): ShinySheetRecord[];
  /** Looks up a record by `pid` (the pokemon-go-api/assets filename-convention key: `pm{id}[.f{FORM}|.c{COSTUME}]`). Returns at least `debut` when found. */
  byPid(pid: string): ShinySheetRecord | undefined;
}

// Verified against the real pm2026 sheet (1521 rows, 2026-07-27): zero
// duplicate `pid` values, so this is a plain first-seen map build with no
// conflict-warning machinery (unlike game-master.ts's indexByKey, which
// exists specifically because GAME_MASTER *does* have real natural-key
// collisions).
export function createShinySheetSource(raw: ShinySheetRecord[]): ShinySheetSource {
  const byPid = new Map(raw.map((record) => [record.pid, record]));
  return {
    all: () => raw,
    byPid: (pid) => byPid.get(pid),
  };
}
