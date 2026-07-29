import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFlags, runPipeline, type PipelineStep } from "../scripts/ingest/ingest";

test("parseFlags recognizes --skip-sqlite (independent of --skip-sprites and --check)", () => {
  assert.deepEqual(parseFlags(["--skip-sqlite"]), { skipSprites: false, skipSqlite: true, check: false });
  assert.deepEqual(parseFlags([]), { skipSprites: false, skipSqlite: false, check: false });
  assert.deepEqual(parseFlags(["--skip-sprites", "--skip-sqlite", "--check"]), { skipSprites: true, skipSqlite: true, check: true });
});

test("runPipeline never calls a step's run() when its skip predicate returns true -- not just a log line", async () => {
  const calls: string[] = [];
  const steps: PipelineStep[] = [
    { name: "fetch", run: async () => void calls.push("fetch") },
    { name: "sqlite", run: async () => void calls.push("sqlite"), skip: (f) => f.skipSqlite },
    { name: "manifest", run: async () => void calls.push("manifest") },
  ];

  await runPipeline(steps, { skipSprites: false, skipSqlite: true, check: false });

  assert.deepEqual(calls, ["fetch", "manifest"], "the sqlite step's run() must not execute when --skip-sqlite is set");
});

test("runPipeline calls every step's run() when no skip flags are set", async () => {
  const calls: string[] = [];
  const steps: PipelineStep[] = [
    { name: "fetch", run: async () => void calls.push("fetch") },
    { name: "sqlite", run: async () => void calls.push("sqlite"), skip: (f) => f.skipSqlite },
    { name: "manifest", run: async () => void calls.push("manifest") },
  ];

  await runPipeline(steps, { skipSprites: false, skipSqlite: false, check: false });

  assert.deepEqual(calls, ["fetch", "sqlite", "manifest"]);
});
