import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assertWrapperFactoryExported() {
  const source = readFileSync(join(process.cwd(), 'mcp-wrapper.mjs'), 'utf8');
  assert.match(source, /export\s+function\s+createMcpWrapper\b/, 'mcp-wrapper.mjs must export createMcpWrapper for lifecycle tests');
}

async function loadWrapper() {
  assertWrapperFactoryExported();
  return import(`../mcp-wrapper.mjs?test=${Date.now()}-${Math.random()}`);
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.stdin = { writable: true, write: () => true };
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
  let nextPid = 1000;
  let mtime = 1;
  const children = [];
  const timers = [];
  const logs = [];
  const restartAnnouncements = [];
  const stdin = new EventEmitter();
  const stdout = { write: () => true };
  const stderr = { write: (data) => logs.push(String(data)) };

  const spawnFn = () => {
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child;
  };

  const setTimeoutFn = (fn, delay) => {
    timers.push({ fn, delay });
    return { delay };
  };

  const setIntervalFn = (fn, delay) => ({ fn, delay });
  const statFn = () => ({ mtimeMs: mtime });

  return {
    children,
    timers,
    logs,
    stdin,
    stdout,
    stderr,
    spawnFn,
    setTimeoutFn,
    setIntervalFn,
    statFn,
    announceRestartFn: (detail) => {
      restartAnnouncements.push(detail);
      return { ok: true, id: `announce-${restartAnnouncements.length}` };
    },
    nowFn: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
    touch() {
      mtime += 1;
    },
    runNextTimer() {
      assert.ok(timers.length > 0, 'expected a scheduled timer');
      return timers.shift().fn();
    },
    restartAnnouncements,
  };
}

describe('AC-WRAPPER-001 mcp-wrapper child exit auto-restart', () => {
  test('AC-WRAPPER-001-0: restart pre-announce sends portfolio broadcast payload', async () => {
    const { sendRestartPreAnnounce } = await loadWrapper();
    const calls = [];

    const result = await sendRestartPreAnnounce({
      env: {
        IPC_NAME: 'codex-dogfood',
        IPC_HUB_HOST: '127.0.0.1',
        IPC_PORT: '4321',
      },
      reason: 'child-exit',
      delayMs: 1000,
      childPid: 1234,
      code: 1,
      signal: null,
      aliveMs: 25,
      wrapperPid: 5678,
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          async json() {
            return { accepted: true, id: 'msg-1' };
          },
        };
      },
    });

    assert.deepEqual(result, { ok: true, accepted: true, id: 'msg-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:4321/send');
    assert.equal(calls[0].options.method, 'POST');
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.from, 'codex-dogfood');
    assert.equal(payload.to, '*');
    assert.equal(payload.topic, 'feedback_portfolio_restart_pre_announce');
    assert.match(payload.content, /reason=child-exit/);
    assert.match(payload.content, /delay_ms=1000/);
    assert.match(payload.content, /child_pid=1234/);
  });

  test('AC-WRAPPER-001-a: child unintentional exit auto-spawns a new child', async () => {
    const { createMcpWrapper } = await loadWrapper();
    const harness = createHarness();
    const wrapper = createMcpWrapper(harness);

    wrapper.startChild();
    harness.children[0].exit(0, null);

    assert.equal(harness.restartAnnouncements.length, 1);
    assert.deepEqual(harness.restartAnnouncements[0], {
      reason: 'child-exit',
      delayMs: 1000,
      childPid: 1000,
      code: 0,
      signal: null,
      aliveMs: 0,
    });
    assert.equal(harness.timers[0].delay, 1000);
    harness.runNextTimer();
    assert.equal(harness.children.length, 2);
  });

  test('AC-WRAPPER-001-b: consecutive unintentional exits use capped backoff sequence', async () => {
    const { createMcpWrapper } = await loadWrapper();
    const harness = createHarness();
    const wrapper = createMcpWrapper(harness);
    const expectedDelays = [1000, 5000, 15000, 60000, 60000];

    wrapper.startChild();
    for (let index = 0; index < expectedDelays.length; index += 1) {
      harness.children[index].exit(1, null);
      assert.equal(harness.restartAnnouncements[index].delayMs, expectedDelays[index]);
      assert.equal(harness.timers[0].delay, expectedDelays[index]);
      harness.runNextTimer();
    }

    assert.equal(harness.children.length, expectedDelays.length + 1);
  });

  test('AC-WRAPPER-001-c: stable child exit resets backoff to base delay', async () => {
    const { createMcpWrapper } = await loadWrapper();
    const harness = createHarness();
    const wrapper = createMcpWrapper(harness);

    wrapper.startChild();
    harness.children[0].exit(1, null);
    assert.equal(harness.timers[0].delay, 1000);
    harness.runNextTimer();

    harness.children[1].exit(1, null);
    assert.equal(harness.timers[0].delay, 5000);
    harness.runNextTimer();

    harness.advance(60_000);
    harness.children[2].exit(1, null);
    assert.equal(harness.timers[0].delay, 1000);
  });

  test('AC-WRAPPER-001-d: mtime intentional restart does not increase backoff', async () => {
    const { createMcpWrapper } = await loadWrapper();
    const harness = createHarness();
    const wrapper = createMcpWrapper(harness);

    wrapper.startChild();
    harness.children[0].exit(1, null);
    assert.equal(harness.timers[0].delay, 1000);
    harness.runNextTimer();

    wrapper.restartChild();
    harness.children[1].exit(null, 'SIGTERM');
    assert.equal(harness.restartAnnouncements.at(-1).reason, 'source-mtime-change');
    assert.equal(harness.restartAnnouncements.at(-1).delayMs, 1000);
    assert.equal(harness.timers[0].delay, 1000);
    harness.runNextTimer();

    harness.children[2].exit(1, null);
    assert.equal(harness.timers[0].delay, 5000);
  });

  test('AC-WRAPPER-001-e: only wrapper-owned SIGTERM is intentional', async () => {
    const { createMcpWrapper } = await loadWrapper();
    const harness = createHarness();
    const wrapper = createMcpWrapper(harness);

    wrapper.startChild();
    wrapper.restartChild();
    harness.children[0].exit(null, 'SIGTERM');
    assert.equal(harness.timers[0].delay, 1000);
    harness.runNextTimer();

    harness.children[1].exit(null, 'SIGKILL');
    assert.equal(harness.timers[0].delay, 1000);
    harness.runNextTimer();

    harness.children[2].exit(2, null);
    assert.equal(harness.timers[0].delay, 5000);
  });
});

