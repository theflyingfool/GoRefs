# Sub-project 6: Capacitor → Tauri Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Capacitor with Tauri as GoBuddy's native shell — real on-disk SQLite everywhere (Android + a new desktop build), single connection code path, Capacitor removed entirely.

**Architecture:** A new `src-tauri/` Rust project (via `cargo tauri init` + `cargo tauri android init`) hosts the webview. `src/db/sqlite-client.ts` drops its `Capacitor.getPlatform()` dispatch for one path backed by `@tauri-apps/plugin-sql`, wrapped in a new `tauri-sqlite-connection.ts` adapter that exposes the exact same 5-method surface `migrations.ts`/`reference-sync.ts` already call — so those two files need zero changes. `src/shared/file-download.ts` drops its Capacitor Filesystem+Share branch for `@tauri-apps/plugin-dialog`'s `save()` (a native save dialog everywhere, SAF-backed on Android so "Save to Drive" works without a dedicated share plugin) + `@tauri-apps/plugin-fs`'s `writeTextFile()`. `npm run dev` becomes `cargo tauri dev`.

**Tech Stack:** Tauri 2.x, `@tauri-apps/plugin-sql`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-dialog`, Rust (already installed: rustc 1.97.1, `tauri-cli` 2.11.4, Android NDK via Android Studio, all 4 Android Rust targets already added via `rustup target add`).

## Global Constraints

- **Full Capacitor removal, no dual-shell.** Every `@capacitor/*` and `@capacitor-community/*` package, `capacitor.config.ts`, and the `android/` directory (the old Capacitor-generated native project) are deleted once the Tauri build is verified working on both targets. No fallback path.
- **Single SQLite backend.** `sql.js`/`jeep-sqlite` are not kept as a web/test fallback. The app runs via `cargo tauri dev`/`cargo tauri build` only — there is no more plain-browser dev target. Unit tests keep using `node:sqlite` via the existing `test/node-sqlite-connection.ts` (unaffected by this migration).
- **e2e coverage gap is accepted, not bridged.** The existing Playwright suite (`e2e/*.spec.ts`, `playwright.config.ts`) drives a plain browser against `npm run dev`'s Vite server — that target stops existing the moment `npm run dev` becomes `cargo tauri dev` (a plain browser has no `window.__TAURI__`, so the app can't boot). Per owner decision 2026-07-24, cut over immediately rather than keep a transitional browser-testable backend alive. This plan retires the Playwright suite and logs a roadmap follow-up to rebuild e2e coverage on `tauri-driver` (WebDriver) as its own future sub-project — building that is explicitly out of scope here.
- **16KB Android page-size linker flag** (`-Wl,-z,max-page-size=16384`) is added now for Android release builds, not deferred.
- **Desktop packaging**: just get a working `cargo tauri build` for the host (Linux) platform. Installer/signing/distribution format is an explicit non-goal of this plan.
- **Android share/export mechanism**: `@tauri-apps/plugin-dialog`'s `save()` (SAF-backed on Android — lets the user pick Google Drive or any other registered document provider as the destination) + `@tauri-apps/plugin-fs`'s `writeTextFile()`. One mechanism for desktop and Android both — no community share plugin needed.
- Existing project invariants (CLAUDE.md): user data must remain portable; avoid unnecessary external dependencies; don't duplicate sources of truth.

---

## File Structure

New files:
- `src-tauri/` — the Tauri Rust project (Cargo.toml, tauri.conf.json, src/main.rs, capabilities/, icons/), created by `cargo tauri init`/`cargo tauri android init`, not hand-written.
- `src/db/sqlite-connection.ts` — the shared `SQLiteDBConnection`-shaped TypeScript interface (currently imported from `@capacitor-community/sqlite`, which is being removed).
- `src/db/tauri-sqlite-connection.ts` — the real adapter backed by `@tauri-apps/plugin-sql`.

Modified files:
- `src/db/sqlite-client.ts` — single Tauri code path, no platform dispatch.
- `src/shared/file-download.ts` — `plugin-dialog` + `plugin-fs`, no Capacitor branch.
- `src/data/boot-rescue-read.ts`, `src/data/completion-stats-sql.ts`, `src/db/reference-sync.ts`, `src/db/drizzle-client.ts`, `src/db/migrations.ts`, `test/node-sqlite-connection.ts` — import `SQLiteDBConnection` from the new `src/db/sqlite-connection.ts` instead of `@capacitor-community/sqlite`.
- `package.json` — `dev` becomes `cargo tauri dev`; `android:sync`/`android:build`/`android:release`/`android:export` become `cargo tauri android build`/`cargo tauri android build --release`; `test:e2e` removed; Capacitor deps removed, Tauri deps added.
- `docs/architecture.md`, `docs/commands.md`, `docs/data-model.md`, `README.md`, `docs/install-guide.md` — Capacitor references updated to Tauri.
- `docs/roadmap.md` — new follow-up items logged (e2e rebuild on `tauri-driver`, desktop packaging decision).

Deleted:
- `capacitor.config.ts`, `android/` (old Capacitor native project — Tauri's Android project lives at `src-tauri/gen/android/`, generated by `cargo tauri android init`), `playwright.config.ts`, `e2e/`.
- `@capacitor/core`, `@capacitor/android`, `@capacitor/filesystem`, `@capacitor/share`, `@capacitor/cli`, `@capacitor/assets`, `@capacitor-community/sqlite`, `jeep-sqlite`, `sql.js`, `@playwright/test` (npm deps).

---

### Task 1: Scaffold the Tauri project

**Files:**
- Create: `src-tauri/` (via `cargo tauri init`)
- Modify: `package.json` (add `@tauri-apps/api`, `@tauri-apps/cli` as deps)
- Modify: `.gitignore` (add `src-tauri/target/`, `src-tauri/gen/`)

**Interfaces:**
- Produces: a running `cargo tauri dev` command that opens a window showing the current Vite-built app (no SQLite yet — that's Task 3).

- [ ] **Step 1: Install the JS-side Tauri packages**

```bash
npm install --save @tauri-apps/api
npm install --save-dev @tauri-apps/cli
```

- [ ] **Step 2: Run `cargo tauri init`**

From the repo root:

```bash
cargo tauri init
```

When prompted, answer:
- App name: `PoGo Buddy`
- Window title: `PoGo Buddy`
- Web assets location (`../dist`): `../dist`
- Dev server URL: `http://localhost:1420` — **override this in Step 3**, `cargo tauri init`'s prompt default doesn't match this repo's Vite port.
- Dev command: `npm run dev:vite` — this doesn't exist yet, will be added in Step 3.
- Build command: `npm run build`

This creates `src-tauri/` with `Cargo.toml`, `tauri.conf.json`, `src/main.rs`, `src/lib.rs`, `build.rs`, `capabilities/default.json`, and `icons/`.

- [ ] **Step 3: Fix up `tauri.conf.json` and add a `dev:vite` script**

Add a `dev:vite` script to `package.json` (plain Vite, no Tauri host — this is what `cargo tauri dev` spawns internally to serve the frontend while it builds/runs the Rust host):

```json
"dev:vite": "vite",
```

Edit `src-tauri/tauri.conf.json`'s `build` block to:

```json
{
  "build": {
    "beforeDevCommand": "npm run dev:vite",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "identifier": "com.theflyingfool.pogobuddy",
  "productName": "PoGo Buddy"
}
```

(`5173` is Vite's own default port — confirmed via `vite.config.ts`, which doesn't override it; `playwright.config.ts`'s `5183` was a deliberately distinct port to avoid colliding with a dev server already running, which no longer applies once Playwright is retired in Task 8.)

Set `identifier` to match the existing Capacitor `appId` (`com.theflyingfool.pogobuddy`, from `capacitor.config.ts`) so the Android app's package name doesn't change on upgrade.

- [ ] **Step 4: Verify the bare shell boots**

```bash
npm run build
cargo tauri dev
```

Expected: a native window opens showing the app's current UI (it will fail to load data — no SQLite connection exists yet, that's expected and fixed in Task 4). Confirms the Rust toolchain, `tauri.conf.json`, and the dev command wiring all work before adding any plugins.

- [ ] **Step 5: Commit**

```bash
git add src-tauri package.json package-lock.json .gitignore
git commit -m "Scaffold Tauri project shell (no plugins yet)"
```

---

### Task 2: Extract the shared `SQLiteDBConnection` type

**Files:**
- Create: `src/db/sqlite-connection.ts`
- Modify: `src/data/boot-rescue-read.ts:7`, `src/data/completion-stats-sql.ts:9`, `src/db/reference-sync.ts:17`, `src/db/drizzle-client.ts:23`, `src/db/migrations.ts:51`, `test/node-sqlite-connection.ts:14`

**Interfaces:**
- Produces: `SQLiteDBConnection` type, importable from `../db/sqlite-connection` (or the correct relative path per file), with the exact same method surface these six files already use today.

Every one of these six files only imports `SQLiteDBConnection` as a **type** (`import type { SQLiteDBConnection } from "@capacitor-community/sqlite"`) — none of them import any value from the package. This task moves that type to a project-owned file so Task 7 can remove the `@capacitor-community/sqlite` package without breaking these imports.

- [ ] **Step 1: Create `src/db/sqlite-connection.ts`**

```ts
// The subset of @capacitor-community/sqlite's SQLiteDBConnection interface
// that this project's DB layer (migrations.ts, reference-sync.ts,
// drizzle-client.ts, completion-stats-sql.ts, boot-rescue-read.ts) actually
// calls. Kept here (rather than importing the real @capacitor-community/sqlite
// package) so any SQLite backend — Tauri's plugin-sql (tauri-sqlite-connection.ts)
// or node:sqlite (test/node-sqlite-connection.ts) — can be adapted to this
// same shape without depending on the Capacitor package.

export interface SQLiteDBConnection {
  query(statement: string, values?: unknown[]): Promise<{ values?: Record<string, unknown>[] }>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<{ changes?: { changes?: number; lastId?: number } }>;
  execute(statements: string, transaction?: boolean): Promise<{ changes?: { changes?: number } }>;
  beginTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
}
```

- [ ] **Step 2: Update the six importers**

In each of these files, replace:

```ts
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
```

with (adjusting the relative path per file's location):

```ts
import type { SQLiteDBConnection } from "./sqlite-connection"; // src/db/*.ts files
import type { SQLiteDBConnection } from "../db/sqlite-connection"; // src/data/*.ts files
import type { SQLiteDBConnection } from "../src/db/sqlite-connection"; // test/node-sqlite-connection.ts
```

Concretely:
- `src/data/boot-rescue-read.ts:7` → `import type { SQLiteDBConnection } from "../db/sqlite-connection";`
- `src/data/completion-stats-sql.ts:9` → `import type { SQLiteDBConnection } from "../db/sqlite-connection";`
- `src/db/reference-sync.ts:17` → `import type { SQLiteDBConnection } from "./sqlite-connection";`
- `src/db/drizzle-client.ts:23` → `import type { SQLiteDBConnection } from "./sqlite-connection";`
- `src/db/migrations.ts:51` → `import type { SQLiteDBConnection } from "./sqlite-connection";`
- `test/node-sqlite-connection.ts:14` → `import type { SQLiteDBConnection } from "../src/db/sqlite-connection";`

- [ ] **Step 3: Run the type checker and unit tests**

```bash
npx tsc -b
npm test
```

Expected: both pass unchanged — this task only moves a type definition, no runtime behavior changes. `@capacitor-community/sqlite` is still installed at this point (removed in Task 7), so this is a pure refactor with nothing to break.

- [ ] **Step 4: Commit**

```bash
git add src/db/sqlite-connection.ts src/data/boot-rescue-read.ts src/data/completion-stats-sql.ts src/db/reference-sync.ts src/db/drizzle-client.ts src/db/migrations.ts test/node-sqlite-connection.ts
git commit -m "Extract SQLiteDBConnection type out of @capacitor-community/sqlite"
```

---

### Task 3: `tauri-sqlite-connection.ts` adapter + `plugin-sql` wiring

**Files:**
- Create: `src/db/tauri-sqlite-connection.ts`
- Modify: `package.json` (add `@tauri-apps/plugin-sql` dependency), `src-tauri/Cargo.toml` (add the `tauri-plugin-sql` crate), `src-tauri/src/lib.rs` (register the plugin), `src-tauri/capabilities/default.json` (grant `sql:default` + `sql:allow-execute`)

**Interfaces:**
- Consumes: `SQLiteDBConnection` type from `src/db/sqlite-connection.ts` (Task 2).
- Produces: `tauriSqliteConnection(): Promise<SQLiteDBConnection>`, importable from `../db/tauri-sqlite-connection`.

This can't be unit-tested under `node:test` — `@tauri-apps/plugin-sql` only works inside a real Tauri-hosted webview (it calls `invoke()`, which requires `window.__TAURI_INTERNALS__`). This mirrors today's `src/db/sqlite-client.ts`, which also has no unit tests and is verified by running the app. Verification here is a manual `cargo tauri dev` smoke test in Step 5.

- [ ] **Step 1: Add the plugin (JS + Rust sides)**

```bash
npm install --save @tauri-apps/plugin-sql
cargo add tauri-plugin-sql --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 2: Register the plugin in `src-tauri/src/lib.rs`**

Find the `tauri::Builder::default()` chain and add `.plugin(tauri_plugin_sql::Builder::default().build())`:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Grant write permissions in `src-tauri/capabilities/default.json`**

The plugin's default capability (`sql:default`) only grants `allow-close`/`allow-load`/`allow-select` — reads only. Add `sql:allow-execute` explicitly (this exact gotcha was found and fixed during the pre-implementation spike):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "sql:default",
    "sql:allow-execute"
  ]
}
```

- [ ] **Step 4: Write `src/db/tauri-sqlite-connection.ts`**

```ts
// Adapter exposing the SQLiteDBConnection surface (src/db/sqlite-connection.ts)
// that src/db/migrations.ts and src/db/reference-sync.ts call, backed by
// @tauri-apps/plugin-sql's Database class. Mirrors test/node-sqlite-connection.ts's
// role for unit tests — this is the real one, used by src/db/sqlite-client.ts.
//
// plugin-sql's Database has no begin/commit/rollback methods of its own;
// SQLite treats those as plain SQL statements, so they're sent through
// execute() same as any other DDL/DML.

import Database from "@tauri-apps/plugin-sql";
import type { SQLiteDBConnection } from "./sqlite-connection";

const DB_PATH = "sqlite:gobuddy.db";

export async function tauriSqliteConnection(): Promise<SQLiteDBConnection> {
  const db = await Database.load(DB_PATH);

  return {
    async query(statement, values) {
      const rows = await db.select<Record<string, unknown>[]>(statement, values ?? []);
      return { values: rows };
    },
    async run(statement, values) {
      const result = await db.execute(statement, values ?? []);
      return { changes: { changes: result.rowsAffected, lastId: result.lastInsertId } };
    },
    async execute(statements) {
      const result = await db.execute(statements);
      return { changes: { changes: result.rowsAffected } };
    },
    async beginTransaction() {
      await db.execute("BEGIN");
    },
    async commitTransaction() {
      await db.execute("COMMIT");
    },
    async rollbackTransaction() {
      await db.execute("ROLLBACK");
    },
  };
}
```

- [ ] **Step 5: Manual verification via `cargo tauri dev`**

This plugin can't run under `node:test` (see note above) — verify by hand:

```bash
npm run build
cargo tauri dev
```

In the opened window's devtools console (right-click → Inspect, or `Ctrl+Shift+I`), run:

```js
const { tauriSqliteConnection } = await import("/src/db/tauri-sqlite-connection.ts");
const db = await tauriSqliteConnection();
await db.execute("CREATE TABLE IF NOT EXISTS smoke_test (id INTEGER PRIMARY KEY, note TEXT)");
await db.run("INSERT INTO smoke_test (note) VALUES (?)", ["hello from tauri-sqlite-connection"]);
console.log(await db.query("SELECT * FROM smoke_test"));
```

Expected: logs `{ values: [{ id: 1, note: "hello from tauri-sqlite-connection" }] }`. This confirms the exact adapter shape works end-to-end before Task 4 wires it into the app's real boot path.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json src/db/tauri-sqlite-connection.ts
git commit -m "Add tauri-sqlite-connection adapter backed by @tauri-apps/plugin-sql"
```

---

### Task 4: Rewire `sqlite-client.ts` to the single Tauri path

**Files:**
- Modify: `src/db/sqlite-client.ts`

**Interfaces:**
- Consumes: `tauriSqliteConnection()` from `src/db/tauri-sqlite-connection.ts` (Task 3).
- Produces: `getDb(): Promise<SQLiteDBConnection>` (unchanged signature), `persistDb(): Promise<void>` (unchanged signature, now a no-op).

`src/data/sqlite-repository.ts` calls both `getDb()` and `persistDb()` throughout (confirmed: `persistDb()` is called after nearly every write). Neither this task nor any later one touches `sqlite-repository.ts` — both functions keep their exact signatures so every call site keeps compiling unchanged.

- [ ] **Step 1: Rewrite `src/db/sqlite-client.ts`**

```ts
// Bootstraps the real on-device SQLite connection via @tauri-apps/plugin-sql.
// Tauri's plugin-sql writes straight to a real SQLite file on every platform
// it runs on (desktop and Android both) — there's no separate "web platform"
// concept anymore (see docs/superpowers/specs/2026-07-24-sub-project-6-capacitor-to-tauri-design.md):
// the app only ever runs inside a Tauri-hosted webview now, via `cargo tauri
// dev`/`cargo tauri build`, never a plain browser. getDb()/persistDb()'s
// callers (src/data/sqlite-repository.ts) don't need to know or care which
// platform they're on — persistDb() is a no-op here because there's no
// in-memory store to flush (unlike the old jeep-sqlite/IndexedDB path).

import { tauriSqliteConnection } from "./tauri-sqlite-connection";
import type { SQLiteDBConnection } from "./sqlite-connection";

let connectionPromise: Promise<SQLiteDBConnection> | null = null;

/** Opens (or returns the already-open) on-device SQLite connection. Safe to call more than once — reuses the same connection. */
export function getDb(): Promise<SQLiteDBConnection> {
  if (!connectionPromise) {
    connectionPromise = tauriSqliteConnection();
  }
  return connectionPromise;
}

/** No-op: plugin-sql writes straight to disk on every call, there's nothing to flush. Kept so sqlite-repository.ts's existing call sites don't need to change. */
export async function persistDb(): Promise<void> {}
```

- [ ] **Step 2: Manual verification via `cargo tauri dev`**

```bash
npm run build
cargo tauri dev
```

Expected: the app boots past "Loading your dex…", reference data syncs, and the Dex grid renders. Log a test catch via Log-a-catch, confirm it appears in Collection. Close and reopen the app (quit `cargo tauri dev`, run it again) — confirm the logged catch is still there, proving data survived a real process restart against a real on-disk file (not just an in-memory session).

- [ ] **Step 3: Commit**

```bash
git add src/db/sqlite-client.ts
git commit -m "Rewire sqlite-client.ts to the single Tauri connection path"
```

---

### Task 5: `plugin-fs` + `plugin-dialog` file export

**Files:**
- Modify: `src/shared/file-download.ts`, `package.json` (add `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-dialog`), `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: `downloadTextFile(content: string, options: SaveTextFileOptions): Promise<void>` (unchanged signature — `src/features/settings/personal-data-transfer.ts` and the Coverage Report CSV export both call this and need zero changes).

`@tauri-apps/plugin-fs`'s Cargo feature `dialog` auto-extends the filesystem write scope to include whatever path the user just picked via `plugin-dialog`'s `save()` — without it, `writeTextFile()` would be rejected by the fs scope for any path outside the app's own sandboxed data directory (which is the whole point: letting the user save to Drive, Downloads, or anywhere else they pick).

- [ ] **Step 1: Add both plugins (JS + Rust), with the `dialog` feature on `plugin-fs`**

```bash
npm install --save @tauri-apps/plugin-fs @tauri-apps/plugin-dialog
cargo add tauri-plugin-fs --manifest-path src-tauri/Cargo.toml --features dialog
cargo add tauri-plugin-dialog --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 2: Register both plugins in `src-tauri/src/lib.rs`**

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Grant permissions in `src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "sql:default",
    "sql:allow-execute",
    "fs:default",
    "dialog:default"
  ]
}
```

- [ ] **Step 4: Rewrite `src/shared/file-download.ts`**

```ts
// Generic "hand the user a file" flow, shared by any feature that needs to
// let the user save a file for later use outside the app (Settings' personal
// data export, Coverage Report's per-gap CSV export).
//
// One mechanism on every platform this app now ships on (desktop, Android):
// plugin-dialog's save() opens a native save dialog and returns the path the
// user picked. On Android this is backed by the Storage Access Framework, so
// "Save to Drive" (or any other app registered as a document provider) is one
// of the destinations the user can pick — no dedicated share-sheet plugin
// needed (Tauri doesn't ship one; confirmed against the full official plugin
// list during Sub-project 6's design). plugin-fs's writeTextFile() then
// writes the content to that path; the fs plugin's "dialog" Cargo feature
// (see src-tauri/Cargo.toml) auto-extends the write scope to cover whatever
// path the user just picked.

import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export interface SaveTextFileOptions {
  suggestedName: string;
  mimeType: string;
  /** Shown as the save dialog's title. */
  description: string;
}

export async function downloadTextFile(content: string, options: SaveTextFileOptions): Promise<void> {
  const path = await save({
    title: options.description,
    defaultPath: options.suggestedName,
  });
  if (path === null) {
    return; // user cancelled
  }
  await writeTextFile(path, content);
}
```

Note: `mimeType` is now unused (no `Blob` construction, no file extension filter was specified) — kept in `SaveTextFileOptions` since both call sites (`personal-data-transfer.ts`, Coverage Report's CSV export) already pass it and removing the field would be an unrelated signature change outside this task's scope.

- [ ] **Step 5: Manual verification via `cargo tauri dev`**

```bash
npm run build
cargo tauri dev
```

Go to Settings → export personal data. Confirm the native save dialog opens, pick a destination, confirm the file is written with the expected JSON content. Repeat for Coverage Report's CSV export.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json src/shared/file-download.ts
git commit -m "Replace Capacitor Filesystem+Share with plugin-fs + plugin-dialog"
```

---

### Task 6: Android toolchain — init, 16KB linker flag, build scripts

**Files:**
- Create: `src-tauri/gen/android/` (via `cargo tauri android init`)
- Modify: `src-tauri/Cargo.toml` (Android release linker flags), `package.json` (`android:*` scripts)

**Interfaces:**
- Produces: `npm run android:build` / `npm run android:release` producing a working debug/release APK via `cargo tauri android build [--release]`, replacing the old Gradle-via-Capacitor flow.

- [ ] **Step 1: Initialize the Android project**

```bash
cargo tauri android init
```

This generates `src-tauri/gen/android/` (a new native Android project, separate from and replacing the old Capacitor-generated `android/` directory, which is deleted in Task 7).

- [ ] **Step 2: Add the 16KB page-size linker flag for release builds**

In `src-tauri/Cargo.toml`, add:

```toml
[target.'cfg(target_os = "android")']
rustflags = ["-C", "link-args=-Wl,-z,max-page-size=16384"]
```

This was confirmed necessary during the pre-implementation spike (Android's compatibility shim otherwise shows a one-time "Android App Compatibility" dialog on newer Android versions for `.so` files not aligned to a 16KB page size). Applying it for all Android builds (not just release) is simplest and has no downside — debug builds are only cosmetically affected without it, but there's no reason to special-case debug vs. release here.

- [ ] **Step 3: Update `package.json`'s Android scripts**

Replace:

```json
"android:sync": "vite build && npx cap sync android",
"android:build": "npm run android:sync && cd android && ./gradlew assembleDebug",
"android:release": "npm run android:sync && cd android && ./gradlew assembleRelease",
"android:export": "export JAVA_HOME=/opt/android-studio/jbr && export ANDROID_HOME=$HOME/Android/Sdk"
```

with:

```json
"android:build": "cargo tauri android build",
"android:release": "cargo tauri android build --release"
```

(`android:sync` and `android:export` have no Tauri equivalent needed — `cargo tauri android build` builds the frontend and packages the APK in one step, and this repo's shell already has `ANDROID_HOME`/`JAVA_HOME` set globally, confirmed via the pre-implementation spike succeeding without per-command env exports.)

- [ ] **Step 4: Verify a debug build**

```bash
npm run android:build
```

Expected: completes and produces a debug APK under `src-tauri/gen/android/app/build/outputs/apk/`. Install it on a connected device or emulator (`adb install <path-to-apk>`) and confirm the app boots, the Dex grid loads, and a test catch logs successfully and persists across an app restart (same check as Task 4 Step 2, now on Android).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/gen/android src-tauri/Cargo.toml src-tauri/Cargo.lock package.json .gitignore
git commit -m "Wire up Tauri Android build with 16KB linker flag"
```

(If `cargo tauri android init` writes build outputs under `src-tauri/gen/android/app/build/`, confirm `.gitignore` already excludes that path — add `src-tauri/gen/android/app/build/` if not, so generated build artifacts aren't committed.)

---

### Task 7: Remove Capacitor entirely

**Files:**
- Delete: `capacitor.config.ts`, `android/`
- Modify: `package.json` (remove Capacitor deps), `.gitignore` (remove now-irrelevant `android/keystore.properties` entry if no longer applicable — check Step 3)

**Interfaces:**
- Produces: no code anywhere in the repo references `@capacitor/*` or `@capacitor-community/*`.

By this point (Tasks 1-6 done), nothing in `src/` imports any Capacitor package — Task 2 moved the last type-only import, Task 4 removed the last runtime import (`Capacitor.getPlatform()` in the old `sqlite-client.ts`), Task 5 removed the last runtime import in `file-download.ts`.

- [ ] **Step 1: Confirm no remaining Capacitor imports**

```bash
grep -rln "@capacitor" src/ test/
```

Expected: no output. If anything shows up, stop and investigate before proceeding — it means an earlier task missed a call site.

- [ ] **Step 2: Remove the packages and delete Capacitor-only files**

```bash
npm uninstall @capacitor/core @capacitor/android @capacitor/filesystem @capacitor/share @capacitor/cli @capacitor/assets @capacitor-community/sqlite jeep-sqlite sql.js
git rm -r capacitor.config.ts android/
```

- [ ] **Step 3: Check `.gitignore` for now-stale Capacitor-specific entries**

```bash
grep -n "android/keystore.properties\|android/.idea" .gitignore
```

The keystore path (`~/.android-keystores/keystore.properties`, read by `android/app/build.gradle`) was already outside the repo, keyed to `$HOME`, not `android/` — that gradle file is deleted in this task along with the rest of `android/`. Remove the now-meaningless `.gitignore` lines referencing paths under the deleted `android/` directory (leave any entry that refers to `src-tauri/gen/android/` instead — that's the new, real Android project).

- [ ] **Step 4: Run the full check**

```bash
npx tsc -b
npm test
npm run lint
```

Expected: all pass — nothing in the remaining codebase should have depended on the removed packages by this point.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Remove Capacitor entirely"
```

---

### Task 8: `npm run dev`, retire Playwright, docs updates

**Files:**
- Modify: `package.json` (`dev` script, remove `test:e2e`)
- Delete: `playwright.config.ts`, `e2e/`
- Modify: `docs/architecture.md`, `docs/commands.md`, `docs/data-model.md`, `README.md`, `docs/install-guide.md`
- Modify: `docs/roadmap.md` (new follow-up items)

**Interfaces:**
- Produces: `npm run dev` launches `cargo tauri dev`.

- [ ] **Step 1: Rewire `npm run dev`**

In `package.json`, replace:

```json
"dev": "vite",
```

with:

```json
"dev": "cargo tauri dev",
```

(`dev:vite`, added in Task 1, stays — it's what `cargo tauri dev` itself invokes internally per `tauri.conf.json`'s `beforeDevCommand`, not a redundant duplicate.)

- [ ] **Step 2: Retire the Playwright e2e suite**

```json
"test:e2e": "playwright test",
```

is removed from `package.json`'s `scripts`. Delete the suite itself:

```bash
git rm playwright.config.ts
git rm -r e2e/
npm uninstall @playwright/test
```

This suite structurally can't run anymore: `playwright.config.ts`'s `webServer.command` was `npm run dev -- --port 5183 --strictPort`, which after Step 1 launches a full Tauri host process, not a plain Vite dev server Playwright can attach a browser to. Per this plan's Global Constraints, the e2e gap is accepted rather than bridged — see Step 5's roadmap entry for the follow-up.

- [ ] **Step 3: Update `docs/architecture.md`**

Replace the two Capacitor-referencing table rows (currently around line 49 and line 69):

```markdown
| `sqlite-client.ts` | Bootstraps the real `@capacitor-community/sqlite` connection — native on Android, `jeep-sqlite`+`sql.js`+IndexedDB on web. |
```
→
```markdown
| `sqlite-client.ts` | Bootstraps the on-device SQLite connection via `@tauri-apps/plugin-sql` — same connection object on desktop and Android, no platform dispatch. |
```

```markdown
| `shared/file-download.ts` | Cross-platform "save this file for the user" helper (File System Access API → Blob fallback → Capacitor native share), used by Settings export and Coverage Report's CSV export. |
```
→
```markdown
| `shared/file-download.ts` | "Save this file for the user" helper via `@tauri-apps/plugin-dialog`'s save dialog + `@tauri-apps/plugin-fs`'s `writeTextFile` — one mechanism on desktop and Android, used by Settings export and Coverage Report's CSV export. |
```

Also check the note near line 105 about `node:sqlite`-backed tests ("backed by `node:sqlite` instead of the real Capacitor plugin") — update "the real Capacitor plugin" to "the real Tauri plugin".

- [ ] **Step 4: Update `docs/commands.md`, `README.md`, `docs/data-model.md`, `docs/install-guide.md`**

- `docs/commands.md`: the "Build debug APK"/"Build release APK" sections (around lines 37-46) already reference `npm run android:build`/`npm run android:release` by name — no command text changes needed since Task 6 kept those script names, but add a one-line note that these now run `cargo tauri android build` under the hood instead of Gradle-via-Capacitor.
- `README.md` line 5: replace "Ships as a Capacitor-wrapped Android APK" with "Ships as a Tauri-wrapped Android APK, plus a desktop build".
- `README.md` line 22: replace "On-device SQLite is backed by `@capacitor-community/sqlite` (Android) and IndexedDB-backed `sql.js` (web)" with "On-device SQLite is backed by `@tauri-apps/plugin-sql` — a real on-disk SQLite file on every platform this app ships on (desktop, Android)".
- `docs/data-model.md` line 15: replace "**SQLite on-device** via `capacitor-community/sqlite`. No IndexedDB, no" with "**SQLite on-device** via `@tauri-apps/plugin-sql`. No IndexedDB, no" (keep whatever the line's continuation says after "no").
- `docs/data-model.md` line 256: replace "`@capacitor-community/sqlite` already exposes `executeSet`/`importFromJson`/" — update the plugin name reference; if the described capability (`executeSet`/`importFromJson`) doesn't have a `plugin-sql` equivalent, note that explicitly rather than leaving a stale claim.
- `docs/install-guide.md` lines 66-70 and 82: these describe `npm run dev` as a fallback/verification step for end users — confirm the surrounding prose still makes sense once `npm run dev` requires the full Rust/Android toolchain rather than just Node (this is a materially heavier requirement for a non-developer end user reading this guide — flag this explicitly in the doc rather than silently leaving install-guide.md implying `npm run dev` is a lightweight check).

- [ ] **Step 5: Log follow-ups to `docs/roadmap.md`**

Add to `docs/roadmap.md`'s "Open Polish Items" section (or wherever this repo's convention places non-blocking follow-ups — match the existing two entries logged 2026-07-24 for delete-from-Collection/evolution):

```markdown
- **Rebuild e2e coverage on `tauri-driver`**: Sub-project 6 (Capacitor →
  Tauri) retired the Playwright suite (`e2e/*.spec.ts`, 10 spec files
  covering boot, Dex grid, log-catch, edit-instance, persistence, settings
  export, species detail, tags) because Playwright can't drive a
  Tauri-hosted webview (it speaks CDP; Tauri's own testing story is
  `tauri-driver`, a WebDriver-protocol tool needing a different test
  runner — `webdriverio` or `selenium-webdriver`, not Playwright). No
  WebDriver spike has been run yet. Needs its own brainstorm: which
  runner, whether all 10 specs get 1:1 ports or the coverage gets
  re-scoped, and whether `webkit2gtk` (the Linux Tauri webview's engine)
  behaves differently from the Chromium the old suite drove for any of
  the ported specs. Deferred 2026-07-24 (accepted as an e2e gap during
  the Tauri migration, owner call).
- **Desktop packaging/distribution format**: Sub-project 6 only verified
  `cargo tauri build` produces a working host-platform (Linux) bundle.
  Installer format, code signing, and how a desktop build would actually
  reach a user (vs. Android's existing sideload-an-APK flow) are
  undecided. Deferred 2026-07-24 (explicit non-goal of Sub-project 6,
  owner call).
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json docs/architecture.md docs/commands.md docs/data-model.md README.md docs/install-guide.md docs/roadmap.md
git rm playwright.config.ts
git rm -r e2e/
git commit -m "Wire npm run dev to cargo tauri dev, retire Playwright, update docs"
```

---

### Task 9: Desktop build verification + final whole-app check

**Files:** none (verification-only task, no source changes expected)

**Interfaces:** none — this task validates Tasks 1-8 together.

- [ ] **Step 1: Verify a desktop build**

```bash
cargo tauri build
```

Expected: completes without error and produces a Linux bundle (AppImage and/or `.deb`, whichever `tauri-cli`'s default bundle targets produce) under `src-tauri/target/release/bundle/`. Run the produced binary directly (not via `cargo tauri dev`) and confirm the app boots, the Dex grid loads real reference data, and a logged catch persists after quitting and relaunching the binary — this is the first time this app has ever run as a genuine standalone desktop build, not just inside a browser or an Android emulator.

- [ ] **Step 2: Re-verify Android end-to-end**

```bash
npm run android:release
```

Expected: completes and produces a signed release APK (assuming `~/.android-keystores/keystore.properties` exists on this machine, per `android/app/build.gradle`'s old signing setup — confirm `src-tauri/gen/android/app/build.gradle.kts` picks up the same keystore path, or note if Tauri's Android release signing needs separate configuration not covered by this plan). Install and smoke-test as in Task 6 Step 4.

- [ ] **Step 3: Full repo check**

```bash
npx tsc -b
npm test
npm run lint
```

Expected: all pass.

- [ ] **Step 4: Final commit (if Steps 1-2 needed any fixes)**

```bash
git add -A
git commit -m "Verify desktop and Android release builds end-to-end"
```

If no fixes were needed, this task produces no commit — the verification itself is the deliverable.

---

## Self-Review Notes

- **Spec coverage:** all four resolved open questions from the design doc are reflected — Android share mechanism (Task 5), dev workflow (Task 8 Step 1), 16KB linker flag (Task 6 Step 2), desktop packaging (Task 9 Step 1, "just get a working build"). The design doc's architecture (single connection adapter, `plugin-fs`+`plugin-dialog` export, build tooling changes) maps 1:1 to Tasks 3-6.
- **e2e sequencing:** per the owner's "accept the gap, cut over immediately" call, this plan does not attempt to keep any browser-testable backend alive — Task 8 retires Playwright in the same task that flips `npm run dev`, rather than staggering them, since keeping them staggered would imply a transitional dual-backend state this plan deliberately isn't building.
- **Type consistency:** `SQLiteDBConnection` (Task 2) is defined once and consumed identically by `tauri-sqlite-connection.ts` (Task 3) and the pre-existing `test/node-sqlite-connection.ts`; `getDb()`/`persistDb()` signatures (Task 4) are unchanged from today so `sqlite-repository.ts` requires no edits; `downloadTextFile()`'s signature (Task 5) is unchanged so its two call sites require no edits.
