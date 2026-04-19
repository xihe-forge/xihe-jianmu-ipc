import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createLineageTracker } from '../lib/lineage.mjs';
import { getTempDbPath } from './helpers/temp-path.mjs';

function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
  };
}

test('record + check: 单次 handover 记录后 depth 与窗口计数正确', () => {
  const clock = createClock(1_000);
  const tracker = createLineageTracker({ now: clock.now });

  const record = tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'abc1234',
    reason: 'auto',
  });

  assert.equal(record.depth, 1);
  assert.deepEqual(tracker.check('harness'), {
    allowed: true,
    depth: 1,
    wakesInWindow: 1,
  });
});

test('check: depth 达到 5 时拒绝继续 spawn', () => {
  const clock = createClock(5_000);
  const tracker = createLineageTracker({ now: clock.now });

  for (let index = 0; index < 5; index += 1) {
    tracker.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: `sha${index}`,
      reason: 'auto',
    });
    clock.advance(1);
  }

  assert.deepEqual(tracker.check('harness'), {
    allowed: false,
    depth: 5,
    wakesInWindow: 5,
    reason: 'max-depth',
  });
});

test('check: 10 分钟窗口内第 4 次会被拒绝', () => {
  const clock = createClock(10_000);
  const tracker = createLineageTracker({
    maxDepth: 99,
    maxWithinWindow: 3,
    now: clock.now,
  });

  for (let index = 0; index < 3; index += 1) {
    tracker.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: `sha${index}`,
      reason: 'auto',
    });
    clock.advance(60_000);
  }

  assert.deepEqual(tracker.check('harness'), {
    allowed: false,
    depth: 3,
    wakesInWindow: 3,
    reason: 'max-within-window',
  });
});

test('reset: 熔断后可清链并重新允许 spawn', () => {
  const clock = createClock(20_000);
  const tracker = createLineageTracker({
    maxDepth: 2,
    now: clock.now,
  });

  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'sha-a',
    reason: 'auto',
  });
  clock.advance(1);
  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'sha-b',
    reason: 'auto',
  });

  assert.equal(tracker.check('harness').allowed, false);
  assert.equal(tracker.reset('harness'), 2);
  assert.deepEqual(tracker.check('harness'), {
    allowed: true,
    depth: 0,
    wakesInWindow: 0,
  });
});

test('chain: 返回从根到 leaf 的 parent_session_id 序列', () => {
  const clock = createClock(30_000);
  const tracker = createLineageTracker({ now: clock.now });

  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'sha-root',
    reason: 'threshold_55',
  });
  clock.advance(1);
  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'sha-mid',
    reason: 'threshold_65',
  });
  clock.advance(1);
  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'sha-leaf',
    reason: 'crash_recovery',
  });

  assert.deepEqual(tracker.chain('harness'), ['sha-root', 'sha-mid', 'sha-leaf']);
});

test('windowMs 外的记录不计入 wakesInWindow', () => {
  const clock = createClock(0);
  const tracker = createLineageTracker({
    maxDepth: 99,
    windowMs: 10 * 60 * 1000,
    now: clock.now,
  });

  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'sha-old',
    reason: 'auto',
  });
  clock.advance(10 * 60 * 1000 + 1);
  tracker.record({
    childName: 'harness',
    parentName: 'harness',
    parentSessionId: 'sha-new',
    reason: 'auto',
  });

  assert.deepEqual(tracker.check('harness'), {
    allowed: true,
    depth: 2,
    wakesInWindow: 1,
  });
});

test('dbPath: tracker 重建后仍能读回持久化 lineage', () => {
  const clock = createClock(100_000);
  const dbPath = getTempDbPath('lineage');

  try {
    const first = createLineageTracker({
      dbPath,
      now: clock.now,
      maxDepth: 99,
      maxWithinWindow: 99,
    });
    first.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: 'sha-1',
      reason: 'auto',
    });
    clock.advance(5);
    first.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: 'sha-2',
      reason: 'auto',
    });

    const second = createLineageTracker({
      dbPath,
      now: clock.now,
      maxDepth: 99,
      maxWithinWindow: 99,
    });

    assert.deepEqual(second.chain('harness'), ['sha-1', 'sha-2']);
    assert.deepEqual(second.check('harness'), {
      allowed: true,
      depth: 2,
      wakesInWindow: 2,
    });
  } finally {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (existsSync(path)) {
          rmSync(path, { force: true });
        }
      } catch {
        // tracker 当前实现持有 SQLite 连接，Windows 上测试结束前允许遗留临时文件
      }
    }
  }
});
