// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#[cfg(feature = "sqlite")]
use std::fs::create_dir_all;

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
#[cfg(any(feature = "sqlite", feature = "mysql", feature = "postgres"))]
use sqlx::{migrate::MigrateDatabase, Column, Executor, Pool, Row};
#[cfg(any(feature = "sqlite", feature = "mysql", feature = "postgres"))]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

#[cfg(feature = "mysql")]
use sqlx::MySql;
#[cfg(feature = "postgres")]
use sqlx::Postgres;
#[cfg(feature = "sqlite")]
use sqlx::Sqlite;

use crate::LastInsertId;

pub enum DbPool {
    #[cfg(feature = "sqlite")]
    Sqlite(Pool<Sqlite>),
    #[cfg(feature = "mysql")]
    MySql(Pool<MySql>),
    #[cfg(feature = "postgres")]
    Postgres(Pool<Postgres>),
    #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
    None,
}

// public methods
/* impl DbPool {
    /// Get the inner Sqlite Pool. Returns None for MySql and Postgres pools.
    #[cfg(feature = "sqlite")]
    pub fn sqlite(&self) -> Option<&Pool<Sqlite>> {
        match self {
            DbPool::Sqlite(pool) => Some(pool),
            _ => None,
        }
    }

    /// Get the inner MySql Pool. Returns None for Sqlite and Postgres pools.
    #[cfg(feature = "mysql")]
    pub fn mysql(&self) -> Option<&Pool<MySql>> {
        match self {
            DbPool::MySql(pool) => Some(pool),
            _ => None,
        }
    }

    /// Get the inner Postgres Pool. Returns None for MySql and Sqlite pools.
    #[cfg(feature = "postgres")]
    pub fn postgres(&self) -> Option<&Pool<Postgres>> {
        match self {
            DbPool::Postgres(pool) => Some(pool),
            _ => None,
        }
    }
} */

// private methods
impl DbPool {
    pub(crate) async fn connect<R: Runtime>(
        conn_url: &str,
        _app: &AppHandle<R>,
    ) -> Result<Self, crate::Error> {
        match conn_url
            .split_once(':')
            .ok_or_else(|| crate::Error::InvalidDbUrl(conn_url.to_string()))?
            .0
        {
            #[cfg(feature = "sqlite")]
            "sqlite" => {
                let app_path = _app
                    .path()
                    .app_config_dir()
                    .expect("No App config path was found!");

                create_dir_all(&app_path).expect("Couldn't create app config dir");

                let conn_url = &path_mapper(app_path, conn_url);

                if !Sqlite::database_exists(conn_url).await.unwrap_or(false) {
                    Sqlite::create_database(conn_url).await?;
                }
                // GoBuddy local fork change (see src-tauri/vendor/tauri-plugin-sql/GOBUDDY_PATCH.md).
                // Upstream uses `Pool::connect`, which applies sqlx's default
                // `PoolOptions` (max_connections = 10). Every plugin IPC call
                // (execute/select) independently checks out whatever pooled
                // connection is free, so a multi-call transaction — BEGIN via
                // one execute(), the writes via more, COMMIT via another (see
                // GoBuddy's src/db/migrations.ts and src/db/reference-sync.ts) —
                // is NOT guaranteed to land on the same physical SQLite
                // connection. When it doesn't, statements meant to be inside the
                // BEGIN's transaction instead run on a different connection and
                // block on the first connection's write lock, surfacing as
                // SQLITE_BUSY after sqlx's 5s busy_timeout. Pinning the pool to a
                // single connection makes every checkout the same connection, so
                // cross-call transactions are correct by construction. This suits
                // a local-first, single-user SQLite app, where all DB access is
                // single-writer anyway. Only the sqlite branch is changed; mysql/
                // postgres are untouched (GoBuddy never enables them).
                Ok(Self::Sqlite(
                    sqlx::sqlite::SqlitePoolOptions::new()
                        .max_connections(1)
                        .connect(conn_url)
                        .await?,
                ))
            }
            #[cfg(feature = "mysql")]
            "mysql" => {
                if !MySql::database_exists(conn_url).await.unwrap_or(false) {
                    MySql::create_database(conn_url).await?;
                }
                Ok(Self::MySql(Pool::connect(conn_url).await?))
            }
            #[cfg(feature = "postgres")]
            "postgres" => {
                if !Postgres::database_exists(conn_url).await.unwrap_or(false) {
                    Postgres::create_database(conn_url).await?;
                }
                Ok(Self::Postgres(Pool::connect(conn_url).await?))
            }
            #[cfg(not(any(feature = "sqlite", feature = "postgres", feature = "mysql")))]
            _ => Err(crate::Error::InvalidDbUrl(format!(
                "{conn_url} - No database driver enabled!"
            ))),
            #[cfg(any(feature = "sqlite", feature = "postgres", feature = "mysql"))]
            _ => Err(crate::Error::InvalidDbUrl(conn_url.to_string())),
        }
    }

    pub(crate) async fn migrate(
        &self,
        _migrator: &sqlx::migrate::Migrator,
    ) -> Result<(), crate::Error> {
        match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => _migrator.run(pool).await?,
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => _migrator.run(pool).await?,
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => _migrator.run(pool).await?,
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (),
        }
        Ok(())
    }

    pub(crate) async fn close(&self) {
        match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => pool.close().await,
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => pool.close().await,
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => pool.close().await,
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (),
        }
    }

    pub(crate) async fn execute(
        &self,
        _query: String,
        _values: Vec<JsonValue>,
    ) -> Result<(u64, LastInsertId), crate::Error> {
        Ok(match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let result = pool.execute(query).await?;
                (
                    result.rows_affected(),
                    LastInsertId::Sqlite(result.last_insert_rowid()),
                )
            }
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let result = pool.execute(query).await?;
                (
                    result.rows_affected(),
                    LastInsertId::MySql(result.last_insert_id()),
                )
            }
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let result = pool.execute(query).await?;
                (result.rows_affected(), LastInsertId::Postgres(()))
            }
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (0, LastInsertId::None),
        })
    }

    pub(crate) async fn select(
        &self,
        _query: String,
        _values: Vec<JsonValue>,
    ) -> Result<Vec<IndexMap<String, JsonValue>>, crate::Error> {
        Ok(match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::sqlite::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::mysql::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::postgres::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => Vec::new(),
        })
    }
}

#[cfg(feature = "sqlite")]
/// Maps the user supplied DB connection string to a connection string
/// with a fully qualified file path to the App's designed "app_path"
fn path_mapper(mut app_path: std::path::PathBuf, connection_string: &str) -> String {
    app_path.push(
        connection_string
            .split_once(':')
            .expect("Couldn't parse the connection string for DB!")
            .1,
    );

    format!(
        "sqlite:{}",
        app_path
            .to_str()
            .expect("Problem creating fully qualified path to Database file!")
    )
}
