import { test } from "node:test";
import assert from "node:assert/strict";

import { SHINY_SHEET_URL, createShinySheetSource, type ShinySheetRecord } from "../scripts/ingest/sources/shiny-sheet";

test("SHINY_SHEET_URL resolves to the quoted pm2026 tab, not the fragile numeric index", () => {
  assert.equal(SHINY_SHEET_URL, "https://opensheet.elk.sh/1l1CXHdge8_2F2ifjMY71f23DJ_98Ei2QNZ9rPdBd8jQ/'pm2026'");
});

test("createShinySheetSource indexes by pid and exposes the full list", () => {
  const raw: ShinySheetRecord[] = [
    { family_dex: "1", debut: "2018-03-25", pid: "pm1", group: "Bulbasaur" },
    { family_dex: "1", debut: "2018-03-25", pid: "pm3.fMEGA", group: "Bulbasaur", tag: "", order: "", suffix: "(M)" },
  ];
  const source = createShinySheetSource(raw);

  assert.equal(source.all().length, 2);
  assert.equal(source.byPid("pm1")?.debut, "2018-03-25");
  assert.equal(source.byPid("pm3.fMEGA")?.suffix, "(M)");
  assert.equal(source.byPid("pm999"), undefined);
});

test("empty-string tag/order are preserved as empty strings, not dropped or coerced to undefined", () => {
  const raw: ShinySheetRecord[] = [{ family_dex: "1", debut: "2018-03-25", pid: "pm3.fMEGA", group: "Bulbasaur", tag: "", order: "" }];
  const record = createShinySheetSource(raw).byPid("pm3.fMEGA");

  assert.equal(record?.tag, "");
  assert.equal(record?.order, "");
  assert.equal("tag" in (record ?? {}), true);
});

test("pid keyed by the pokemon-go-api/assets filename convention (pm{id}.f{FORM}/.c{COSTUME})", () => {
  const raw: ShinySheetRecord[] = [
    { family_dex: "999", debut: "2025-07-01", pid: "pm999.fCOIN_A1", group: "Gimmighoul_coin", tag: "costume", suffix: "(9)" },
  ];
  const source = createShinySheetSource(raw);

  assert.equal(source.byPid("pm999.fCOIN_A1")?.group, "Gimmighoul_coin");
});
