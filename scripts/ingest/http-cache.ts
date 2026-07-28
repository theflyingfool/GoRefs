// Generic fetch-and-cache helper for the V2 sourcing spike (pogoapi.net +
// pokemon-go-api). Same idea as pokeapi-client.ts's disk-cache-by-id
// pattern, generalized to an arbitrary URL -> arbitrary cache file path,
// since these sources aren't one-resource-per-id like PokeAPI.
//
// Not part of the real ingestion pipeline — see docs/v2-schema-design.md
// and the V2 ingestion plan. Cache root: scripts/ingest/.cache-v2/
// (gitignored, same convention as .cache/).
//
// Default behavior is always-fetch-fresh, not skip-if-cached — see
// fetchToCache's doc comment for why (ingestion-manifest.json change
// detection needs it) and FetchToCacheOptions for the opt-out large
// binaries like sprites should use.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashContent } from "../../src/db/content-hash";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CACHE_V2_ROOT = resolve(__dirname, ".cache-v2");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sidecar hash file path for a given cache file -- see fetchToCache's hash-on-write doc comment. */
export function hashPathFor(cachePath: string): string {
  return `${cachePath}.hash`;
}

/**
 * Reads back the hash `fetchToCache` wrote alongside `cachePath` on its
 * last successful fetch, without re-reading/re-hashing the cached content
 * itself. Returns undefined if `cachePath` was never fetched with hashing
 * (or the sidecar was removed independently of the cache file).
 */
export function readCachedHash(cachePath: string): string | undefined {
  const hashPath = hashPathFor(cachePath);
  if (!existsSync(hashPath)) return undefined;
  return readFileSync(hashPath, "utf-8").trim();
}

export interface FetchToCacheOptions {
  /**
   * When true, skip the fetch entirely if `cachePath` already exists on
   * disk -- the old default behavior, appropriate for large, rarely-
   * changing binaries like sprite downloads, where re-fetching ~7000 files
   * every run is wasteful and they aren't part of ingestion-manifest.json's
   * change detection anyway. When false (the default), always re-fetch:
   * required for the small JSON ingestion sources, since a skip-if-exists
   * cache means repeated runs re-hash the same stale bytes and can never
   * observe a real upstream change.
   */
  skipIfExists?: boolean;
}

/**
 * Downloads `url` to `cachePath` (absolute path). By default always
 * re-fetches, overwriting whatever's cached (see FetchToCacheOptions);
 * pass `{ skipIfExists: true }` to restore the old skip-if-already-cached
 * behavior. No retries/backoff — these are static JSON/CDN-hosted assets,
 * not a rate-limited API; a plain failure is loud, leaves any previously
 * cached file untouched (nothing is written until the response is known to
 * be ok), and is re-runnable.
 *
 * Hash-on-write: after a successful fetch, computes `hashContent` (from
 * src/db/content-hash.ts) over the response body decoded as UTF-8 text and
 * writes it to a `<cachePath>.hash` sidecar via `readCachedHash`/
 * `hashPathFor`. This is the same encoding every other `hashContent` caller
 * uses (build-reference.ts hashes UTF-8 JSON text) — for the small JSON
 * sources this pipeline fetches, that's an exact, meaningful fingerprint.
 * For binary payloads (sprites, fetched with skipIfExists: true) a UTF-8
 * decode is lossy (invalid byte sequences collapse to U+FFFD), so the
 * sidecar hash is a coarser "did this decode differently" signal rather
 * than a true content hash — acceptable because sprites are outside
 * ingestion-manifest.json's change detection. A later manifest-writing step
 * can read these sidecars directly (`readCachedHash`) instead of re-hashing
 * every cached file itself.
 */
export async function fetchToCache(url: string, cachePath: string, options: FetchToCacheOptions = {}): Promise<void> {
  const { skipIfExists = false } = options;
  if (skipIfExists && existsSync(cachePath)) return;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, buf);
  writeFileSync(hashPathFor(cachePath), hashContent(buf.toString("utf-8")), "utf-8");
}

/**
 * Runs `items` through `worker` with at most `concurrency` in flight at
 * once, and a small delay between dispatches — polite default for hitting
 * many small files on someone else's GitHub Pages / raw.githubusercontent
 * hosting, not a documented-limit API like PokeAPI.
 */
export async function withConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  let failures = 0;

  async function runOne() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        await worker(items[index], index);
      } catch (err) {
        failures++;
        console.warn(`  [http-cache] item ${index} failed: ${(err as Error).message}`);
      }
      await sleep(20);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runOne()));

  if (failures > 0) {
    console.warn(`  [http-cache] ${failures}/${items.length} item(s) failed — re-run to retry (a failed fetch never touches the on-disk cache, so already-cached items are unaffected).`);
  }
}
