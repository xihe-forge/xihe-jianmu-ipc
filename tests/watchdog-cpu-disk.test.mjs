import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  alertComputerWorker,
  handleCpuUsedPct,
  handleDiskUsedPct,
} from '../bin/network-watchdog.mjs';
import {
  probeCpuUsedPct,
  probeDiskUsedPct,
} from '../lib/network-probes.mjs';

function createSpawnMock({ stdout = '', stderr = '', code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) {
        child.stdout.emit('data', stdout);
      }
      if (stderr) {
        child.stderr.emit('data', stderr);
      }
      child.emit('close', code);
    });
    return child;
  };
  return { calls, spawnImpl };
}

test('probeCpuUsedPct: PowerShell sample is parsed into pct, latency and ts', async () => {
  const nowValues = [1_000, 1_025, 1_025];
  const spawnMock = createSpawnMock({ stdout: '82.5\r\n' });
  const result = await probeCpuUsedPct({
    spawnImpl: spawnMock.spawnImpl,
    now: () => nowValues.shift() ?? 1_025,
  });

  assert.equal(result.ok, true);
  assert.equal(result.pct, 82.5);
  assert.equal(result.latencyMs, 25);
  assert.equal(result.ts, 1_025);
  assert.equal(spawnMock.calls[0].command, 'pwsh');
  assert(spawnMock.calls[0].args.some((arg) => String(arg).includes('Win32_Processor')));
});

test('probeDiskUsedPct: maxUsedPct uses the fullest local drive', async () => {
  const sample = async () => [
    { DeviceID: 'C:', FreeSpace: 20, Size: 100 },
    { DeviceID: 'D:', FreeSpace: 5, Size: 100 },
  ];

  const result = await probeDiskUsedPct({ sample, now: () => 10 });

  assert.equal(result.ok, true);
  assert.equal(result.maxUsedPct, 95);
  assert.deepEqual(result.drives.map((drive) => [drive.drive, drive.usedPct]), [
    ['C:', 80],
    ['D:', 95],
  ]);
});

test('alertComputerWorker: offline target path sends through hub /send payload', () => {
  const sent = [];
  const acted = alertComputerWorker('⚠️ CPU/磁盘 超 80%·建议排查', {
    ipcSend: (payload) => {
      sent.push(payload);
      return true;
    },
    stderr: () => {},
  });

  assert.equal(acted, true);
  assert.deepEqual(sent, [{
    to: 'computer-worker',
    topic: 'critique',
    content: '⚠️ CPU/磁盘 超 80%·建议排查',
  }]);
});

test('handleCpuUsedPct and handleDiskUsedPct broadcast then single-ping computer-worker', async () => {
  const sent = [];
  const options = {
    ipcSend: async (payload) => {
      sent.push(payload);
      return true;
    },
    now: () => 1_000_000,
    stderr: () => {},
  };

  assert.equal(handleCpuUsedPct({ ok: true, pct: 81.2 }, options), true);
  assert.equal(handleDiskUsedPct({
    ok: true,
    maxUsedPct: 92,
    drives: [{ drive: 'D:', usedPct: 92, freeBytes: 8, sizeBytes: 100 }],
  }, options), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent.map((message) => message.to), ['*', 'computer-worker', '*', 'computer-worker']);
  assert.match(sent[0].content, /cpu_used_pct 81\.2%/);
  assert.match(sent[2].content, /disk_used_pct D: 92\.0%/);
});
