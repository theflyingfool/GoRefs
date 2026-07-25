// Verification for the vendored `tauri-plugin-sql` fork in
// src-tauri/vendor/tauri-plugin-sql (see its GOBUDDY_PATCH.md).
//
// These tests exercise sqlx 0.8's SQLite pool directly, mirroring the plugin's
// access pattern: every plugin IPC command (`execute` / `select`) runs one
// statement via `pool.execute()` / `pool.fetch_all()`, each of which
// independently checks a connection out of the pool and returns it. GoBuddy's
// transactions (src/db/migrations.ts, src/db/reference-sync.ts) span many such
// calls. The correctness question is whether they all land on the same physical
// connection.
//
// These are deterministic and timing-independent: they don't rely on the flaky
// production race, they check the underlying pool property directly.

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{Executor, Row};

fn temp_db_url(name: &str) -> (String, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "gobuddy-pool-test-{}-{}.db",
        name,
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    (format!("sqlite://{}?mode=rwc", path.display()), path)
}

// THE FIX: with max_connections = 1 (what the vendored fork configures), every
// pool checkout is the same physical connection. A transaction opened by one
// call therefore persists across the connection's release and is continued by
// the next call — a multi-call BEGIN/…/ROLLBACK behaves as one real
// transaction. This is the exact guarantee reference-sync.ts depends on.
#[tokio::test]
async fn single_connection_pool_keeps_transaction_across_calls() {
    let (url, path) = temp_db_url("fix");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect");

    // Each of these mirrors one plugin IPC call: acquire, run, release.
    pool.execute("CREATE TABLE t (x INTEGER)").await.unwrap();
    pool.execute("BEGIN").await.unwrap();
    pool.execute("INSERT INTO t (x) VALUES (1)").await.unwrap();

    // Uncommitted row must be visible on the very next checkout => same
    // physical connection, inside the still-open transaction.
    let mid = pool
        .fetch_one("SELECT COUNT(*) AS c FROM t")
        .await
        .unwrap()
        .get::<i64, _>("c");
    assert_eq!(mid, 1, "uncommitted INSERT must be visible => same connection");

    pool.execute("ROLLBACK").await.unwrap();

    // ROLLBACK on that same connection must actually undo the INSERT.
    let after = pool
        .fetch_one("SELECT COUNT(*) AS c FROM t")
        .await
        .unwrap()
        .get::<i64, _>("c");
    assert_eq!(after, 0, "ROLLBACK must undo the INSERT => real transaction");

    pool.close().await;
    let _ = std::fs::remove_file(&path);
}

// THE BUG (why upstream's default pool breaks): with more than one connection,
// two statements can land on different physical connections. A transaction
// opened on connection A is invisible to connection B, and a write on B blocks
// on A's write lock and fails SQLITE_BUSY once busy_timeout elapses — exactly
// the production symptom. Demonstrated deterministically by pinning two distinct
// connections rather than depending on scheduling.
#[tokio::test]
async fn multi_connection_pool_breaks_cross_connection_transaction() {
    let (url, path) = temp_db_url("bug");
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect");

    pool.execute("CREATE TABLE t (x INTEGER)").await.unwrap();

    // Two distinct physical connections, standing in for two pool checkouts
    // that happened to pick different connections.
    let mut conn_a = pool.acquire().await.unwrap();
    let mut conn_b = pool.acquire().await.unwrap();

    // Keep the BUSY failure fast instead of the 5s default.
    conn_b.execute("PRAGMA busy_timeout = 200").await.unwrap();

    // Transaction + write live on connection A.
    conn_a.execute("BEGIN IMMEDIATE").await.unwrap();
    conn_a.execute("INSERT INTO t (x) VALUES (1)").await.unwrap();

    // Connection B cannot see A's uncommitted row (separate transaction scope).
    let seen_on_b = conn_b
        .fetch_one("SELECT COUNT(*) AS c FROM t")
        .await
        .unwrap()
        .get::<i64, _>("c");
    assert_eq!(
        seen_on_b, 0,
        "a statement on a different connection is NOT in A's transaction"
    );

    // A write on B blocks on A's lock and fails — the production SQLITE_BUSY.
    let write_on_b = conn_b.execute("INSERT INTO t (x) VALUES (2)").await;
    let err = write_on_b.expect_err("cross-connection write must fail while A holds the lock");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("locked") || msg.contains("busy"),
        "expected a busy/locked error, got: {msg}"
    );

    conn_a.execute("ROLLBACK").await.unwrap();
    drop(conn_a);
    drop(conn_b);
    pool.close().await;
    let _ = std::fs::remove_file(&path);
}
