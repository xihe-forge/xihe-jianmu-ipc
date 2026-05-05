import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { getTempDbPath } from './helpers/temp-path.mjs';

const DB_PATH = getTempDbPath('sessions-history');
process.env.IPC_DB_PATH = DB_PATH;

const db = await import('../lib/db.mjs');
const sqlite = new Database(DB_PATH);

beforeEach(() => {
  sqlite.exec('DELETE FROM sessions_history;');
});

test('recordSessionSpawn is idempotent by session_id', () => {
  const first = db.recordSessionSpawn({
    sessionId: '11111111-1111-4111-8111-111111111111',
    name: 'taiwei-test',
    spawnReason: 'fresh',
    cwd: 'D:/workspace/ai/research/xiheAi',
    runtime: 'claude',
    transcriptPath: 'C:/Users/jolen/.claude/projects/x/11111111-1111-4111-8111-111111111111.jsonl',
    spawnAt: 1000,
  });
  const second = db.recordSessionSpawn({
    sessionId: '11111111-1111-4111-8111-111111111111',
    name: 'taiwei-test',
    spawnReason: 'fresh',
    spawnAt: 2000,
  });

  assert.deepEqual(first, {
    recorded: true,
    sessionId: '11111111-1111-4111-8111-111111111111',
  });
  assert.deepEqual(second, {
    recorded: false,
    sessionId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions_history').get().count, 1);
});

test('hook-discovery upgrades an existing fresh WebSocket row', () => {
  const sessionId = '12121212-1212-4121-8121-121212121212';
  db.recordSessionSpawn({
    sessionId,
    name: 'taiwei-test',
    spawnReason: 'fresh',
    cwd: 'D:/workspace/old',
    runtime: 'unknown',
    transcriptPath: 'C:/Users/jolen/.claude/projects/x/old.jsonl',
    spawnAt: 1000,
  });

  db.recordSessionSpawn({
    sessionId,
    name: 'taiwei-test',
    spawnReason: 'hook-discovery',
    cwd: 'D:/workspace/new',
    runtime: 'claude',
    transcriptPath: `C:/Users/jolen/.claude/projects/x/${sessionId}.jsonl`,
    spawnAt: 2000,
  });

  const [row] = db.getSessionsByName('taiwei-test', 10);
  assert.equal(row.spawnReason, 'hook-discovery');
  assert.equal(row.runtime, 'claude');
  assert.equal(row.cwd, 'D:/workspace/new');
  assert.equal(row.transcriptPath, `C:/Users/jolen/.claude/projects/x/${sessionId}.jsonl`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions_history').get().count, 1);
});

test('getSessionsByName returns newest rows first and excludes pending placeholders', () => {
  db.recordSessionSpawn({
    sessionId: '22222222-2222-4222-8222-222222222222',
    name: 'taiwei-test',
    spawnAt: 2000,
  });
  db.recordSessionSpawn({
    sessionId: '33333333-3333-4333-8333-333333333333',
    name: 'taiwei-test',
    spawnAt: 3000,
  });
  db.recordSessionSpawn({
    sessionId: 'pending-4000',
    name: 'taiwei-test',
    spawnReason: 'atomic-handoff',
    spawnAt: 4000,
  });
  db.recordSessionSpawn({
    sessionId: '44444444-4444-4444-8444-444444444444',
    name: 'other-session',
    spawnAt: 4000,
  });

  assert.deepEqual(
    db.getSessionsByName('taiwei-test', 10).map((row) => row.sessionId),
    [
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
    ],
  );
});

test('updateSessionLastSeen and markSessionEnded update timestamps', () => {
  const sessionId = '55555555-5555-4555-8555-555555555555';
  db.recordSessionSpawn({
    sessionId,
    name: 'taiwei-test',
    spawnAt: 1000,
  });

  assert.equal(db.updateSessionLastSeen(sessionId, 5000), 1);
  assert.equal(db.markSessionEnded(sessionId, 6000), 1);

  const [row] = db.getSessionsByName('taiwei-test', 1);
  assert.equal(row.lastSeenAt, 6000);
  assert.equal(row.endedAt, 6000);
});

test('real child session inherits latest pending atomic handoff parent metadata', () => {
  db.recordSessionSpawn({
    sessionId: 'pending-7000',
    name: 'taiwei-director',
    parentName: 'taiwei-director-old',
    parentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    spawnReason: 'atomic-handoff',
    spawnAt: 7000,
  });

  db.recordSessionSpawn({
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'taiwei-director',
    spawnReason: 'hook-discovery',
    spawnAt: 8000,
  });

  const [row] = db.getSessionsByName('taiwei-director', 10);
  assert.equal(row.parentName, 'taiwei-director-old');
  assert.equal(row.parentSessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(row.spawnReason, 'hook-discovery');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions_history WHERE name = 'taiwei-director' AND session_id LIKE 'pending-%'").get().count, 0);
});

process.on('exit', () => {
  try {
    sqlite.close();
  } catch {}
  try {
    db.close();
  } catch {}
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
});
