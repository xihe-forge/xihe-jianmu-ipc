import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function createObservationDb(dbPath, { withFts = true } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ipc_name TEXT NOT NULL,
      ts INTEGER NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      files_touched TEXT,
      commit_sha TEXT,
      tags TEXT,
      ipc_peer TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_ipc ON observations(ipc_name, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_tool ON observations(tool_name, ts DESC);
  `);

  if (withFts) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          tool_input,
          tool_output,
          tags,
          content='observations',
          content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, tool_input, tool_output, tags)
          VALUES (new.id, new.tool_input, new.tool_output, new.tags);
        END;
      `);
    } catch {
      // Some SQLite builds may not expose FTS5. Query tests cover LIKE fallback.
    }
  }

  return db;
}

export function insertObservation(db, overrides = {}) {
  const record = {
    session_id: 'session-1',
    ipc_name: 'alpha',
    ts: Date.now(),
    tool_name: 'Bash',
    tool_input: 'echo hello',
    tool_output: 'ok',
    files_touched: JSON.stringify(['README.md']),
    commit_sha: null,
    tags: JSON.stringify(['auto']),
    ipc_peer: null,
    ...overrides,
  };

  if (Array.isArray(record.files_touched)) {
    record.files_touched = JSON.stringify(record.files_touched);
  }
  if (Array.isArray(record.tags)) {
    record.tags = JSON.stringify(record.tags);
  }

  const result = db
    .prepare(
      `
    INSERT INTO observations (
      session_id,
      ipc_name,
      ts,
      tool_name,
      tool_input,
      tool_output,
      files_touched,
      commit_sha,
      tags,
      ipc_peer
    )
    VALUES (
      @session_id,
      @ipc_name,
      @ts,
      @tool_name,
      @tool_input,
      @tool_output,
      @files_touched,
      @commit_sha,
      @tags,
      @ipc_peer
    )
  `,
    )
    .run(record);

  return Number(result.lastInsertRowid);
}

export function cleanupSqliteFiles(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
}
