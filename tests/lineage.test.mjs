import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { createLineageTracker } from '../lib/lineage.mjs';
import { getTempDbPath } from './helpers/temp-path.mjs';

const DB_PATH = getTempDbPath('lineage');
let currentTime = 1_000;
const tracker = createLineageTracker({
  dbPath: DB_PATH,
  now: () => currentTime,
});
const sqlite = new Database(DB_PATH);

beforeEach(() => {
  currentTime = 1_000;
  sqlite.exec('DELETE FROM lineage;');
});

test('record + check: 单次 handover 会落库并允许继续', () => {
  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'abc1234',
    reason: 'auto',
  });

  assert.deepEqual(tracker.check('harness'), {
    allowed: true,
    depth: 1,
    wakesInWindow: 1,
  });

  const rows = sqlite.prepare(`
    SELECT child_name, parent_name, parent_session_id, reason
    FROM lineage
  `).all();
  assert.deepEqual(rows, [{
    child_name: 'harness',
    parent_name: 'harness',
    parent_session_id: 'abc1234',
    reason: 'auto',
  }]);
});

test('check: depth 达到 5 时拒绝继续 spawn', () => {
  for (let index = 1; index <= 5; index += 1) {
    tracker.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: `sha${index}`,
      reason: 'auto',
    });
    currentTime += 1;
  }

  assert.deepEqual(tracker.check('harness'), {
    allowed: false,
    depth: 5,
    wakesInWindow: 5,
    reason: 'max-depth',
  });
});

test('check: 10 分钟窗口内第 4 次会被限流拒绝', () => {
  const rateLimitedTracker = createLineageTracker({
    dbPath: getTempDbPath('lineage-window'),
    maxDepth: 10,
    maxWithinWindow: 3,
    windowMs: 10 * 60 * 1000,
    now: () => currentTime,
  });

  try {
    for (let index = 1; index <= 3; index += 1) {
      rateLimitedTracker.record({
        childName: 'harness',
        parentName: 'harness',
        parentSessionId: `window-${index}`,
      });
      currentTime += 100;
    }

    assert.deepEqual(rateLimitedTracker.check('harness'), {
      allowed: false,
      depth: 3,
      wakesInWindow: 3,
      reason: 'rate-limit',
    });
  } finally {
    rateLimitedTracker.close();
  }
});

test('reset: 熔断后人工重置即可重新允许 spawn', () => {
  for (let index = 1; index <= 3; index += 1) {
    tracker.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: `reset-${index}`,
    });
    currentTime += 100;
  }

  assert.equal(tracker.reset('harness'), 3);
  assert.deepEqual(tracker.check('harness'), {
    allowed: true,
    depth: 0,
    wakesInWindow: 0,
  });
});

test('chain: 返回从根到当前 leaf 的 session id 序列', () => {
  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'aaa1111',
  });
  currentTime += 1;
  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'bbb2222',
  });
  currentTime += 1;
  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'ccc3333',
  });

  assert.deepEqual(tracker.chain('harness'), ['aaa1111', 'bbb2222', 'ccc3333']);
});

test('windowMs 外的记录不计入 wakesInWindow', () => {
  const rollingTracker = createLineageTracker({
    dbPath: getTempDbPath('lineage-rolling'),
    maxDepth: 10,
    windowMs: 1_000,
    now: () => currentTime,
  });

  try {
    rollingTracker.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: 'old-1',
    });
    currentTime += 1_500;
    rollingTracker.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: 'new-2',
    });

    assert.deepEqual(rollingTracker.check('harness'), {
      allowed: true,
      depth: 2,
      wakesInWindow: 1,
    });
  } finally {
    rollingTracker.close();
  }
});

process.on('exit', () => {
  try {
    sqlite.close();
  } catch {}

  try {
    tracker.close();
  } catch {}

  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
});
