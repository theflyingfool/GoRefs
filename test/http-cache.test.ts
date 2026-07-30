import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { fetchToCache, hashPathFor, readCachedHash } from "../scripts/ingest/http-cache";
import { hashContent } from "../src/db/content-hash";

function withFetchStub<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as Response;
}

test("fetchToCache defaults to always re-fetching, even when a cached file already exists", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "http-cache-test-"));
  try {
    const cachePath = resolve(dir, "data.json");
    writeFileSync(cachePath, "stale bytes");

    let calls = 0;
    await withFetchStub(
      (async () => {
        calls++;
        return jsonResponse('{"fresh":true}');
      }) as typeof fetch,
      () => fetchToCache("https://example.test/data.json", cachePath),
    );

    assert.equal(calls, 1, "default behavior must fetch even though cachePath already existed");
    assert.equal(readFileSync(cachePath, "utf-8"), '{"fresh":true}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchToCache({ skipIfExists: true }) does not fetch when the file already exists", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "http-cache-test-"));
  try {
    const cachePath = resolve(dir, "sprite.png");
    writeFileSync(cachePath, "already here");

    let calls = 0;
    await withFetchStub(
      (async () => {
        calls++;
        return jsonResponse("should not be written");
      }) as typeof fetch,
      () => fetchToCache("https://example.test/sprite.png", cachePath, { skipIfExists: true }),
    );

    assert.equal(calls, 0, "skipIfExists must skip the fetch entirely when the cache file is already present");
    assert.equal(readFileSync(cachePath, "utf-8"), "already here", "existing content must be untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchToCache({ skipIfExists: true }) still fetches when the file does not exist yet", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "http-cache-test-"));
  try {
    const cachePath = resolve(dir, "sprite.png");

    let calls = 0;
    await withFetchStub(
      (async () => {
        calls++;
        return jsonResponse("binary-ish content");
      }) as typeof fetch,
      () => fetchToCache("https://example.test/sprite.png", cachePath, { skipIfExists: true }),
    );

    assert.equal(calls, 1);
    assert.equal(readFileSync(cachePath, "utf-8"), "binary-ish content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchToCache writes a hash-on-write sidecar that a pure read (no re-hash) can retrieve", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "http-cache-test-"));
  try {
    const cachePath = resolve(dir, "pokedex.json");
    const body = '{"names":{"English":"Bisaflor","Japanese":"フシギダネ"}}'; // non-ASCII, exercises UTF-8 handling

    await withFetchStub((async () => jsonResponse(body)) as typeof fetch, () => fetchToCache("https://example.test/pokedex.json", cachePath));

    const cachedHash = readCachedHash(cachePath);
    assert.ok(cachedHash, "expected a sidecar hash to have been written");
    // The pure-read invariant a later manifest-writing step depends on: the
    // sidecar must equal hashContent() over the UTF-8-decoded cached file,
    // the same encoding every other hashContent caller in this codebase uses.
    assert.equal(cachedHash, hashContent(readFileSync(cachePath, "utf-8")));
    assert.equal(cachedHash, hashContent(body));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchToCache overwrites a stale sidecar hash when the fetched content changes", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "http-cache-test-"));
  try {
    const cachePath = resolve(dir, "types.json");

    await withFetchStub((async () => jsonResponse('{"version":1}')) as typeof fetch, () => fetchToCache("https://example.test/types.json", cachePath));
    const firstHash = readCachedHash(cachePath);

    await withFetchStub((async () => jsonResponse('{"version":2}')) as typeof fetch, () => fetchToCache("https://example.test/types.json", cachePath));
    const secondHash = readCachedHash(cachePath);

    assert.notEqual(firstHash, secondHash);
    assert.equal(secondHash, hashContent('{"version":2}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCachedHash returns undefined when nothing has been fetched to that path yet", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "http-cache-test-"));
  try {
    assert.equal(readCachedHash(resolve(dir, "never-fetched.json")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashPathFor derives a predictable sidecar path", () => {
  assert.equal(hashPathFor("/tmp/foo/pokedex.json"), "/tmp/foo/pokedex.json.hash");
});

test("fetchToCache throws on a non-ok response and leaves an existing cached file (and its hash) untouched", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "http-cache-test-"));
  try {
    const cachePath = resolve(dir, "data.json");
    writeFileSync(cachePath, "good bytes");
    writeFileSync(hashPathFor(cachePath), hashContent("good bytes"));

    await assert.rejects(
      () => withFetchStub((async () => jsonResponse("ignored", false, 500)) as typeof fetch, () => fetchToCache("https://example.test/data.json", cachePath)),
      /Fetch failed: 500/,
    );

    assert.equal(readFileSync(cachePath, "utf-8"), "good bytes", "a failed fetch must not corrupt what's on disk");
    assert.equal(readCachedHash(cachePath), hashContent("good bytes"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
