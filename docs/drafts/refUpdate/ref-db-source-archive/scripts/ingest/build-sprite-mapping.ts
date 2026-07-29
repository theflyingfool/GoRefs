// Bootstraps the §7 image pipeline (docs/v1-tasks/05-image-pipeline.md) from
// PokeMiners/pogo_assets's "Addressable Assets" icon set — a human-readable
// naming convention (pm{dex}.f{FORM}.c{COSTUME}.g{gender}.s.icon.png) rather
// than the opaque numeric form/costume IDs the task doc originally expected,
// discovered while triaging this task. Deliberately conservative: only ships
// art this script can match with real confidence (species base icons; a
// small whitelist of unambiguous regional-form tokens; costumes previously
// confirmed via costume-lookup.json). Everything else — including every
// gender-tagged (.g) file, since g1/g2's exact meaning isn't confirmed, and
// every unwhitelisted/ambiguous form token (Unown's bare letters collide with
// Mewtwo's "A" = Armored, Deoxys/Rotom/Vivillon/Burmy multiforms, etc.) —
// goes to a scratch-dir CSV for hand review instead of being guessed.
//
// Re-run after adding entries to costume-lookup.json (committed, starts
// empty) to auto-match previously-unresolved costumes — this is the
// "only ever check new things" loop the reviewer asked for.

import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import referenceDataJson from "../../src/data/reference.json";
import type { ReferenceData } from "../../src/db/reference-data";
import type { Form } from "../../src/db/types";
import costumeLookupJson from "./costume-lookup.json";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const ASSET_DIR = resolve(REPO_ROOT, "Refs from Obsidian/pogo_assets/Images/Pokemon - 256x256/Addressable Assets");
const SPRITES_DIR = resolve(REPO_ROOT, "public/sprites");
const FORM_SPRITES_DIR = resolve(SPRITES_DIR, "forms");
const SCRATCH_DIR = resolve(REPO_ROOT, "Refs from Obsidian/image-pipeline-staging");

const referenceData = referenceDataJson as unknown as ReferenceData;
const costumeLookup = costumeLookupJson as Record<string, string>;

// Regional-form tokens confident enough to auto-match without hand-checking.
// Deliberately excludes single letters (Unown A–Z / Mewtwo's "A" = Armored
// collide) and anything else ambiguous.
const FORM_TOKEN_WHITELIST: Record<string, string> = {
  ALOLA: "Alolan",
  GALARIAN: "Galarian",
  HISUIAN: "Hisuian",
  PALDEA_COMBAT: "Paldean(Combat)",
  PALDEA_AQUA: "Paldean(Aqua)",
  PALDEA_BLAZE: "Paldean(Blaze)",
  PALDEA: "Paldean",
};

interface ParsedFile {
  fileName: string;
  dex: number;
  formToken: string | null;
  costumeToken: string | null;
  genderToken: string | null;
  shiny: boolean;
}

const FILENAME_RE = /^pm(\d+)(?:\.f([A-Za-z0-9_]+))?(?:\.c([A-Za-z0-9_]+))?(?:\.g(\d+))?(\.s)?\.icon\.png$/;

function parseFileName(fileName: string): ParsedFile | null {
  const match = FILENAME_RE.exec(fileName);
  if (!match) return null;
  return {
    fileName,
    dex: Number(match[1]),
    formToken: match[2] ?? null,
    costumeToken: match[3] ?? null,
    genderToken: match[4] ?? null,
    shiny: match[5] !== undefined,
  };
}

interface ExtraRow {
  reason: string;
  fileName: string;
  dex: number;
  speciesName: string;
  formToken: string;
  costumeToken: string;
  genderToken: string;
}

interface MissingRow {
  formSlug: string;
  speciesName: string;
  dexNumber: number;
  formName: string;
  costumeName: string;
  reason: string;
}

function main() {
  if (!existsSync(ASSET_DIR)) {
    throw new Error(`Asset dir not found: ${ASSET_DIR} — is Refs from Obsidian/pogo_assets checked out?`);
  }

  const speciesByDex = new Map(referenceData.species.map((s) => [s.dexNumber, s]));
  const formsBySpeciesFormName = new Map<string, Form[]>();
  const formsBySpeciesCostumeName = new Map<string, Form[]>();
  const formsBySpecies = new Map<string, Form[]>();
  for (const f of referenceData.forms) {
    (formsBySpecies.get(f.speciesSlug) ?? formsBySpecies.set(f.speciesSlug, []).get(f.speciesSlug)!).push(f);
    const formKey = `${f.speciesSlug}|${f.formName}`;
    (formsBySpeciesFormName.get(formKey) ?? formsBySpeciesFormName.set(formKey, []).get(formKey)!).push(f);
    if (f.costumeName) {
      const costumeKey = `${f.speciesSlug}|${f.costumeName}`;
      (formsBySpeciesCostumeName.get(costumeKey) ?? formsBySpeciesCostumeName.set(costumeKey, []).get(costumeKey)!).push(f);
    }
  }

  const allFiles = readdirSync(ASSET_DIR).filter((f) => f.endsWith(".icon.png"));
  const parsed: ParsedFile[] = [];
  const parseFailures: string[] = [];
  for (const f of allFiles) {
    const p = parseFileName(f);
    if (p) parsed.push(p);
    else parseFailures.push(f);
  }

  mkdirSync(SPRITES_DIR, { recursive: true });
  mkdirSync(FORM_SPRITES_DIR, { recursive: true });
  if (existsSync(SCRATCH_DIR)) rmSync(SCRATCH_DIR, { recursive: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });

  const extraRows: ExtraRow[] = [];
  const matchedFormSlugs = new Set<string>();
  const dexWithAnyBaseIcon = new Set<number>();
  const dexWithAnyAltTaggedFile = new Set<number>();
  let speciesBaseCopied = 0;
  let formMatchesCopied = 0;

  function copyTo(destDir: string, destBaseName: string, srcFileName: string, shiny: boolean) {
    const suffix = shiny ? "-shiny" : "";
    copyFileSync(join(ASSET_DIR, srcFileName), join(destDir, `${destBaseName}${suffix}.png`));
  }

  function toExtra(p: ParsedFile, reason: string) {
    const species = speciesByDex.get(p.dex);
    extraRows.push({
      reason,
      fileName: p.fileName,
      dex: p.dex,
      speciesName: species?.name ?? "(unknown dex)",
      formToken: p.formToken ?? "",
      costumeToken: p.costumeToken ?? "",
      genderToken: p.genderToken ?? "",
    });
    copyFileSync(join(ASSET_DIR, p.fileName), join(SCRATCH_DIR, p.fileName));
  }

  for (const p of parsed) {
    if (p.formToken || p.costumeToken) dexWithAnyAltTaggedFile.add(p.dex);

    const species = speciesByDex.get(p.dex);
    if (!species) {
      toExtra(p, "dex not found in reference.json");
      continue;
    }

    // Never auto-match a gender-tagged variant — g1/g2's exact meaning isn't
    // confirmed against this app's -male/-female slugs, and a wrong guess
    // here is worse than a CSV row.
    if (p.genderToken !== null) {
      toExtra(p, "gender-tagged variant (.g) — meaning not confirmed, needs hand-check");
      continue;
    }

    if (!p.formToken && !p.costumeToken) {
      // Species base icon.
      dexWithAnyBaseIcon.add(p.dex);
      copyTo(SPRITES_DIR, String(p.dex).padStart(3, "0"), p.fileName, p.shiny);
      speciesBaseCopied++;
      continue;
    }

    if (p.costumeToken) {
      const displayName = costumeLookup[p.costumeToken];
      if (!displayName) {
        toExtra(p, "costume codename not yet in costume-lookup.json");
        continue;
      }
      const forms = formsBySpeciesCostumeName.get(`${species.slug}|${displayName}`) ?? [];
      if (forms.length === 0) {
        toExtra(p, `costume-lookup.json maps to "${displayName}" but no matching form.costumeName for this species`);
        continue;
      }
      for (const form of forms) {
        copyTo(FORM_SPRITES_DIR, form.slug, p.fileName, p.shiny);
        matchedFormSlugs.add(form.slug);
      }
      formMatchesCopied++;
      continue;
    }

    // formToken present, no costumeToken.
    const translated = FORM_TOKEN_WHITELIST[p.formToken!];
    if (!translated) {
      toExtra(p, "form token not in the confident-match whitelist");
      continue;
    }
    const forms = formsBySpeciesFormName.get(`${species.slug}|${translated}`) ?? [];
    if (forms.length === 0) {
      toExtra(p, `whitelisted form token "${p.formToken}" -> "${translated}" but no matching form.formName for this species`);
      continue;
    }
    for (const form of forms) {
      copyTo(FORM_SPRITES_DIR, form.slug, p.fileName, p.shiny);
      matchedFormSlugs.add(form.slug);
    }
    formMatchesCopied++;
  }

  // "Forms missing images": a real coverage gap (no candidate art exists at
  // all), NOT the same thing as "a file exists but wasn't confidently
  // matched" (that's extraRows, from the other direction).
  const missingRows: MissingRow[] = [];
  for (const species of referenceData.species) {
    const forms = formsBySpecies.get(species.slug) ?? [];
    const hasBase = dexWithAnyBaseIcon.has(species.dexNumber);
    const hasAnyAltFile = dexWithAnyAltTaggedFile.has(species.dexNumber);

    if (!hasBase && !hasAnyAltFile) {
      // Truly nothing in the dump for this species at all (beyond PokeMiners
      // coverage, or a very new species) — every one of its forms is a real
      // gap, not just an unresolved file.
      for (const form of forms) {
        missingRows.push({
          formSlug: form.slug,
          speciesName: species.name,
          dexNumber: species.dexNumber,
          formName: form.formName,
          costumeName: form.costumeName ?? "",
          reason: "no art of any kind (base or form/costume-tagged) anywhere in the dump for this species",
        });
      }
      continue;
    }

    for (const form of forms) {
      const isStandard = form.formName === "Standard" && form.costumeName === null;
      if (isStandard) {
        // The species-level sprite covers this — unless there's genuinely no
        // base icon (e.g. Unown, which has per-letter art but no plain
        // "Standard" icon at all; not this app's problem to solve here).
        if (!hasBase) {
          missingRows.push({
            formSlug: form.slug,
            speciesName: species.name,
            dexNumber: species.dexNumber,
            formName: form.formName,
            costumeName: form.costumeName ?? "",
            reason: "species has alt-tagged art but no plain base icon for its Standard form",
          });
        }
        continue;
      }
      if (matchedFormSlugs.has(form.slug)) continue;
      // Some file (base and/or alt-tagged) exists for this species, but this
      // specific non-standard form wasn't confidently matched to one. Since
      // *something* plausibly corresponds to it (already surfaced from the
      // file side in extra-images.csv), don't also claim "no art exists" here
      // — that would contradict extra-images.csv and mislead the hand-check.
    }
  }

  function writeCsv(path: string, header: string[], rows: (string | number)[][]) {
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(","), ...rows.map((r) => r.map(esc).join(","))];
    writeFileSync(path, lines.join("\n") + "\n");
  }

  writeCsv(
    join(SCRATCH_DIR, "extra-images.csv"),
    ["reason", "dex", "species_name", "form_token", "costume_token", "gender_token", "file_name"],
    extraRows.map((r) => [r.reason, r.dex, r.speciesName, r.formToken, r.costumeToken, r.genderToken, r.fileName]),
  );

  writeCsv(
    join(SCRATCH_DIR, "forms-missing-images.csv"),
    ["dex", "species_name", "form_name", "costume_name", "form_slug", "reason"],
    missingRows.map((r) => [r.dexNumber, r.speciesName, r.formName, r.costumeName, r.formSlug, r.reason]),
  );

  if (parseFailures.length > 0) {
    writeCsv(
      join(SCRATCH_DIR, "unparsed-filenames.csv"),
      ["file_name"],
      parseFailures.map((f) => [f]),
    );
  }

  // Committed manifest (src/data/, alongside reference.json) so
  // src/ui/sprites.ts's formSpritePath() knows which form.slugs actually got
  // art without needing a runtime file-exists check (this is a bundled
  // static public/ folder, not a queryable filesystem at runtime).
  writeFileSync(
    resolve(REPO_ROOT, "src/data/form-sprite-slugs.json"),
    JSON.stringify([...matchedFormSlugs].sort(), null, 2) + "\n",
  );

  console.log(`Parsed ${parsed.length}/${allFiles.length} .icon.png files (${parseFailures.length} didn't match the naming pattern).`);
  console.log(`Species base icons copied: ${speciesBaseCopied} files -> ${SPRITES_DIR}`);
  console.log(`Confident form matches copied: ${formMatchesCopied} files -> ${FORM_SPRITES_DIR} (${matchedFormSlugs.size} distinct form slugs)`);
  console.log(`Extra (unmatched, needs hand-check): ${extraRows.length} files -> ${SCRATCH_DIR}/extra-images.csv (+ copies)`);
  console.log(`Forms with no art anywhere in the dump: ${missingRows.length} -> ${SCRATCH_DIR}/forms-missing-images.csv`);
}

main();
