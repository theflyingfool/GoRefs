// Sibling to drizzle.config.ts, for `npx drizzle-kit studio` only — never
// used for `db:generate` (drizzle.config.ts stays the single source of
// truth for migrations, covering schema/personal.ts only, per its own
// header comment). Points at reference.sqlite, the real-data file
// `npm run ingest` materializes via scripts/ingest/write/sqlite.ts (see
// scripts/build-dummy-db.ts's dummy.sqlite for the personal-table-seeded
// variant, if you want to browse fake personal data too).

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/reference.ts",
  dbCredentials: {
    url: "./reference.sqlite",
  },
});
