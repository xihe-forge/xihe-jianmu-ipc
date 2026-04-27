import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCommittedPct } from '../../bin/network-watchdog.mjs';

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

function createHarness({ nowValue = 1_000_000 } = {}) {
  const ipcCalls = [];
  const spawnMock = createSpawnMock();
  const stderrCalls = [];
  const lastCommitAction = { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY };
  return {
    ipcCalls,
    spawnMock,
    stderrCalls,
    lastCommitAction,
    now: () => nowValue,
    ipcSend: (payload) => {
      ipcCalls.push(payload);
      return true;
    },
    stderr: (line) => {
      stderrCalls.push(line);
    },
  };
}

function run(result, harness) {
  return handleCommittedPct(result, {
    ipcSend: harness.ipcSend,
    spawnImpl: harness.spawnMock.spawnImpl,
    now: harness.now,
    stderr: harness.stderr,
    lastCommitAction: harness.lastCommitAction,
  });
}

test('committed_pct actions: 60% does not broadcast or tree-kill', () => {
  const harness = createHarness();

  const acted = run({ ok: true, pct: 60 }, harness);

  assert.equal(acted, false);
  assert.equal(harness.ipcCalls.length, 0);
  assert.equal(harness.spawnMock.calls.length, 0);
});

test('committed_pct actions: 90% is info-only without critique', () => {
  const harness = createHarness();

  const acted = run({ ok: true, pct: 90 }, harness);

  assert.equal(acted, false);
  assert.equal(harness.ipcCalls.length, 0);
  assert.equal(harness.spawnMock.calls.length, 0);
});

test('committed_pct actions: 95% is info-only without tree-kill', async () => {
  const harness = createHarness();

  const acted = run({ ok: true, pct: 95 }, harness);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(acted, false);
  assert.equal(harness.ipcCalls.length, 0);
  assert.equal(harness.spawnMock.calls.length, 0);
});

test('committed_pct actions: 95% aborted tree-kill path is no longer used', async () => {
  const harness = createHarness();
  harness.spawnMock = createSpawnMock({
    stdout: '{"aborted_reason":"vitest root PID not found","suspects_found":0,"killed":[]}',
  });

  const acted = run({ ok: true, pct: 95 }, harness);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(acted, false);
  assert.equal(harness.spawnMock.calls.length, 0);
  assert.equal(harness.ipcCalls.length, 0);
  assert.equal(harness.stderrCalls.length, 0);
});

test('committed_pct actions: repeated 90% remains info-only', () => {
  const harness = createHarness();

  run({ ok: true, pct: 90 }, harness);
  run({ ok: true, pct: 90 }, harness);

  assert.equal(harness.ipcCalls.length, 0);
  assert.equal(harness.spawnMock.calls.length, 0);
});

test('committed_pct actions: dedup window does not emit info-only action', () => {
  let nowValue = 1_000_000;
  const harness = createHarness();
  harness.now = () => nowValue;

  run({ ok: true, pct: 90 }, harness);
  nowValue += (5 * 60 * 1000) + 1;
  run({ ok: true, pct: 90 }, harness);

  assert.equal(harness.ipcCalls.length, 0);
  assert.equal(harness.spawnMock.calls.length, 0);
});
