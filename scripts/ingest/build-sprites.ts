// Promotes cached sprite downloads (scripts/ingest/.cache-v2/sprites/, from
// fetch-sprites.ts) into public/sprites/ under our own slug-based naming
// convention (src/ui/sprites.ts), converting each PNG to WebP along the
// way — WebP is meaningfully smaller than PNG for flat icon art like this,
// and everything this app ships to (Capacitor/Android, every browser we
// target) renders it natively. The original PNGs stay in the ingestion
// cache; only WebP output ships in public/sprites/.
//
// This is the only thing that should ever write to public/sprites/ — never
// hand-place a sprite there, or a future re-run of this script won't know
// it exists and won't be able to reason about what's stale.
//
// Called by ingest.ts's sprites step, after fetchSprites() and the build
// step (write/sprite-manifest.ts writes the manifest this reads) — not a
// standalone script.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import sharp from "sharp";
import { CACHE_V2_ROOT } from "./http-cache";
import type { ReferenceData } from "../../src/db/reference-data";

const REFERENCE_PATH = resolve(process.cwd(), "src/data/reference.json");
const MANIFEST_PATH = resolve(CACHE_V2_ROOT, "sprite-manifest.json");
const SPRITE_CACHE_DIR = resolve(CACHE_V2_ROOT, "sprites");
const PUBLIC_SPRITES_DIR = resolve(process.cwd(), "public/sprites");
const FORM_MANIFEST_OUT = resolve(process.cwd(), "src/data/form-sprite-slugs.json");
const MEGA_MANIFEST_OUT = resolve(process.cwd(), "src/data/mega-sprite-slugs.json");

interface AssetPair {
  image?: string;
  shinyImage?: string;
}

export interface BuildSpritesResult {
  converted: number;
  skippedExisting: number;
  missingSource: number;
  formSlugsWithArt: string[];
  megaSlugsWithArt: string[];
}

export async function buildSprites(): Promise<BuildSpritesResult> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing ${MANIFEST_PATH} — run the build step first.`);
  }

  let converted = 0;
  let skippedExisting = 0;
  let missingSource = 0;

  // Skips re-encoding a WebP that's already there — this is the "don't
  // re-grab/re-process what's already local" step for the promoted assets,
  // same idea as fetchToCache's skip-if-exists but one layer up.
  async function writeWebp(sourceUrl: string | undefined, outPath: string): Promise<boolean> {
    if (!sourceUrl) return false;
    if (existsSync(outPath)) {
      skippedExisting++;
      return true;
    }
    const cachedFile = resolve(SPRITE_CACHE_DIR, basename(sourceUrl));
    if (!existsSync(cachedFile)) {
      missingSource++;
      return false;
    }
    await sharp(cachedFile).webp({ lossless: true }).toFile(outPath);
    converted++;
    return true;
  }

  const reference: ReferenceData = JSON.parse(readFileSync(REFERENCE_PATH, "utf-8"));
  const manifest: Record<string, AssetPair> = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

  mkdirSync(PUBLIC_SPRITES_DIR, { recursive: true });
  mkdirSync(resolve(PUBLIC_SPRITES_DIR, "forms"), { recursive: true });
  mkdirSync(resolve(PUBLIC_SPRITES_DIR, "mega"), { recursive: true });

  for (const species of reference.species) {
    const art = manifest[species.slug];
    if (!art) continue;
    const dex = String(species.dexNumber).padStart(3, "0");
    await writeWebp(art.image, resolve(PUBLIC_SPRITES_DIR, `${dex}.webp`));
    await writeWebp(art.shinyImage, resolve(PUBLIC_SPRITES_DIR, `${dex}-shiny.webp`));
  }

  const formSlugsWithArt: string[] = [];
  for (const form of reference.forms) {
    const art = manifest[form.slug];
    if (!art) continue;
    const wroteBase = await writeWebp(art.image, resolve(PUBLIC_SPRITES_DIR, "forms", `${form.slug}.webp`));
    await writeWebp(art.shinyImage, resolve(PUBLIC_SPRITES_DIR, "forms", `${form.slug}-shiny.webp`));
    if (wroteBase) formSlugsWithArt.push(form.slug);
  }

  const megaSlugsWithArt: string[] = [];
  for (const mega of reference.megaVariants) {
    const art = manifest[mega.slug];
    if (!art) continue;
    const wroteBase = await writeWebp(art.image, resolve(PUBLIC_SPRITES_DIR, "mega", `${mega.slug}.webp`));
    await writeWebp(art.shinyImage, resolve(PUBLIC_SPRITES_DIR, "mega", `${mega.slug}-shiny.webp`));
    if (wroteBase) megaSlugsWithArt.push(mega.slug);
  }

  writeFileSync(FORM_MANIFEST_OUT, JSON.stringify(formSlugsWithArt.sort()));
  writeFileSync(MEGA_MANIFEST_OUT, JSON.stringify(megaSlugsWithArt.sort()));

  console.log(`Converted ${converted}, skipped ${skippedExisting} already-present, ${missingSource} missing from the sprite cache (re-run the fetch step to retry).`);
  console.log(`Form art: ${formSlugsWithArt.length}/${reference.forms.length} forms. Mega art: ${megaSlugsWithArt.length}/${reference.megaVariants.length} variants.`);

  return { converted, skippedExisting, missingSource, formSlugsWithArt, megaSlugsWithArt };
}
