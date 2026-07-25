# PoGo Buddy

A local-only, fully offline Pokémon GO living-dex tracker. No accounts, no
back-end, no network calls at runtime — all personal data stays on the
device. Ships as a Tauri-wrapped Android APK, plus a native Tauri desktop build
(side-loaded, not Play Store) built from the same TypeScript/Vite codebase,
for editing on a computer (see "Cross-device data" below).

**Installing it?** See [docs/install-guide.md](./docs/install-guide.md) —
covers both the Android app and the desktop version, updating, and
troubleshooting.

See [docs/data-model.md](./docs/data-model.md) (schema/storage),
[docs/features.md](./docs/features.md) (feature specs and roadmap),
and [docs/architecture.md](./docs/architecture.md) (codebase map) for the
full design; [CLAUDE.md](./CLAUDE.md) for the working invariants; and
[CHANGELOG.md](./CHANGELOG.md) for version history.

## Stack

- **Frontend**: TypeScript + Vite, vanilla JS (no framework).
- **Database**: SQLite. On-device SQLite is backed by `@tauri-apps/plugin-sql` — a real on-disk SQLite file on every platform this app ships on (desktop, Android).
- **Data Architecture**: The database split, schema design, and sync model are documented in the canonical [docs/data-model.md](docs/data-model.md).

## Prerequisites

- Node.js — Vite 6 requires `^18.19.0` or `>=20.0.0`.
- The Rust toolchain and platform build dependencies Tauri requires, since
  `npm run dev` now runs the full Tauri desktop app; native Android builds
  have their own additional prerequisites (see "Building the Android app"
  below).

## Running it

```sh
git clone <this repo>
cd GoBuddy
npm install
npm run dev
```

Runs the full Tauri desktop app (`cargo tauri dev` under the hood); the app
opens in its own native window automatically — there's no URL to open in a
browser. All data is stored locally on disk in a real SQLite file, backed by
`@tauri-apps/plugin-sql` — nothing leaves your computer. See
[docs/install-guide.md](./docs/install-guide.md#desktop) for the
friend-facing version of these steps, including the ZIP-download caveat and
update instructions.

## Features

- **Pokédex grid** — every species/form, with tri-state (off/include/exclude)
  filters across region, rarity, gender, Dynamax/Gigantamax/Mega capability,
  and any personal achievement flags you pin as grid badges (Settings →
  "Grid badges").
- **Species detail / data entry** — fast toggle-based entry per form for
  catches, shiny, lucky, shadow, Dynamax (and their floor/4★/shundo
  variants). Toggle groups that don't apply to a given form (e.g. Shadow on
  a species that's never been made Shadow-available) are hidden rather than
  shown as dead options.
- **Stats page** — completion percentage by region or species, across
  multiple lenses (registered, form-complete, costume-complete, or any
  boolean achievement column) with a drill-down list of what's missing.
- **Settings** — grid badge selection, gender-form display collapsing, and
  cross-device Export/Import (see below).
- **Coverage report** (dev tool) — a view of which species are missing key
  reference fields (types, region, availability flags), since the bundled
  dataset is filled in incrementally.

Not yet built (see [docs/roadmap.md](./docs/roadmap.md)):
the tri-state search-string builder and the auto-declutter engine.

## Building the Android app

Build steps, requirements, and signing parameters are part of the [docs/release-checklist.md](docs/release-checklist.md).
For a quick build:

```sh
export JAVA_HOME=/opt/android-studio/jbr   # or wherever your JDK 21 lives
export ANDROID_HOME=$HOME/Android/Sdk
npm run android:build    # Build debug APK
npm run android:release  # Build signed release APK (requires keystore setup)
```

Refer to [docs/install-guide.md](docs/install-guide.md) for sideloading instructions.

## Cross-device data (phone ↔ desktop)

There's no sync — by design, per the no-network-calls constraint. Instead,
the Settings page has manual **Export** / **Import** buttons for personal
data (your catch/achievement state, not reference data):

- **Export** writes a JSON snapshot, stamped with the current personal
  schema version. On both Android and desktop it's handed to the native
  save/share dialog (via `@tauri-apps/plugin-dialog` and
  `@tauri-apps/plugin-fs`) — save to Drive, Files, email, a folder on disk,
  etc.; the app never talks to any cloud service directly.
- **Import** reads a previously-exported JSON file back in, overwriting any
  matching entries (anything not present in the file is left alone). If the
  file's schema version doesn't match the running app's, you'll get a
  warning before it proceeds.

The same file format works in both directions, so you can export from your
phone, edit on desktop (`npm run dev`), and import back.

## Reference data ingestion

Reference data (`src/data/reference.json`) is built from pre-build CSV spreadsheet files and API sources.
For instructions on running the ingestion scripts and the required sequence, see the canonical [docs/ingestion-runbook.md](docs/ingestion-runbook.md).

## Inspecting the schema directly

```sh
npm run build:dummy-db
```

Writes `dummy.sqlite` at the repo root (gitignored, regeneratable) — open
it in DB Browser for SQLite, `sqlite3`, or any SQLite client to browse the
schema and real ingested data directly.
