import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { getTempDbPath } from './helpers/temp-path.mjs';

const DB_PATH = getTempDbPath('db-recipient');
process.env.IPC_DB_PATH = DB_PATH;

const db = await import('../lib/db.mjs');
const sqlite = new Database(DB_PATH);

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM messages;
    DELETE FROM inbox;
    DELETE FROM tasks;
    DELETE FROM suspended_sessions;
    DELETE FROM pending_rebind;
  `);
});

function makeMsg(id, overrides = {}) {
  return {
    id,
    type: 'message',
    from: 'sender',
    to: 'alpha',
    content: `content-${id}`,
    contentType: 'text',
    topic: null,
    ts: Date.now(),
    ...overrides,
  };
}

test('getRecipientRecent: 只返回发给指定 session 或广播消息', () => {
  const target = `target_${Date.now()}`;
  const direct = makeMsg(`direct_${Date.now()}`, { to: target, ts: Date.now() - 100 });
  const broadcast = makeMsg(`broadcast_${Date.now()}`, { to: '*', ts: Date.now() - 50 });
  const other = makeMsg(`other_${Date.now()}`, { to: 'someone-else', ts: Date.now() - 10 });

  db.saveMessage(direct);
  db.saveMessage(broadcast);
  db.saveMessage(other);

  const rows = db.getRecipientRecent(target, 60 * 60 * 1000, 10);

  assert.deepEqual(rows.map((row) => row.id), [direct.id, broadcast.id]);
});

test('getRecipientRecent: since 过滤超过窗口的消息', () => {
  const target = `since_${Date.now()}`;
  const oldMsg = makeMsg(`old_${Date.now()}`, { to: target, ts: Date.now() - 10_000 });
  const freshMsg = makeMsg(`fresh_${Date.now()}`, { to: target, ts: Date.now() - 10 });

  db.saveMessage(oldMsg);
  db.saveMessage(freshMsg);

  const rows = db.getRecipientRecent(target, 1_000, 10);

  assert.deepEqual(rows.map((row) => row.id), [freshMsg.id]);
});

test('getRecipientRecent: limit 生效并按 ts 升序返回', () => {
  const target = `limit_${Date.now()}`;
  const first = makeMsg(`first_${Date.now()}`, { to: target, ts: Date.now() - 300 });
  const second = makeMsg(`second_${Date.now()}`, { to: target, ts: Date.now() - 200 });
  const third = makeMsg(`third_${Date.now()}`, { to: target, ts: Date.now() - 100 });

  db.saveMessage(first);
  db.saveMessage(second);
  db.saveMessage(third);

  const rows = db.getRecipientRecent(target, 60 * 60 * 1000, 2);

  assert.deepEqual(rows.map((row) => row.id), [first.id, second.id]);
});

test('getRecipientRecent: 返回内容会脱敏', () => {
  const target = `redact_${Date.now()}`;
  const msg = makeMsg(`redact_msg_${Date.now()}`, {
    to: target,
    content: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz1234567890',
  });

  db.saveMessage(msg);

  const rows = db.getRecipientRecent(target, 60 * 60 * 1000, 10);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'Authorization: [REDACTED]');
});

test('getRecipientRecent: EXPLAIN QUERY PLAN 命中 idx_messages_to_ts', () => {
  const sqlite = new Database(DB_PATH, { readonly: true });

  try {
    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM messages
      WHERE ("to" = @name OR "to" = '*')
        AND ts >= @since
      ORDER BY ts ASC
      LIMIT @limit
    `).all({
      name: `plan_${Date.now()}`,
      since: Date.now() - 60 * 60 * 1000,
      limit: 10,
    });

    assert.ok(plan.some((row) => String(row.detail).includes('idx_messages_to_ts')));
  } finally {
    sqlite.close();
  }
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
