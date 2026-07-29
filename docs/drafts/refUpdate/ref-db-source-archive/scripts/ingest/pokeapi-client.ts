// Thin fetch wrapper around pokeapi.co: rate-limited, cached to disk so the
// fetch is idempotent/resumable, retries with backoff on 429/5xx.
//
// PokeAPI doesn't publish a hard requests/minute ceiling (their stance is
// aggressive Fastly CDN caching + "don't abuse it," not a stated number).
// REQUESTS_PER_MINUTE below is a conservative assumption (60/min ceiling,
// targeting 75% = 45/min per the user's instruction) — adjust if it proves
// wrong in either direction. See INGESTION_PROGRESS.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = resolve(__dirname, ".cache");

const REQUESTS_PER_MINUTE = 45;
const MIN_DELAY_MS = Math.ceil(60_000 / REQUESTS_PER_MINUTE);
const MAX_RETRIES = 5;

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cachePath(endpoint: string, id: string | number): string {
  return resolve(CACHE_ROOT, endpoint, `${id}.json`);
}

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - elapsed);
  lastRequestAt = Date.now();
}

/**
 * Fetches `https://pokeapi.co/api/v2/{endpoint}/{id}/`, using an on-disk
 * cache at scripts/ingest/.cache/{endpoint}/{id}.json. Never re-fetches
 * something already cached — safe to re-run after an interruption.
 */
export async function fetchPokeApi<T = unknown>(endpoint: string, id: string | number): Promise<T> {
  const path = cachePath(endpoint, id);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  }

  const url = `https://pokeapi.co/api/v2/${endpoint}/${id}/`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    const res = await fetch(url);

    if (res.ok) {
      const json = await res.json();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(json));
      return json as T;
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfterHeader = res.headers.get("retry-after");
      const backoffMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2 ** attempt * 1000;
      console.warn(`  [pokeapi] ${res.status} on ${url}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoffMs);
      continue;
    }

    throw new Error(`PokeAPI request failed: ${res.status} ${res.statusText} for ${url}`);
  }

  throw new Error(`PokeAPI request exhausted retries: ${url}`);
}

export function isCached(endpoint: string, id: string | number): boolean {
  return existsSync(cachePath(endpoint, id));
}
