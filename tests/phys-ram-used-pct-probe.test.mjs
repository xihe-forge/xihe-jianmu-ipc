import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

async function loadWatchdog() {
  return import('../bin/network-watchdog.mjs');
}

function createSpawnMock({ stdout = '{"suspects_found":1,"killed":[123]}', code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', code);
    });
    return child;
  };
  return { calls, spawnImpl };
}

describe('AC-WATCHDOG-008 phys_ram_used_pct probe', () => {
  test('AC-WATCHDOG-008-a: probe 返回结构含 { pct, available_mb, total_mb, timestamp }', async () => {
    const { probeAvailableRamPct } = await loadWatchdog();
    const result = await probeAvailableRamPct({
      sample: async () => ({ available_mb: 8_192, total_mb: 32_768 }),
      now: () => 1_711_111_111_000,
    });

    assert.equal(result.ok, true);
    assert.equal(typeof result.pct, 'number');
    assert.equal(result.available_mb, 8_192);
    assert.equal(result.total_mb, 32_768);
    assert.equal(result.timestamp, 1_711_111_111_000);
  });

  test('AC-WATCHDOG-008-b: pct 计算 (1 - avail/total) * 100 精度 1 位小数', async () => {
    const { probeAvailableRamPct } = await loadWatchdog();
    const result = await probeAvailableRamPct({
      sample: async () => ({ available_mb: 6_000, total_mb: 16_000 }),
      now: () => 1_711_111_111_000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.pct, 62.5);
  });

  test('AC-WATCHDOG-008-c: 阈值判定 used=75% → level=null；used=82% → level=WARN；used=92% → level=CRIT', async () => {
    const { handleAvailableRamPct } = await loadWatchdog();
    const sent = [];
    const spawnMock = createSpawnMock();
    const options = {
      ipcSend: async (message) => sent.push(message),
      now: () => 1_000_000,
      stderr: () => {},
      lastPhysRamAction: { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY },
      spawnImpl: spawnMock.spawnImpl,
      lastPhysRamTreeKillAction: { CRIT: Number.NEGATIVE_INFINITY },
    };

    assert.equal(handleAvailableRamPct({ ok: true, pct: 75 }, options), null);
    assert.equal(handleAvailableRamPct({ ok: true, pct: 82 }, options), 'WARN');
    assert.equal(handleAvailableRamPct({ ok: true, pct: 92 }, options), 'CRIT');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((message) => message.topic), ['critique', 'critique']);
    assert.equal(spawnMock.calls.length, 1);
    assert(spawnMock.calls[0].args.includes('tree-kill'));
  });

  test('AC-WATCHDOG-008-d: reset <70%；used 85%→WARN 后回落到 65%→重置；5min dedup per-level 沿 committed_pct 模板', async () => {
    const { handleAvailableRamPct } = await loadWatchdog();
    const sent = [];
    const spawnMock = createSpawnMock();
    let nowTs = 0;
    const options = {
      ipcSend: async (message) => sent.push(message),
      now: () => nowTs,
      stderr: () => {},
      lastPhysRamAction: { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY },
      spawnImpl: spawnMock.spawnImpl,
      lastPhysRamTreeKillAction: { CRIT: Number.NEGATIVE_INFINITY },
    };

    assert.equal(handleAvailableRamPct({ ok: true, pct: 85 }, options), 'WARN');
    nowTs += 1_000;
    assert.equal(handleAvailableRamPct({ ok: true, pct: 85 }, options), null);
    nowTs += 1_000;
    assert.equal(handleAvailableRamPct({ ok: true, pct: 92 }, options), 'CRIT');
    nowTs += 1_000;
    assert.equal(handleAvailableRamPct({ ok: true, pct: 65 }, options), null);
    assert.deepEqual(options.lastPhysRamAction, {
      WARN: Number.NEGATIVE_INFINITY,
      CRIT: Number.NEGATIVE_INFINITY,
    });
    assert.equal(handleAvailableRamPct({ ok: true, pct: 85 }, options), 'WARN');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 3);
    assert.equal(spawnMock.calls.length, 1);
  });
});
