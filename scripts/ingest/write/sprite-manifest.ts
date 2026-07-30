// The slug (species/form/mega) -> sprite source URL manifest, relocated
// out of build-reference.ts's module-level `spriteManifest` object (now
// transform/species.ts's returned SpeciesBuildResult.spriteManifest) into
// its own write step. Consumed by build-sprites.ts to know which cached
// download maps to which output slug. Kept as a build artifact in the
// ingestion cache (not committed) since it's fully regenerable from the
// same cache the build step already reads.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CACHE_V2_ROOT } from "../http-cache";
import type { AssetPair } from "../sources/pokemon-go-api";

const SPRITE_MANIFEST_OUT = resolve(CACHE_V2_ROOT, "sprite-manifest.json");

export function writeSpriteManifest(spriteManifest: Record<string, AssetPair>): string {
  writeFileSync(SPRITE_MANIFEST_OUT, JSON.stringify(spriteManifest));
  return SPRITE_MANIFEST_OUT;
}
