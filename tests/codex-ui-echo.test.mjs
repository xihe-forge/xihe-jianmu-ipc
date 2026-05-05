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
  const ipcName = `codex-ui-echo-${process.pid}-${testName}`;
  const sourcePath = resolve('mcp-server.mjs');
  const tempPath = resolve(
    `.codex-ui-echo-test-${process.pid}-${Date.now()}-${importSeq++}.mjs`,
  );
  const tracePath = resolve('data', `mcp-trace-${sanitizeTraceName(ipcName)}.log`);
  const source = await readFile(sourcePath, 'utf8');
  const testHook = `
export const __codexUiEchoTest = {
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
    api: mod.__codexUiEchoTest,
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

function createMockAppServerClient({ statuses = [{ activeTurnId: null }] } = {}) {
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
      return { turnId: 'wake-turn-1' };
    },
  };
  return { client, calls };
}

const sampleMessage = {
  id: 'msg-ui-echo',
  from: 'jianmu-pm',
  ts: '2026-04-30T10:25:00.123Z',
  content: 'codex UI echo marker',
};

function firstInjectedText(calls) {
  const injectCalls = calls.filter((call) => call.method === 'threadInjectItems');
  assert.equal(injectCalls.length, 1);
  return injectCalls[0].items[0].content[0].text;
}

test('idle codex IPC inject content carries UI-visible ipc line', async () => {
  const harness = await importMcpServerWithLocalAppServerHook('idle');
  try {
    const { client, calls } = createMockAppServerClient({
      statuses: [{ activeTurnId: null }, { activeTurnId: null }],
    });
    harness.api.setLocalAppServer(client, 'thread-idle');

    const pushed = await harness.api.pushLocalCodexInboundViaAppServer(sampleMessage);

    assert.equal(pushed, true);
    const injectedText = firstInjectedText(calls);
    assert.match(
      injectedText,
      /^← ipc: \[2026-04-30 10:25:00\+00:00 from: jianmu-pm\] codex UI echo marker/,
    );
    assert.match(injectedText, /\n\n\[IPC-INBOUND from jianmu-pm\] codex UI echo marker$/);

    const turnStartCalls = calls.filter((call) => call.method === 'turnStart');
    assert.equal(turnStartCalls.length, 1);
    assert.equal(turnStartCalls[0].threadId, 'thread-idle');
    assert.match(turnStartCalls[0].input, /← ipc:/);
    assert.match(turnStartCalls[0].input, /回显到 reply 第一行/);
  } finally {
    await harness.cleanup();
  }
});

test('active turn codex IPC turnSteer content carries ipc line with echo instruction', async () => {
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
    assert.equal(turnSteerCalls[0].threadId, 'thread-active');
    assert.equal(turnSteerCalls[0].turnId, 'active-turn-1');
    assert.match(
      turnSteerCalls[0].input,
      /^← ipc: \[2026-04-30 10:25:00\+00:00 from: jianmu-pm\] codex UI echo marker/,
    );
    assert.match(turnSteerCalls[0].input, /\[IPC-INBOUND from jianmu-pm\]/);
    assert.match(turnSteerCalls[0].input, /完整原样回显到下条 reply 顶部/);
  } finally {
    await harness.cleanup();
  }
});
