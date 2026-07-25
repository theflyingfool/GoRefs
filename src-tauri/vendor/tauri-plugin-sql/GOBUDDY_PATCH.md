# GoBuddy local fork of `tauri-plugin-sql` 2.4.0

This directory is a **verbatim copy of `tauri-plugin-sql` 2.4.0** (from crates.io)
with **exactly one behavioral change**, applied via `[patch.crates-io]` in
`src-tauri/Cargo.toml`.

## The one change

`src/wrapper.rs`, `DbPool::connect`, the `"sqlite"` branch only:

```rust
// upstream:
Ok(Self::Sqlite(Pool::connect(conn_url).await?))

// this fork:
Ok(Self::Sqlite(
    sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(conn_url)
        .await?,
))
```

The `mysql` and `postgres` branches are untouched (GoBuddy never enables them).

## Why

Upstream builds the database as a default `sqlx::Pool<Sqlite>` via
`Pool::connect(url)`, which uses sqlx's default `PoolOptions`
(`max_connections = 10`). Every plugin IPC command (`execute` / `select`)
independently checks a connection out of that pool for that one call and returns
it — there is **no session pinning**.

GoBuddy's `src/db/tauri-sqlite-connection.ts` implements
`beginTransaction()` / `commitTransaction()` / `rollbackTransaction()` as
separate `execute("BEGIN"/"COMMIT"/"ROLLBACK")` calls, and
`src/db/migrations.ts` + `src/db/reference-sync.ts` run several
`run()`/`execute()` calls between them. With a multi-connection pool there is no
guarantee those calls land on the same physical SQLite connection: `BEGIN` can
acquire the write lock on connection A while a later statement runs on
connection B, which then blocks on A's lock and fails with `SQLITE_BUSY`
(code 5) after sqlx-sqlite's default 5-second `busy_timeout`. This was observed
on a real Android emulator during Sub-project 6, Task 6.

`max_connections = 1` makes every checkout the same physical connection, so a
transaction opened by one call persists (sqlx does not reset it on release) and
every subsequent call continues that same transaction — correct by construction.
This is the natural model for a local-first, single-user SQLite app (SQLite is
single-writer regardless). The trade-off: it serializes *all* app DB access
through one connection. For this app's light, sequential workload that is fine
and arguably preferable.

## Why not a cleaner mechanism

- `tauri-plugin-sql`'s `Builder` (`new` / `add_migrations` / `build`) and its
  `PluginConfig` (only `preload`) expose no pool/connection settings — checked
  against both 2.4.0 and the current `plugins-workspace` `v2` branch.
- `max_connections` is a `PoolOptions`-level setting, not part of
  `SqliteConnectOptions` URL parsing, so it cannot be set via the
  `"sqlite:gobuddy.db"` connection string.
- Collapsing each transaction into a single semicolon-joined `execute()` works
  for the DDL-only migration transaction but not for `reference-sync.ts`, which
  interleaves `SELECT`s with writes and performs thousands of parameterized
  bulk inserts through Drizzle — inlining those as SQL literals would abandon
  Drizzle and be an escaping minefield (e.g. `Farfetch'd`, `Mr. Mime`).

## How to check whether this fork is now obsolete

Before each dependency bump, check whether upstream `tauri-plugin-sql` has added
a way to configure the pool (a `max_connections` / `PoolOptions` /
`connect_with` builder method, or a `PluginConfig` pool field):

- Release notes / CHANGELOG: <https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/CHANGELOG.md>
- Source: <https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/sql/src>

If it has, delete this directory and the `[patch.crates-io]` block in
`src-tauri/Cargo.toml`, bump the `tauri-plugin-sql` version, and configure
`max_connections = 1` through the upstream API instead.

To re-derive this fork from scratch against a new upstream version: copy the
crate from `~/.cargo/registry/src/index.crates.io-*/tauri-plugin-sql-<ver>/`,
delete `Cargo.lock`, `Cargo.toml.orig`, `.cargo-ok`, `.cargo_vcs_info.json`,
and re-apply the one `wrapper.rs` change above.
