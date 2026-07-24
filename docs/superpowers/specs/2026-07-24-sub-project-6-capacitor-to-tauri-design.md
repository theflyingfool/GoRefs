# Sub-project 6: Capacitor → Tauri — Design

> Part of the [V2 consolidation roadmap](2026-07-23-v2-consolidation-roadmap.md).
> This is the design for that roadmap's Sub-project 6 only. Implementation
> waits on Sub-project 5 (Collection/Dex/Tags gaps) per the roadmap's
> Sequence section; this design doc was written in parallel per owner call
> 2026-07-24.

## Goal

Replace Capacitor with Tauri as the app's native shell: a real desktop
build (Windows/Linux/macOS) with a genuine on-disk SQLite file everywhere
(unlocking Drizzle Studio against real data, not just `dummy.sqlite`),
while continuing to build for Android. Full replacement, not a dual-shell
setup — Capacitor, `@capacitor-community/sqlite`, and `jeep-sqlite` are
removed entirely once Tauri is verified working on both targets.

## De-risking spike (2026-07-24) — findings

Before committing to this design, a throwaway spike answered the one
question that would have invalidated the whole sub-project: **does
Tauri's SQL plugin actually work on Android**, not just claim to in a
support-matrix checkmark. Built a minimal Tauri app, added
`@tauri-apps/plugin-sql`, built a real debug APK via `cargo tauri android
build`, and ran it on an x86_64 Android emulator (API 37).

**Result: confirmed working end-to-end.** Create table → insert → select
round-tripped through a real on-disk SQLite file inside the app's Android
data directory. Two real (non-blocking) issues surfaced and were resolved
during the spike:

1. **Android 16KB page-size compatibility notice.** NDK r27's default
   linker output isn't 16KB-page-aligned; newer Android versions show a
   one-time "Android App Compatibility" dialog and run the `.so` in a
   compatibility shim rather than failing. Debug builds are unaffected
   functionally. **Action for this sub-project:** add
   `-Wl,-z,max-page-size=16384` to the Android release linker flags
   (Google's documented fix) so release builds don't show this notice.
   Confirm during implementation whether a current Tauri/AGP version
   default already covers this (it's a fast-moving area of the Android
   toolchain) before hand-rolling the flag.
2. **`sql:default` capability only grants read operations.** The plugin's
   default permission set (`allow-close`, `allow-load`, `allow-select`)
   deliberately excludes writes. `sql:allow-execute` must be added
   explicitly in `src-tauri/capabilities/default.json`. One-line fix,
   already applied in the spike.

Neither finding changes the sub-project's scope or viability. The
originally-researched "Android not supported" claim (from a JS-rendered
docs page that apparently didn't render its compatibility table) was
wrong; the plugin's source-of-truth (`Cargo.toml` platform-support
metadata and the plugin's own README) both list Android as fully
supported, and the spike proved it against a real build, not just a
document.

## Scope decisions (owner calls, 2026-07-24)

- **Full Capacitor replacement**, not dual-shell. `@capacitor-community/sqlite`,
  `jeep-sqlite`, `@capacitor/filesystem`, `@capacitor/share`, `@capacitor/android`,
  `@capacitor/core`, `@capacitor/cli`, `@capacitor/assets` all get removed
  once Tauri is verified working on both platforms; no fallback path kept.
- **e2e testing moves onto Tauri's own WebDriver tooling now**, not
  deferred. Today's Playwright suite drives a plain browser (Vite dev
  server + sql.js/IndexedDB) — under Tauri, `plugin-sql` runs in the Rust
  host process via IPC, which a plain browser has no access to
  (`window.__TAURI__` doesn't exist outside a Tauri-hosted webview). This
  means `sql.js`/`jeep-sqlite` are *not* kept alive as a "web/test only"
  fallback backend — the app becomes single-backend (Tauri `plugin-sql`
  everywhere except unit tests, which keep using `node:sqlite` via the
  existing `nodeSqliteConnection()` adapter). e2e tests run against the
  real Tauri-built app via `tauri-driver` (WebDriver), not a browser.

## Architecture

### Connection layer: `tauriSqliteConnection()` adapter

`src/db/sqlite-client.ts` currently dispatches on `Capacitor.getPlatform()`
to either the native `@capacitor-community/sqlite` plugin or its
`jeep-sqlite` web fallback, producing a `SQLiteDBConnection` (from
`@capacitor-community/sqlite`) that `src/db/migrations.ts` and
`src/db/reference-sync.ts` call `.query()`/`.run()`/`.execute()`/
`.beginTransaction()`/`.commitTransaction()`/`.rollbackTransaction()` on.

That five-method surface is exactly what `test/node-sqlite-connection.ts`
already adapts `node:sqlite` to, for unit tests. The same pattern applies
here: write `src/db/tauri-sqlite-connection.ts` exposing the identical
`SQLiteDBConnection`-shaped surface, backed by `@tauri-apps/plugin-sql`'s
`Database` class (`.select()` for queries, `.execute()` for
writes/DDL/transactions). `sqlite-client.ts` becomes a single code path —
no platform dispatch — calling `Database.load("sqlite:gobuddy.db")` once
and wrapping it. This means `migrations.ts` and `reference-sync.ts` need
**zero changes**: they only ever called the five adapted methods, never
anything Capacitor-specific.

### Filesystem/export: `plugin-fs` + `plugin-dialog`

`src/shared/file-download.ts`'s native branch (`@capacitor/filesystem`
write + `@capacitor/share` share-sheet) becomes: `@tauri-apps/plugin-fs`
to write the file, `@tauri-apps/plugin-dialog`'s save-file dialog (desktop)
or `@tauri-apps/plugin-share`... — **needs confirmation during
implementation** whether an official Tauri share-sheet equivalent exists
for Android, or whether desktop uses a native save dialog while Android
uses `plugin-fs` write + a share intent via a community plugin. The web
branch (Blob + `<a download>`) is unaffected — it doesn't touch Capacitor
at all today, so it carries over unchanged as the dev-server fallback if
one is still needed, or gets removed if Tauri fully replaces the web dev
target too (open question below).

### What replaces "web platform" during development

Today, `Capacitor.getPlatform() === "web"` is how `npm run dev` and
Playwright both run — a real platform branch, not just a test shim. Under
Tauri, local development runs via `cargo tauri dev` (spawns the Rust host
+ webview together), not `vite dev` standalone. **Open question for
implementation:** does `npm run dev` (plain Vite, no Tauri host) stay
supported at all after this migration, for fast UI-only iteration without
a full Tauri rebuild? If yes, it needs *some* SQLite backend, which
reopens the "keep sql.js for a dev-only path" question the owner already
closed for e2e — needs an explicit decision at implementation time, not
an assumption.

## Build tooling changes

- `package.json` scripts: `android:sync`/`android:build`/`android:release`
  (currently `vite build && npx cap sync android` + Gradle) become
  `cargo tauri android build [--release]`, per the spike's proven
  `cargo tauri android init` (one-time) + `cargo tauri android build`
  flow.
- New Rust toolchain requirement for contributors: `rustup` (not a distro
  Rust package, which can't add cross-compile targets), plus Android NDK
  r27+ and the four Android Rust targets (`aarch64-linux-android`,
  `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`).
  Document this in `docs/commands.md` and/or a new setup doc — first-time
  setup involves several GB of downloads (NDK, Gradle, Rust std libs per
  target) and was the single largest time cost in the spike, not the
  actual Tauri/SQLite integration.
- `desktop` becomes a genuinely new build target requiring its own
  packaging decision (AppImage/deb/msi/dmg) — out of scope to fully
  design here; flag as an implementation-time task ("what do we ship
  desktop users") rather than assuming any particular installer format.

## Out of scope for this sub-project

- Deciding desktop distribution/signing/installer format in detail —
  flagged above as an implementation-time task.
- iOS — the SQL plugin doesn't support it, and it was never a stated goal.
- Any multi-account work (Sub-project 7) — this sub-project only removes
  the storage constraint that was blocking Sub-project 7's design; it
  does not implement profile-scoped storage itself.
- Fixing the three Collection/Dex/Tags gaps (Sub-project 5) — unrelated to
  the platform, sequenced first per the roadmap.

## Open questions to resolve at implementation time

1. Exact Android share/export mechanism (`plugin-fs` + what, for the
   share-sheet equivalent).
2. Whether a Tauri-less `npm run dev` fast path survives, and if so what
   backs its SQLite access.
3. Desktop packaging/distribution format.
4. Whether the 16KB page-size linker flag is still needed by the time
   implementation starts, or already defaulted by a newer Tauri/AGP
   version.
