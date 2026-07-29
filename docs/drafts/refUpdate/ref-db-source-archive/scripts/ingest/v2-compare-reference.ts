// V2 sourcing spike — diffs the parity candidate (v2-build-reference.ts's
// output) against the real src/data/reference.json. Output is a punch
// list, not a pass/fail gate: the point is to see exactly where the new
// sources fall short or disagree, confirming known-expected divergences by
// name rather than assuming them.
//
// Run with: npm run ingest:v2:compare (after ingest:v2:build)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReferenceData } from "../../src/db/reference-data";

const REAL_PATH = resolve(process.cwd(), "src/data/reference.json");
const CANDIDATE_PATH = resolve(process.cwd(), "data-authoring/v2-explore/reference-v2-candidate.json");

function load(path: string): ReferenceData {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function diffSets(label: string, real: Set<string>, candidate: Set<string>, sample = 10): void {
  const missingFromCandidate = [...real].filter((s) => !candidate.has(s));
  const extraInCandidate = [...candidate].filter((s) => !real.has(s));
  console.log(`\n${label}: real=${real.size} candidate=${candidate.size}`);
  console.log(`  in real but not candidate: ${missingFromCandidate.length}${missingFromCandidate.length ? ` (e.g. ${missingFromCandidate.slice(0, sample).join(", ")})` : ""}`);
  console.log(`  in candidate but not real: ${extraInCandidate.length}${extraInCandidate.length ? ` (e.g. ${extraInCandidate.slice(0, sample).join(", ")})` : ""}`);
}

function main() {
  const real = load(REAL_PATH);
  const candidate = load(CANDIDATE_PATH);

  console.log("=== Row counts ===");
  for (const key of ["species", "forms", "formTypes", "megaVariants", "regions", "types", "backgrounds"] as const) {
    console.log(`  ${key}: real=${real[key].length} candidate=${candidate[key].length}`);
  }

  diffSets(
    "species slugs",
    new Set(real.species.map((s) => s.slug)),
    new Set(candidate.species.map((s) => s.slug)),
  );

  diffSets(
    "form slugs",
    new Set(real.forms.map((f) => f.slug)),
    new Set(candidate.forms.map((f) => f.slug)),
    15,
  );

  diffSets(
    "mega variant slugs",
    new Set(real.megaVariants.map((m) => m.slug)),
    new Set(candidate.megaVariants.map((m) => m.slug)),
  );

  console.log("\n=== Gigantamax flag (known discrepancy, see docs/v2-data-source-findings.md §11) ===");
  const realGmax = new Set(real.species.filter((s) => s.canGigantamax).map((s) => s.slug));
  const candidateGmax = new Set(candidate.species.filter((s) => s.canGigantamax).map((s) => s.slug));
  console.log(`  real: ${realGmax.size}, candidate: ${candidateGmax.size}`);
  console.log(`  real-only: ${[...realGmax].filter((s) => !candidateGmax.has(s)).join(", ")}`);

  console.log("\n=== Known expected divergence: Basculegion (#902) ===");
  const basculegionReal = real.species.find((s) => s.dexNumber === 902);
  const basculegionCandidate = candidate.species.find((s) => s.dexNumber === 902);
  console.log(`  real has it: ${Boolean(basculegionReal)}, candidate has it: ${Boolean(basculegionCandidate)} (expected: candidate missing — pokemon-go-api doesn't list it yet)`);

  console.log("\n=== Family grouping (familySlug) ===");
  const realFamilyCount = new Set(real.species.map((s) => s.familySlug)).size;
  const candidateFamilyCount = new Set(candidate.species.map((s) => s.familySlug)).size;
  console.log(`  distinct families: real=${realFamilyCount} candidate=${candidateFamilyCount}`);
  const realFamilyBySlug = new Map(real.species.map((s) => [s.slug, s.familySlug]));
  let familyMismatches = 0;
  const familyMismatchExamples: string[] = [];
  for (const s of candidate.species) {
    const realFamily = realFamilyBySlug.get(s.slug);
    if (realFamily && realFamily !== s.familySlug) {
      familyMismatches++;
      if (familyMismatchExamples.length < 10) familyMismatchExamples.push(`${s.slug} (real: ${realFamily}, candidate: ${s.familySlug})`);
    }
  }
  console.log(`  species with a different familySlug than real: ${familyMismatches}${familyMismatchExamples.length ? ` (e.g. ${familyMismatchExamples.join("; ")})` : ""}`);

  console.log("\n=== Species present in one but not the other, by dex number ===");
  const realDex = new Set(real.species.map((s) => s.dexNumber));
  const candidateDex = new Set(candidate.species.map((s) => s.dexNumber));
  console.log(`  real-only dex numbers: ${[...realDex].filter((d) => !candidateDex.has(d)).join(", ") || "(none)"}`);
  console.log(`  candidate-only dex numbers: ${[...candidateDex].filter((d) => !realDex.has(d)).join(", ") || "(none)"}`);
}

main();
