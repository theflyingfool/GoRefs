# Command Reference

Developer commands for running, building, testing, and managing data in PoGo Buddy.

---

## Development & Verification

- Run development server (launches the Tauri desktop app via `cargo tauri dev`; `npm run dev:vite` remains available for a plain Vite dev server without the native shell):

  ```sh
  npm run dev
  ```

- Run code linter & typechecking:

  ```sh
  npm run lint
  ```

- Run unit tests:

  ```sh
  npm run test
  ```

---

## Native Builds (Android)

- Build debug APK (runs `cargo tauri android build --debug` under the hood, not Gradle-via-Capacitor):

  ```sh
  npm run android:build
  ```

- Build release APK (runs `cargo tauri android build` under the hood, not Gradle-via-Capacitor; release is the tauri-cli's default build mode — there is no `--release` flag):

  ```sh
  npm run android:release
  ```

---

## Data Ingestion & Maintenance

- Fetch reference data from PokeAPI and rebuild local database inputs:

  ```sh
  npm run ingest:fetch && npm run ingest:build
  ```

- Verify slug stability against previous git commit:

  ```sh
  npm run ingest:check-slugs
  ```

- Build inspectable dummy SQLite database at root:

  ```sh
  npm run build:dummy-db
  ```

---

## Schema & Migrations

- Generate a SQL migration file from changes to `src/db/schema/personal.ts`:

  ```sh
  npm run db:generate
  ```

  Runs drizzle-kit to generate the migration. Run after editing `schema/personal.ts`; hand-verify the generated SQL before committing, per docs/data-model.md's migration-runner section.
