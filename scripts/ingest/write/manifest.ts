// Writes scripts/ingest/.cache-v2/ingestion-manifest.json, a small,
// committed (see .gitignore's negation for this one file inside the
// otherwise-gitignored .cache-v2/) record of exactly which upstream source
// snapshot the last ingest run consumed:
//   - GAME_MASTER: the latest commit SHA touching GAME_MASTER.json in
//     alexelgt/game_masters (GitHub API) — GAME_MASTER.json itself has no
//     version field of its own, so this is the only stable "what changed"
//     signal.
//   - pokemon-go-api: the content hash http-cache.ts's fetchToCache now
//     computes on every fetch (hash-on-write sidecar), one per cached file.
//   - shiny sheet: same content-hash approach, single file.
// `ingest.ts --check` fetches fresh, writes a new manifest, and diffs it
// against the last *committed* one (git show HEAD:...) to answer "did any
// upstream source change since the reference data currently shipped was
// built" without running the (much slower) build/slug-check/sprite steps.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_V2_ROOT, readCachedHash } from "../http-cache";
import { PGAPI_FILES } from "../sources/pokemon-go-api";
import { SHINY_SHEET_CACHE_PATH } from "../sources/shiny-sheet";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const MANIFEST_CACHE_RELATIVE_PATH = "ingestion-manifest.json";
const MANIFEST_PATH = resolve(CACHE_V2_ROOT, MANIFEST_CACHE_RELATIVE_PATH);
// Git-relative path used both for the negated .gitignore entry and for
// `git show HEAD:<path>` below.
const MANIFEST_REPO_RELATIVE_PATH = "scripts/ingest/.cache-v2/ingestion-manifest.json";

const GAME_MASTER_COMMITS_API = "https://api.github.com/repos/alexelgt/game_masters/commits?path=GAME_MASTER.json&per_page=1";

export interface IngestionManifest {
  gameMaster: { commitSha: string; fetchedAt: string };
  pokemonGoApi: { files: Record<string, string>; fetchedAt: string };
  shinySheet: { contentHash: string; fetchedAt: string };
}

/** GitHub requires a User-Agent header on unauthenticated REST calls or it 403s. */
async function fetchGameMasterCommitSha(): Promise<string> {
  const res = await fetch(GAME_MASTER_COMMITS_API, { headers: { "User-Agent": "pogo-buddy-ingest" } });
  if (!res.ok) throw new Error(`GitHub commits API failed: ${res.status} ${res.statusText}`);
  const commits = (await res.json()) as { sha: string }[];
  const sha = commits[0]?.sha;
  if (!sha) throw new Error("GitHub commits API returned no commits for GAME_MASTER.json");
  return sha;
}

/**
 * Builds and writes the manifest from what's currently in the cache (i.e.
 * call this AFTER the fetch step, not before) plus a fresh GAME_MASTER
 * commit-SHA lookup.
 */
export async function writeManifest(): Promise<IngestionManifest> {
  const fetchedAt = new Date().toISOString();
  const commitSha = await fetchGameMasterCommitSha();

  const files: Record<string, string> = {};
  for (const relPath of Object.keys(PGAPI_FILES)) {
    files[relPath] = readCachedHash(resolve(CACHE_V2_ROOT, relPath)) ?? "";
  }

  const shinySheetHash = readCachedHash(resolve(CACHE_V2_ROOT, SHINY_SHEET_CACHE_PATH)) ?? "";

  const manifest: IngestionManifest = {
    gameMaster: { commitSha, fetchedAt },
    pokemonGoApi: { files, fetchedAt },
    shinySheet: { contentHash: shinySheetHash, fetchedAt },
  };

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Reads back the last *committed* manifest (git HEAD), not the working-tree copy `writeManifest` just wrote. Returns null if none is committed yet. */
export function loadCommittedManifest(): IngestionManifest | null {
  try {
    const content = execFileSync("git", ["show", `HEAD:${MANIFEST_REPO_RELATIVE_PATH}`], { cwd: REPO_ROOT, encoding: "utf-8" });
    return JSON.parse(content) as IngestionManifest;
  } catch {
    return null;
  }
}

/** Human-readable list of what changed between two manifests, empty if identical. */
export function diffManifests(before: IngestionManifest, after: IngestionManifest): string[] {
  const diffs: string[] = [];
  if (before.gameMaster.commitSha !== after.gameMaster.commitSha) {
    diffs.push(`GAME_MASTER: ${before.gameMaster.commitSha} -> ${after.gameMaster.commitSha}`);
  }
  const allFileKeys = new Set([...Object.keys(before.pokemonGoApi.files), ...Object.keys(after.pokemonGoApi.files)]);
  for (const key of allFileKeys) {
    const beforeHash = before.pokemonGoApi.files[key];
    const afterHash = after.pokemonGoApi.files[key];
    if (beforeHash !== afterHash) diffs.push(`pokemon-go-api ${key}: ${beforeHash ?? "(absent)"} -> ${afterHash ?? "(absent)"}`);
  }
  if (before.shinySheet.contentHash !== after.shinySheet.contentHash) {
    diffs.push(`shiny sheet: ${before.shinySheet.contentHash} -> ${after.shinySheet.contentHash}`);
  }
  return diffs;
}

export { MANIFEST_PATH, MANIFEST_REPO_RELATIVE_PATH };
