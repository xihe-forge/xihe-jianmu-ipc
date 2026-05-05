import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getTempDbPath } from './helpers/temp-path.mjs';

const DB_PATH = getTempDbPath('sessions-history-cleanup');
process.env.IPC_DB_PATH = DB_PATH;

const db = await import('../lib/db.mjs');
const sqlite = new Database(DB_PATH);
const TMP_DIR = join(tmpdir(), `jianmu-sessions-cleanup-${process.pid}`);

function countRows(where = '1=1') {
  return sqlite.prepare(`SELECT COUNT(*) AS count FROM sessions_history WHERE ${where}`).get().count;
}

function record(overrides = {}) {
  db.recordSessionSpawn({
    sessionId: overrides.sessionId,
    name: overrides.name ?? 'cleanup-test',
    spawnAt: overrides.spawnAt ?? 1000,
    lastSeenAt: overrides.lastSeenAt ?? overrides.spawnAt ?? 1000,
    endedAt: overrides.endedAt ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    spawnReason: overrides.spawnReason ?? 'fresh',
  });
}

beforeEach(() => {
  sqlite.exec(`
    DROP TRIGGER IF EXISTS sessions_history_cleanup_abort;
    DELETE FROM lineage;
    DELETE FROM sessions_history;
  `);
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

test('deleteSessionsByName deletes sessions_history and lineage in one transaction', () => {
  record({ sessionId: 'name-delete-1', name: 'taiwei-test', spawnAt: 1000 });
  record({ sessionId: 'name-delete-2', name: 'taiwei-test', spawnAt: 2000 });
  record({ sessionId: 'name-keep-1', name: 'taiwei-keep', spawnAt: 3000 });
  sqlite.prepare(`
    INSERT INTO lineage (child_name, parent_name, parent_session_id, reason, ts)
    VALUES ('taiwei-test', 'parent', 'parent-session', 'handoff', 1)
  `).run();

  const deleted = db.deleteSessionsByName('taiwei-test');

  assert.deepEqual(deleted.map((row) => row.sessionId), ['name-delete-2', 'name-delete-1']);
  assert.equal(countRows("name = 'taiwei-test'"), 0);
  assert.equal(countRows("name = 'taiwei-keep'"), 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM lineage WHERE child_name = 'taiwei-test'").get().count, 0);
});

test('deleteSessionById deletes one session and ignores pending placeholders', () => {
  record({ sessionId: 'delete-one', name: 'taiwei-test' });
  record({ sessionId: 'pending-delete-one', name: 'taiwei-test', spawnReason: 'atomic-handoff' });

  assert.equal(db.deleteSessionById('delete-one')?.sessionId, 'delete-one');
  assert.equal(db.deleteSessionById('pending-delete-one'), null);
  assert.equal(countRows("session_id = 'delete-one'"), 0);
  assert.equal(countRows("session_id = 'pending-delete-one'"), 1);
});

test('deleteSessionsOlderThan deletes ended and last_seen aged sessions only', () => {
  record({ sessionId: 'ended-old', endedAt: 1000, lastSeenAt: 1000 });
  record({ sessionId: 'ended-fresh', endedAt: 9000, lastSeenAt: 9000 });
  record({ sessionId: 'idle-old', spawnAt: 2000, lastSeenAt: 2000 });
  record({ sessionId: 'pending-old', spawnAt: 1000, lastSeenAt: 1000, spawnReason: 'atomic-handoff' });

  const deleted = db.deleteSessionsOlderThan({ endedBefore: 5000, lastSeenBefore: 3000 });

  assert.deepEqual(
    deleted.map((row) => row.sessionId).sort(),
    ['ended-old', 'idle-old'],
  );
  assert.equal(countRows("session_id = 'ended-fresh'"), 1);
  assert.equal(countRows("session_id = 'pending-old'"), 1);
});

test('findOrphanSessions detects missing transcript files', () => {
  const existingPath = join(TMP_DIR, 'existing.jsonl');
  writeFileSync(existingPath, '{}\n');
  record({ sessionId: 'orphan-missing', transcriptPath: join(TMP_DIR, 'missing.jsonl') });
  record({ sessionId: 'orphan-existing', transcriptPath: existingPath });
  record({ sessionId: 'orphan-empty-path', transcriptPath: null });

  assert.deepEqual(db.findOrphanSessions().map((row) => row.sessionId), ['orphan-missing']);
});

test('cleanupSessionsHistory dry-run returns candidates without deleting', () => {
  record({ sessionId: 'dry-ended-old', endedAt: 1000, lastSeenAt: 1000 });
  record({ sessionId: 'dry-keep', endedAt: 9000, lastSeenAt: 9000 });

  const result = db.cleanupSessionsHistory({
    dryRun: true,
    olderThanMs: 5000,
    now: 7000,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.count, 1);
  assert.equal(result.deleted[0].sessionId, 'dry-ended-old');
  assert.equal(countRows(), 2);
});

test('cleanupSessionsHistory enforces name, age and orphan cleanup with dedupe', () => {
  const missingPath = join(TMP_DIR, 'missing.jsonl');
  record({ sessionId: 'cleanup-name', name: 'cleanup-name', spawnAt: 1000 });
  record({ sessionId: 'cleanup-ended', endedAt: 1000, lastSeenAt: 1000 });
  record({ sessionId: 'cleanup-idle-orphan', spawnAt: 2000, lastSeenAt: 2000, transcriptPath: missingPath });
  record({ sessionId: 'cleanup-keep', spawnAt: 9000, lastSeenAt: 9000 });
  record({ sessionId: 'pending-cleanup-old', spawnAt: 1000, lastSeenAt: 1000, spawnReason: 'atomic-handoff' });

  const result = db.cleanupSessionsHistory({
    dryRun: false,
    name: 'cleanup-name',
    endedOlderThanMs: 5000,
    lastSeenOlderThanMs: 5000,
    orphan: true,
    now: 9000,
  });

  assert.deepEqual(
    result.deleted.map((row) => row.sessionId).sort(),
    ['cleanup-ended', 'cleanup-idle-orphan', 'cleanup-name'],
  );
  assert.equal(countRows("session_id = 'cleanup-keep'"), 1);
  assert.equal(countRows("session_id = 'pending-cleanup-old'"), 1);
});

test('deleteSessionsByName rolls back lineage deletion when session delete fails', () => {
  record({ sessionId: 'rollback-session', name: 'rollback-name' });
  sqlite.prepare(`
    INSERT INTO lineage (child_name, parent_name, parent_session_id, reason, ts)
    VALUES ('rollback-name', 'parent', 'parent-session', 'handoff', 1)
  `).run();
  sqlite.exec(`
    CREATE TRIGGER sessions_history_cleanup_abort
    BEFORE DELETE ON sessions_history
    WHEN old.name = 'rollback-name'
    BEGIN
      SELECT RAISE(ABORT, 'abort cleanup');
    END;
  `);

  assert.throws(() => db.deleteSessionsByName('rollback-name'), /abort cleanup/);
  assert.equal(countRows("name = 'rollback-name'"), 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM lineage WHERE child_name = 'rollback-name'").get().count, 1);
});

process.on('exit', () => {
  try {
    sqlite.close();
  } catch {}
  try {
    db.close();
  } catch {}
  rmSync(TMP_DIR, { recursive: true, force: true });
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
});
