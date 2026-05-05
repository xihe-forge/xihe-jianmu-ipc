import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getTempDbPath } from '../helpers/temp-path.mjs';

const DB_PATH = getTempDbPath('sessions-history-cleanup-lifecycle');
process.env.IPC_DB_PATH = DB_PATH;

const db = await import('../../lib/db.mjs');
const sqlite = new Database(DB_PATH);
const TMP_DIR = join(tmpdir(), `jianmu-sessions-cleanup-lifecycle-${process.pid}`);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 4, 5, 12, 0, 0);

function record(sessionId, options = {}) {
  db.recordSessionSpawn({
    sessionId,
    name: 'cleanup-test',
    spawnAt: options.spawnAt ?? NOW,
    lastSeenAt: options.lastSeenAt ?? NOW,
    endedAt: options.endedAt ?? null,
    transcriptPath: options.transcriptPath ?? null,
    spawnReason: options.spawnReason ?? 'fresh',
  });
}

beforeEach(() => {
  sqlite.exec('DELETE FROM lineage; DELETE FROM sessions_history;');
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

test('AC8 lifecycle: fake sessions cleanup leaves only alive row and pending placeholder', () => {
  const aliveTranscript = join(TMP_DIR, 'alive.jsonl');
  writeFileSync(aliveTranscript, '{}\n');

  record('cleanup-ended-31d', {
    spawnAt: NOW - 40 * DAY,
    lastSeenAt: NOW - 31 * DAY,
    endedAt: NOW - 31 * DAY,
  });
  record('cleanup-ended-5d', {
    spawnAt: NOW - 6 * DAY,
    lastSeenAt: NOW - 5 * DAY,
    endedAt: NOW - 5 * DAY,
  });
  record('cleanup-idle-91d', {
    spawnAt: NOW - 100 * DAY,
    lastSeenAt: NOW - 91 * DAY,
  });
  record('cleanup-orphan', {
    spawnAt: NOW - DAY,
    lastSeenAt: NOW - DAY,
    transcriptPath: join(TMP_DIR, 'missing.jsonl'),
  });
  record('cleanup-alive', {
    spawnAt: NOW - DAY,
    lastSeenAt: NOW,
    transcriptPath: aliveTranscript,
  });
  record('pending-cleanup-test', {
    spawnAt: NOW - 100 * DAY,
    lastSeenAt: NOW - 100 * DAY,
    endedAt: NOW - 100 * DAY,
    spawnReason: 'atomic-handoff',
  });

  const dryRun = db.cleanupSessionsHistory({
    dryRun: true,
    endedOlderThanMs: 1,
    lastSeenOlderThanMs: 90 * DAY,
    orphan: true,
    now: NOW,
  });
  const enforce = db.cleanupSessionsHistory({
    dryRun: false,
    endedOlderThanMs: 1,
    lastSeenOlderThanMs: 90 * DAY,
    orphan: true,
    now: NOW,
  });

  assert.equal(dryRun.count, enforce.count);
  assert.deepEqual(
    enforce.deleted.map((row) => row.sessionId).sort(),
    ['cleanup-ended-31d', 'cleanup-ended-5d', 'cleanup-idle-91d', 'cleanup-orphan'],
  );
  assert.deepEqual(
    sqlite.prepare(`
      SELECT session_id AS sessionId
      FROM sessions_history
      WHERE name = 'cleanup-test'
      ORDER BY session_id ASC
    `).all().map((row) => row.sessionId),
    ['cleanup-alive', 'pending-cleanup-test'],
  );
});

after(() => {
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
