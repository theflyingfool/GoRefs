import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { diffManifests, writeManifest, type IngestionManifest } from "../scripts/ingest/write/manifest";
import { CACHE_V2_ROOT, hashPathFor } from "../scripts/ingest/http-cache";
import { PGAPI_FILES } from "../scripts/ingest/sources/pokemon-go-api";
import { SHINY_SHEET_CACHE_PATH } from "../scripts/ingest/sources/shiny-sheet";

function withFetchStub<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function manifestAt(overrides: Partial<IngestionManifest> = {}): IngestionManifest {
  return {
    gameMaster: { commitSha: "abc123", fetchedAt: "2026-01-01T00:00:00.000Z" },
    pokemonGoApi: { files: { "pgapi/pokedex.json": "hash1" }, fetchedAt: "2026-01-01T00:00:00.000Z" },
    shinySheet: { contentHash: "hash2", fetchedAt: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

test("diffManifests reports no diffs when manifests are identical", () => {
  const a = manifestAt();
  const b = manifestAt();
  assert.deepEqual(diffManifests(a, b), []);
});

test("diffManifests reports a GAME_MASTER commit SHA change", () => {
  const before = manifestAt({ gameMaster: { commitSha: "abc123", fetchedAt: "2026-01-01T00:00:00.000Z" } });
  const after = manifestAt({ gameMaster: { commitSha: "def456", fetchedAt: "2026-01-02T00:00:00.000Z" } });
  const diffs = diffManifests(before, after);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /GAME_MASTER: abc123 -> def456/);
});

test("diffManifests reports a per-file pokemon-go-api hash change", () => {
  const before = manifestAt({ pokemonGoApi: { files: { "pgapi/pokedex.json": "h1", "pgapi/types.json": "h2" }, fetchedAt: "x" } });
  const after = manifestAt({ pokemonGoApi: { files: { "pgapi/pokedex.json": "h1-new", "pgapi/types.json": "h2" }, fetchedAt: "y" } });
  const diffs = diffManifests(before, after);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /pgapi\/pokedex\.json: h1 -> h1-new/);
});

test("diffManifests reports a shiny sheet content-hash change", () => {
  const before = manifestAt({ shinySheet: { contentHash: "old", fetchedAt: "x" } });
  const after = manifestAt({ shinySheet: { contentHash: "new", fetchedAt: "y" } });
  const diffs = diffManifests(before, after);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /shiny sheet: old -> new/);
});

test("diffManifests reports multiple simultaneous changes", () => {
  const before = manifestAt();
  const after = manifestAt({
    gameMaster: { commitSha: "different", fetchedAt: "y" },
    shinySheet: { contentHash: "different", fetchedAt: "y" },
  });
  const diffs = diffManifests(before, after);
  assert.equal(diffs.length, 2);
});

test("writeManifest reads GAME_MASTER commit SHA from the GitHub commits API, and content hashes from the cache's hash sidecars", async () => {
  // write/manifest.ts's cache paths are CACHE_V2_ROOT-relative constants,
  // not injectable -- so this test writes real hash sidecars into the real
  // (gitignored) CACHE_V2_ROOT for the paths writeManifest reads. Whatever
  // was already there (e.g. from a real `npm run ingest` run) is snapshotted
  // and restored in `finally` so this test doesn't clobber a developer's
  // real cache state.
  const sidecarPaths = [...Object.keys(PGAPI_FILES).map((relPath) => resolve(CACHE_V2_ROOT, relPath)), resolve(CACHE_V2_ROOT, SHINY_SHEET_CACHE_PATH)].map(
    hashPathFor,
  );
  const snapshots = sidecarPaths.map((p) => (existsSync(p) ? readFileSync(p, "utf-8") : undefined));
  // writeManifest also overwrites the manifest file itself -- snapshot/restore
  // that too so this test doesn't leave test data behind for a subsequent
  // real ingest run (or commit) to accidentally pick up.
  const manifestPath = resolve(CACHE_V2_ROOT, "ingestion-manifest.json");
  const manifestSnapshot = existsSync(manifestPath) ? readFileSync(manifestPath, "utf-8") : undefined;

  try {
    for (const relPath of Object.keys(PGAPI_FILES)) {
      const cachePath = resolve(CACHE_V2_ROOT, relPath);
      mkdirSync(resolve(cachePath, ".."), { recursive: true });
      writeFileSync(hashPathFor(cachePath), `hash-for-${relPath}`, "utf-8");
    }
    const shinyCachePath = resolve(CACHE_V2_ROOT, SHINY_SHEET_CACHE_PATH);
    mkdirSync(resolve(shinyCachePath, ".."), { recursive: true });
    writeFileSync(hashPathFor(shinyCachePath), "shiny-hash", "utf-8");

    const manifest = await withFetchStub(
      (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [{ sha: "deadbeef" }],
        }) as unknown as Response) as typeof fetch,
      () => writeManifest(),
    );

    assert.equal(manifest.gameMaster.commitSha, "deadbeef");
    assert.equal(manifest.pokemonGoApi.files["pgapi/pokedex.json"], "hash-for-pgapi/pokedex.json");
    assert.equal(manifest.shinySheet.contentHash, "shiny-hash");
    assert.ok(manifest.gameMaster.fetchedAt);
  } finally {
    sidecarPaths.forEach((p, i) => {
      const snapshot = snapshots[i];
      if (snapshot === undefined) rmSync(p, { force: true });
      else writeFileSync(p, snapshot, "utf-8");
    });
    if (manifestSnapshot === undefined) rmSync(manifestPath, { force: true });
    else writeFileSync(manifestPath, manifestSnapshot, "utf-8");
  }
});

test("writeManifest throws when the GitHub commits API fails", async () => {
  await assert.rejects(
    () =>
      withFetchStub(
        (async () => ({ ok: false, status: 403, statusText: "Forbidden" }) as unknown as Response) as typeof fetch,
        () => writeManifest(),
      ),
    /GitHub commits API failed/,
  );
});
