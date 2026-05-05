import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let importSeq = 0;

function sanitizeTraceName(name) {
  return name.replace(/[^\w.-]/g, '_');
}

async function importMcpServerWithLocalAppServerHook(testName) {
  const originalName = process.env.IPC_NAME;
  const ipcName = `codex-idle-wake-${process.pid}-${testName}`;
  const sourcePath = resolve('mcp-server.mjs');
  const tempPath = resolve(
    `.codex-idle-wake-test-${process.pid}-${Date.now()}-${importSeq++}.mjs`,
  );
  const tracePath = resolve('data', `mcp-trace-${sanitizeTraceName(ipcName)}.log`);
  const source = await readFile(sourcePath, 'utf8');
  const testHook = `
export const __codexIdleWakeTest = {
  setLocalAppServer(client, threadId) {
    localAppServerClient = client;
    localAppServerThreadId = threadId;
  },
  pushLocalCodexInboundViaAppServer,
};
`;

  await rm(tracePath, { force: true });
  process.env.IPC_NAME = ipcName;
  await writeFile(tempPath, `${source}\n${testHook}`, 'utf8');
  const mod = await import(`${pathToFileURL(tempPath).href}?case=${importSeq}`);

  return {
    api: mod.__codexIdleWakeTest,
    tracePath,
    async cleanup() {
      if (originalName === undefined) {
        delete process.env.IPC_NAME;
      } else {
        process.env.IPC_NAME = originalName;
      }
      await rm(tempPath, { force: true });
      await rm(tracePath, { force: true });
    },
  };
}

function createMockAppServerClient({
  statuses = [{ activeTurnId: null }],
  turnStart = async () => ({ turnId: 'wake-turn-1' }),
} = {}) {
  const calls = [];
  let statusIndex = 0;
  const client = {
    threadStatus(threadId) {
      calls.push({ method: 'threadStatus', threadId });
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return status;
    },
    async turnSteer(threadId, turnId, input) {
      calls.push({ method: 'turnSteer', threadId, turnId, input });
    },
    async threadInjectItems(threadId, items) {
      calls.push({ method: 'threadInjectItems', threadId, items });
    },
    async turnStart(threadId, input, params) {
      calls.push({ method: 'turnStart', threadId, input, params });
      return await turnStart(threadId, input, params);
    },
  };
  return { client, calls };
}

async function readTraceEvents(tracePath) {
  const content = await readFile(tracePath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const sampleMessage = {
  id: 'msg-idle-wake',
  from: 'jianmu-pm',
  ts: '2026-04-30T10:25:00.123Z',
  content: 'idle wake marker',
};

test('idle codex IPC injects history, starts a wake turn, and emits wake trace', async () => {
  const harness = await importMcpServerWithLocalAppServerHook('idle');
  try {
    const { client, calls } = createMockAppServerClient({
      statuses: [{ activeTurnId: null }, { activeTurnId: null }],
    });
    harness.api.setLocalAppServer(client, 'thread-idle');

    const pushed = await harness.api.pushLocalCodexInboundViaAppServer(sampleMessage);

    assert.equal(pushed, true);
    const injectCalls = calls.filter((call) => call.method === 'threadInjectItems');
    assert.equal(injectCalls.length, 1);
    const injectedText = injectCalls[0].items[0].content[0].text;
    assert.match(
      injectedText,
      /^← ipc: \[2026-04-30 10:25:00\+00:00 from: jianmu-pm\] idle wake marker/,
    );
    assert.match(injectedText, /\n\n\[IPC-INBOUND from jianmu-pm\] idle wake marker$/);

    const turnStartCalls = calls.filter((call) => call.method === 'turnStart');
    assert.equal(turnStartCalls.length, 1);
    assert.equal(turnStartCalls[0].threadId, 'thread-idle');
    assert.match(turnStartCalls[0].input, /← ipc:/);
    assert.match(turnStartCalls[0].input, /回显到 reply 第一行/);

    const events = await readTraceEvents(harness.tracePath);
    assert.equal(
      events.some((event) => event.event === 'codex_app_server_idle_wake_ok'),
      true,
    );
  } finally {
    await harness.cleanup();
  }
});

test('active turn codex IPC uses turnSteer without inject or wake turn', async () => {
  const harness = await importMcpServerWithLocalAppServerHook('active');
  try {
    const { client, calls } = createMockAppServerClient({
      statuses: [{ activeTurnId: 'active-turn-1' }],
    });
    harness.api.setLocalAppServer(client, 'thread-active');

    const pushed = await harness.api.pushLocalCodexInboundViaAppServer(sampleMessage);

    assert.equal(pushed, true);
    const turnSteerCalls = calls.filter((call) => call.method === 'turnSteer');
    assert.equal(turnSteerCalls.length, 1);
    assert.match(
      turnSteerCalls[0].input,
      /^← ipc: \[2026-04-30 10:25:00\+00:00 from: jianmu-pm\] idle wake marker/,
    );
    assert.match(turnSteerCalls[0].input, /完整原样回显到下条 reply 顶部/);
    assert.equal(calls.filter((call) => call.method === 'threadInjectItems').length, 0);
    assert.equal(calls.filter((call) => call.method === 'turnStart').length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('idle IPC rechecks thread status after inject and skips wake on race', async () => {
  const harness = await importMcpServerWithLocalAppServerHook('race');
  try {
    const { client, calls } = createMockAppServerClient({
      statuses: [{ activeTurnId: null }, { activeTurnId: 'raced-turn-1' }],
    });
    harness.api.setLocalAppServer(client, 'thread-race');

    const pushed = await harness.api.pushLocalCodexInboundViaAppServer(sampleMessage);

    assert.equal(pushed, true);
    assert.equal(calls.filter((call) => call.method === 'threadInjectItems').length, 1);
    assert.equal(calls.filter((call) => call.method === 'threadStatus').length, 2);
    assert.equal(calls.filter((call) => call.method === 'turnStart').length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('idle wake turnStart failure falls back to injected history success', async () => {
  const harness = await importMcpServerWithLocalAppServerHook('fallback');
  try {
    const { client, calls } = createMockAppServerClient({
      statuses: [{ activeTurnId: null }, { activeTurnId: null }],
      turnStart: async () => {
        throw new Error('wake boom');
      },
    });
    harness.api.setLocalAppServer(client, 'thread-fallback');

    const pushed = await harness.api.pushLocalCodexInboundViaAppServer(sampleMessage);

    assert.equal(pushed, true);
    assert.equal(calls.filter((call) => call.method === 'threadInjectItems').length, 1);
    assert.equal(calls.filter((call) => call.method === 'turnStart').length, 1);

    const events = await readTraceEvents(harness.tracePath);
    assert.equal(
      events.some(
        (event) =>
          event.event === 'codex_app_server_idle_wake_failed' && event.error === 'wake boom',
      ),
      true,
    );
  } finally {
    await harness.cleanup();
  }
});
