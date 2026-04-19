import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { getTempDbPath } from './helpers/temp-path.mjs';

const DB_PATH = getTempDbPath('db-pending-rebind');
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

function makeBufferedMessage(id, overrides = {}) {
  return {
    id,
    type: 'message',
    from: 'sender',
    to: 'handover-target',
    content: `buffered-${id}`,
    contentType: 'text',
    topic: null,
    ts: Date.now(),
    ...overrides,
  };
}

test('createPendingRebind + findPendingRebind: 可创建并读回 topics / metadata', () => {
  const releasedAt = Date.now();
  const created = db.createPendingRebind({
    name: 'handover-alpha',
    lastTopics: ['foo', 'bar'],
    releasedAt,
    ttlSeconds: 7,
    nextSessionHint: 'alpha-v2',
  });

  assert.deepEqual(created, {
    name: 'handover-alpha',
    lastTopics: ['foo', 'bar'],
    bufferedMessages: [],
    releasedAt,
    ttlSeconds: 7,
    nextSessionHint: 'alpha-v2',
  });

  const found = db.findPendingRebind('handover-alpha');
  assert.deepEqual(found, created);
});

test('createPendingRebind: 同名未过期记录重复创建时抛 ERR_REBIND_PENDING', () => {
  const releasedAt = Date.now();
  db.createPendingRebind({
    name: 'handover-dup',
    lastTopics: ['foo'],
    releasedAt,
    ttlSeconds: 5,
  });

  assert.throws(
    () => db.createPendingRebind({
      name: 'handover-dup',
      lastTopics: ['bar'],
      releasedAt: releasedAt + 1,
      ttlSeconds: 5,
    }),
    (error) => {
      assert.equal(error.code, db.ERR_REBIND_PENDING);
      assert.equal(error.willReleaseAt, releasedAt + 5_000);
      return true;
    },
  );
});

test('createPendingRebind: 已过期同名记录会被覆盖', () => {
  const oldReleasedAt = Date.now() - 10_000;
  db.createPendingRebind({
    name: 'handover-expired',
    lastTopics: ['old-topic'],
    releasedAt: oldReleasedAt,
    ttlSeconds: 1,
  });

  const freshReleasedAt = Date.now();
  const created = db.createPendingRebind({
    name: 'handover-expired',
    lastTopics: ['new-topic'],
    releasedAt: freshReleasedAt,
    ttlSeconds: 5,
    nextSessionHint: 'fresh',
  });

  assert.deepEqual(created.lastTopics, ['new-topic']);
  assert.deepEqual(created.bufferedMessages, []);
  assert.equal(created.releasedAt, freshReleasedAt);
  assert.equal(created.ttlSeconds, 5);
  assert.equal(created.nextSessionHint, 'fresh');
});

test('appendBufferedMessage: 多次追加后按写入顺序保留所有消息', async () => {
  db.createPendingRebind({
    name: 'handover-buffered',
    lastTopics: ['ops'],
    releasedAt: Date.now(),
    ttlSeconds: 5,
  });

  const messages = Array.from({ length: 8 }, (_, index) => makeBufferedMessage(`msg-${index}`, { ts: index + 1 }));
  await Promise.all(messages.map((message) => Promise.resolve().then(() => db.appendBufferedMessage('handover-buffered', message))));

  const found = db.findPendingRebind('handover-buffered');
  assert.deepEqual(found.bufferedMessages.map((message) => message.id), messages.map((message) => message.id));
  assert.deepEqual(found.bufferedMessages.map((message) => message.ts), messages.map((message) => message.ts));
});

test('appendBufferedMessage: name 不存在或已过期时 no-op', () => {
  assert.equal(db.appendBufferedMessage('missing-target', makeBufferedMessage('missing')), 0);

  db.createPendingRebind({
    name: 'handover-noop',
    lastTopics: [],
    releasedAt: Date.now() - 10_000,
    ttlSeconds: 1,
  });

  assert.equal(db.appendBufferedMessage('handover-noop', makeBufferedMessage('expired')), 0);
  assert.equal(db.findPendingRebind('handover-noop'), null);
});

test('findPendingRebind + cleanupExpiredPendingRebind: 过期记录查询返回 null，清理返回删除数', () => {
  db.createPendingRebind({
    name: 'handover-cleanup-old',
    lastTopics: ['old'],
    releasedAt: Date.now() - 10_000,
    ttlSeconds: 1,
  });
  db.createPendingRebind({
    name: 'handover-cleanup-fresh',
    lastTopics: ['fresh'],
    releasedAt: Date.now(),
    ttlSeconds: 10,
  });

  assert.equal(db.findPendingRebind('handover-cleanup-old'), null);
  assert.deepEqual(db.findPendingRebind('handover-cleanup-fresh')?.lastTopics, ['fresh']);

  const deleted = db.cleanupExpiredPendingRebind();
  assert.equal(deleted, 1);

  const rows = sqlite.prepare(`
    SELECT name
    FROM pending_rebind
    ORDER BY name ASC
  `).all();
  assert.deepEqual(rows.map((row) => row.name), ['handover-cleanup-fresh']);
});

test('clearPendingRebind: 删除指定记录并返回影响行数', () => {
  db.createPendingRebind({
    name: 'handover-clear',
    lastTopics: ['foo'],
    releasedAt: Date.now(),
    ttlSeconds: 5,
  });

  assert.equal(db.clearPendingRebind('handover-clear'), 1);
  assert.equal(db.clearPendingRebind('handover-clear'), 0);
  assert.equal(db.findPendingRebind('handover-clear'), null);
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
