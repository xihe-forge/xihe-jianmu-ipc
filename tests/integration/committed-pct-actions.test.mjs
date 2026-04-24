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

test('committed_pct actions: 90% broadcasts WARN critique once', () => {
  const harness = createHarness();

  const acted = run({ ok: true, pct: 90 }, harness);

  assert.equal(acted, true);
  assert.equal(harness.ipcCalls.length, 1);
  assert.equal(harness.ipcCalls[0].topic, 'critique');
  assert.match(harness.ipcCalls[0].content, /90/);
  assert.match(harness.ipcCalls[0].content, /WARN/);
  assert.equal(harness.spawnMock.calls.length, 0);
});

test('committed_pct actions: 95% invokes session-guard tree-kill without broadcast', async () => {
  const harness = createHarness();

  const acted = run({ ok: true, pct: 95 }, harness);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(acted, true);
  assert.equal(harness.ipcCalls.length, 0);
  assert.equal(harness.spawnMock.calls.length, 1);
  assert.equal(harness.spawnMock.calls[0].command, 'pwsh');
  assert(harness.spawnMock.calls[0].args.some((arg) => arg.includes('session-guard.ps1')));
  assert(harness.spawnMock.calls[0].args.includes('tree-kill'));
  assert(harness.spawnMock.calls[0].args.includes('-ExcludePattern'));
});

test('committed_pct actions: aborted tree-kill result does not retry or throw', async () => {
  const harness = createHarness();
  harness.spawnMock = createSpawnMock({
    stdout: '{"aborted_reason":"vitest root PID not found","suspects_found":0,"killed":[]}',
  });

  const acted = run({ ok: true, pct: 95 }, harness);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(acted, true);
  assert.equal(harness.spawnMock.calls.length, 1);
  assert.equal(harness.ipcCalls.length, 0);
  assert.match(harness.stderrCalls.join('\n'), /vitest root PID not found/);
});

test('committed_pct actions: dedups repeated 90% WARN within 5min', () => {
  const harness = createHarness();

  run({ ok: true, pct: 90 }, harness);
  run({ ok: true, pct: 90 }, harness);

  assert.equal(harness.ipcCalls.length, 1);
  assert.equal(harness.spawnMock.calls.length, 0);
});

test('committed_pct actions: emits second WARN after 5min dedup window', () => {
  let nowValue = 1_000_000;
  const harness = createHarness();
  harness.now = () => nowValue;

  run({ ok: true, pct: 90 }, harness);
  nowValue += (5 * 60 * 1000) + 1;
  run({ ok: true, pct: 90 }, harness);

  assert.equal(harness.ipcCalls.length, 2);
  assert.equal(harness.spawnMock.calls.length, 0);
});
