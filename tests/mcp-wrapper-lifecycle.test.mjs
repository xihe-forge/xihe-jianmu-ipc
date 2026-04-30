import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, stopHub, waitForHealth, sleep } from './helpers/hub-fixture.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const wrapperPath = join(projectRoot, 'mcp-wrapper.mjs');

async function loadWrapper() {
  return import(`../mcp-wrapper.mjs?lifecycle=${Date.now()}-${Math.random()}`);
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.ended = false;
    this.destroyed = false;
    this.writes = [];
  }

  write(data) {
    this.writes.push(data);
    return true;
  }

  end() {
    this.ended = true;
    this.writable = false;
  }

  destroy() {
    this.destroyed = true;
    this.writable = false;
  }
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.stdin = new FakeStdin();
    this.stdout = new EventEmitter();
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  exit(code, signal = null) {
    this.emit('exit', code, signal);
  }
}

function createHarness() {
  let nowMs = 0;
  let nextPid = 2000;
  let mtime = 1;
  const children = [];
  const timers = [];
  const intervals = [];
  const logs = [];
  const exitCalls = [];
  const stdin = new EventEmitter();
  const processLike = new EventEmitter();
  const stdout = { write: () => true };
  const stderr = { write: (data) => logs.push(String(data)) };

  const spawnFn = () => {
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child;
  };

  const setTimeoutFn = (fn, delay) => {
    const timer = { fn, delay, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };

  const clearTimeoutFn = (timer) => {
    if (timer) timer.cleared = true;
  };

  const setIntervalFn = (fn, delay) => {
    const interval = { fn, delay, cleared: false, unref() {} };
    intervals.push(interval);
    return interval;
  };

  const clearIntervalFn = (interval) => {
    if (interval) interval.cleared = true;
  };

  return {
    children,
    timers,
    intervals,
    logs,
    exitCalls,
    stdin,
    processLike,
    stdout,
    stderr,
    spawnFn,
    setTimeoutFn,
    clearTimeoutFn,
    setIntervalFn,
    clearIntervalFn,
    statFn: () => ({ mtimeMs: mtime }),
    nowFn: () => nowMs,
    exitFn: (code) => exitCalls.push(code),
    advance(ms) {
      nowMs += ms;
    },
  };
}

function waitForParentMessage(parent, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('timed out waiting for parent IPC message')), timeoutMs);

    const onMessage = (message) => {
      if (predicate(message)) finish(null, message);
    };
    const onExit = (code, signal) => {
      finish(new Error(`parent exited before IPC message (code=${code} signal=${signal})`));
    };
    const onError = (error) => finish(error);

    parent.on('message', onMessage);
    parent.once('exit', onExit);
    parent.once('error', onError);

    function finish(error = null, message = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent.off('message', onMessage);
      parent.off('exit', onExit);
      parent.off('error', onError);
      if (error) reject(error);
      else resolve(message);
    }
  });
}

async function waitForLogPattern(logPath, pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';

  while (Date.now() < deadline) {
    try {
      lastText = await readFile(logPath, 'utf8');
      const match = lastText.match(pattern);
      if (match) return { text: lastText, match };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await sleep(25);
  }

  throw new Error(`timed out waiting for log pattern ${pattern}\n${lastText}`);
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(25);
  }
  throw new Error(`pid ${pid} did not exit within ${timeoutMs}ms`);
}

function killPid(pid) {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function uniqueName(suffix) {
  return `wrapper-lifecycle-${suffix}-${process.pid}-${Date.now()}`;
}

async function withBlockedProcessExit(fn) {
  const originalExit = process.exit;
  process.exit = (code) => {
    throw new Error(`unexpected global process.exit(${code})`);
  };
  try {
    return await fn();
  } finally {
    process.exit = originalExit;
  }
}

describe('Phase 2 K.Y-1 mcp-wrapper lifecycle shutdown unit', () => {
  test('shutdown closes child stdin, forwards SIGTERM, then exits after child exit', async () => {
    await withBlockedProcessExit(async () => {
      const { createMcpWrapper } = await loadWrapper();
      const harness = createHarness();
      const wrapper = createMcpWrapper(harness);

      wrapper.startChild();
      const child = harness.children[0];

      wrapper.shutdown('SIGTERM');

      assert.equal(child.stdin.ended, true);
      assert.equal(child.killSignal, 'SIGTERM');
      assert.deepEqual(harness.exitCalls, []);

      child.exit(0, null);
      assert.deepEqual(harness.exitCalls, [0]);
    });
  });

  test('stdin EOF triggers the same graceful shutdown path', async () => {
    await withBlockedProcessExit(async () => {
      const { createMcpWrapper } = await loadWrapper();
      const harness = createHarness();
      const wrapper = createMcpWrapper(harness);

      wrapper.start();
      const child = harness.children[0];

      harness.stdin.emit('end');

      assert.equal(child.stdin.ended, true);
      assert.equal(child.killSignal, 'SIGTERM');

      child.exit(0, null);
      assert.deepEqual(harness.exitCalls, [0]);
    });
  });

  test('SIGHUP is registered and child exit during shutdown does not restart', async () => {
    await withBlockedProcessExit(async () => {
      const { createMcpWrapper } = await loadWrapper();
      const harness = createHarness();
      const wrapper = createMcpWrapper(harness);

      wrapper.start();
      const child = harness.children[0];

      harness.processLike.emit('SIGHUP');
      child.exit(0, null);

      assert.equal(child.killSignal, 'SIGTERM');
      assert.equal(harness.children.length, 1);
      assert.deepEqual(harness.exitCalls, [0]);
    });
  });
});

describe('Phase 2 K.Y-1 mcp-wrapper parent disconnect e2e', () => {
  test('killing wrapper parent closes wrapper and mcp-server child within 5s and removes hub session', { timeout: 20_000 }, async () => {
    const hub = await startHub({ prefix: 'mcp-wrapper-lifecycle' });
    const tempDir = await mkdtemp(join(tmpdir(), 'mcp-wrapper-lifecycle-'));
    const logPath = join(tempDir, 'wrapper.log');
    const parentPath = join(tempDir, 'wrapper-parent.mjs');
    const ipcName = uniqueName('parent-death');
    let parent = null;
    let wrapperPid = null;
    let childPid = null;

    const parentSource = `
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

const [wrapperPath, projectRoot, logPath] = process.argv.slice(2);
const logFd = openSync(logPath, 'a');
const wrapper = spawn(process.execPath, [wrapperPath], {
  cwd: projectRoot,
  env: process.env,
  detached: true,
  stdio: ['pipe', 'ignore', logFd],
  windowsHide: true,
});
closeSync(logFd);
process.send?.({ type: 'wrapper', pid: wrapper.pid });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1000);
`;

    try {
      await writeFile(parentPath, parentSource, 'utf8');
      closeSync(openSync(logPath, 'a'));

      parent = spawn(process.execPath, [parentPath, wrapperPath, projectRoot, logPath], {
        cwd: projectRoot,
        env: {
          ...process.env,
          IPC_HUB_AUTOSTART: 'false',
          IPC_MCP_TRACE_DISABLE: '1',
          IPC_NAME: ipcName,
          IPC_PORT: String(hub.port),
          IPC_RUNTIME: 'claude',
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      });

      const parentErrors = [];
      parent.stderr.setEncoding('utf8');
      parent.stderr.on('data', (chunk) => parentErrors.push(chunk));

      const wrapperMessage = await waitForParentMessage(parent, (message) => message?.type === 'wrapper');
      wrapperPid = wrapperMessage.pid;

      const childStarted = await waitForLogPattern(logPath, /started mcp-server\.mjs \(pid=(\d+)\)/);
      childPid = Number(childStarted.match[1]);
      await waitForLogPattern(logPath, /MCP server ready/);

      await waitForHealth(
        hub.port,
        (body) => body.sessions.some((session) => session.name === ipcName),
        5_000,
      );

      const startedAt = Date.now();
      parent.kill('SIGTERM');

      await Promise.all([
        waitForPidExit(wrapperPid, 5_000),
        waitForPidExit(childPid, 5_000),
      ]);
      assert.ok(Date.now() - startedAt <= 5_000);

      const health = await waitForHealth(
        hub.port,
        (body) => !body.sessions.some((session) => session.name === ipcName),
        5_000,
      );
      assert.ok(!health.sessions.some((session) => session.name === ipcName));

      const log = await readFile(logPath, 'utf8');
      assert.match(log, /\[mcp-wrapper\] received stdin-(end|close), shutting down/);
      assert.deepEqual(parentErrors, []);
    } finally {
      killPid(childPid);
      killPid(wrapperPid);
      killPid(parent?.pid);
      await stopHub(hub);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
