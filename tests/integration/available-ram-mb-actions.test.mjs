import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleAvailableRamMb } from '../../bin/network-watchdog.mjs';

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
  const stderrCalls = [];
  const spawnMock = createSpawnMock();
  const lastPhysRamTreeKillAction = { CRIT: Number.NEGATIVE_INFINITY };
  const lastAvailableRamAction = { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY };
  return {
    ipcCalls,
    stderrCalls,
    spawnMock,
    lastPhysRamTreeKillAction,
    lastAvailableRamAction,
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
  return handleAvailableRamMb(result, {
    ipcSend: harness.ipcSend,
    now: harness.now,
    stderr: harness.stderr,
    lastAvailableRamAction: harness.lastAvailableRamAction,
    spawnImpl: harness.spawnMock.spawnImpl,
    lastPhysRamTreeKillAction: harness.lastPhysRamTreeKillAction,
  });
}

test('available_ram_mb actions: 15000 MB does not broadcast', () => {
  const harness = createHarness();

  const acted = run({ ok: true, availableMb: 15_000 }, harness);

  assert.equal(acted, false);
  assert.equal(harness.ipcCalls.length, 0);
});

test('available_ram_mb actions: 9000 MB broadcasts WARN critique once', () => {
  const harness = createHarness();

  const acted = run({ ok: true, availableMb: 9_000 }, harness);

  assert.equal(acted, true);
  assert.equal(harness.ipcCalls.length, 1);
  assert.equal(harness.ipcCalls[0].topic, 'critique');
  assert.match(harness.ipcCalls[0].content, /破 10GB/);
  assert.match(harness.ipcCalls[0].content, /警戒/);
});

test('available_ram_mb actions: 4000 MB broadcasts CRIT critique once', () => {
  const harness = createHarness();

  const acted = run({ ok: true, availableMb: 4_000 }, harness);

  assert.equal(acted, true);
  assert.equal(harness.ipcCalls.length, 1);
  assert.equal(harness.ipcCalls[0].topic, 'critique');
  assert.match(harness.ipcCalls[0].content, /破 5GB/);
  assert.match(harness.ipcCalls[0].content, /临界/);
  assert.equal(harness.spawnMock.calls.length, 0);
});

test('available_ram_mb actions: below 3GB invokes physical tree-kill', async () => {
  const harness = createHarness();

  const acted = run({ ok: true, availableMb: 2_999 }, harness);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(acted, true);
  assert.equal(harness.ipcCalls.length, 1);
  assert.equal(harness.spawnMock.calls.length, 1);
  assert.equal(harness.spawnMock.calls[0].command, 'pwsh');
  assert(harness.spawnMock.calls[0].args.some((arg) => arg.includes('session-guard.ps1')));
  assert(harness.spawnMock.calls[0].args.includes('tree-kill'));
});

test('available_ram_mb actions: CRIT dedup is independent from WARN', () => {
  const harness = createHarness();

  run({ ok: true, availableMb: 9_000 }, harness);
  run({ ok: true, availableMb: 4_000 }, harness);

  assert.equal(harness.ipcCalls.length, 2);
  assert.match(harness.ipcCalls[0].content, /破 10GB/);
  assert.match(harness.ipcCalls[1].content, /破 5GB/);
});

test('available_ram_mb actions: dedups repeated 9000 MB WARN within 5min', () => {
  const harness = createHarness();

  run({ ok: true, availableMb: 9_000 }, harness);
  run({ ok: true, availableMb: 9_000 }, harness);

  assert.equal(harness.ipcCalls.length, 1);
});

test('available_ram_mb actions: emits second WARN after 5min dedup window', () => {
  let nowValue = 1_000_000;
  const harness = createHarness();
  harness.now = () => nowValue;

  run({ ok: true, availableMb: 9_000 }, harness);
  nowValue += (5 * 60 * 1000) + 1;
  run({ ok: true, availableMb: 9_000 }, harness);

  assert.equal(harness.ipcCalls.length, 2);
});

test('available_ram_mb actions: failed probe does not broadcast', () => {
  const harness = createHarness();

  const acted = run({ ok: false, availableMb: 4_000, error: 'counter unavailable' }, harness);

  assert.equal(acted, false);
  assert.equal(harness.ipcCalls.length, 0);
});

test('available_ram_mb actions: null availableMb does not broadcast', () => {
  const harness = createHarness();

  const acted = run({ ok: true, availableMb: null }, harness);

  assert.equal(acted, false);
  assert.equal(harness.ipcCalls.length, 0);
});
