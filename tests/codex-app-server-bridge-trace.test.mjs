import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let importSeq = 0;

function sanitizeTraceName(name) {
  return name.replace(/[^\w.-]/g, '_');
}

async function importMcpServerWithBridgeHook(testName) {
  const originalName = process.env.IPC_NAME;
  const originalRuntime = process.env.IPC_RUNTIME;
  const ipcName = `codex-app-server-bridge-trace-${process.pid}-${testName}`;
  const sourcePath = resolve('mcp-server.mjs');
  const tempPath = resolve(
    `.codex-app-server-bridge-trace-test-${process.pid}-${Date.now()}-${importSeq++}.mjs`,
  );
  const tracePath = resolve('data', `mcp-trace-${sanitizeTraceName(ipcName)}.log`);
  const source = await readFile(sourcePath, 'utf8');
  const testHook = `
export const __codexAppServerBridgeTraceTest = {
  setStartCodexAppServerBridge(fn) {
    startCodexAppServerBridge = fn;
  },
  ensureLocalCodexAppServer,
};
`;

  await rm(tracePath, { force: true });
  process.env.IPC_NAME = ipcName;
  process.env.IPC_RUNTIME = 'codex';
  await writeFile(tempPath, `${source}\n${testHook}`, 'utf8');
  const mod = await import(`${pathToFileURL(tempPath).href}?case=${importSeq}`);

  return {
    api: mod.__codexAppServerBridgeTraceTest,
    tracePath,
    async cleanup() {
      if (originalName === undefined) {
        delete process.env.IPC_NAME;
      } else {
        process.env.IPC_NAME = originalName;
      }
      if (originalRuntime === undefined) {
        delete process.env.IPC_RUNTIME;
      } else {
        process.env.IPC_RUNTIME = originalRuntime;
      }
      await rm(tempPath, { force: true });
      await rm(tracePath, { force: true });
    },
  };
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

test('codex app-server bridge ready emits mcp trace', async () => {
  const harness = await importMcpServerWithBridgeHook('ready');
  try {
    const client = {};
    harness.api.setStartCodexAppServerBridge(async () => ({
      client,
      threadId: 'test-thread-id',
      pid: 12345,
    }));

    const bridge = await harness.api.ensureLocalCodexAppServer();

    assert.equal(bridge.client, client);
    assert.equal(bridge.threadId, 'test-thread-id');
    assert.equal(bridge.pid, 12345);

    const events = await readTraceEvents(harness.tracePath);
    const readyEvents = events.filter(
      (event) => event.event === 'codex_app_server_bridge_ready',
    );
    assert.equal(readyEvents.length, 1);
    assert.equal(readyEvents[0].thread_id, 'test-thread-id');
    assert.equal(readyEvents[0].app_server_pid, 12345);
  } finally {
    await harness.cleanup();
  }
});

test('codex app-server bridge unavailable emits error mcp trace', async () => {
  const harness = await importMcpServerWithBridgeHook('unavailable');
  try {
    harness.api.setStartCodexAppServerBridge(async () => {
      throw new Error('codex spawn failed: ENOENT');
    });

    const bridge = await harness.api.ensureLocalCodexAppServer();

    assert.equal(bridge, null);

    const events = await readTraceEvents(harness.tracePath);
    const unavailableEvents = events.filter(
      (event) => event.event === 'codex_app_server_bridge_unavailable',
    );
    assert.equal(unavailableEvents.length, 1);
    assert.match(unavailableEvents[0].error_message, /codex spawn failed: ENOENT/);
    assert.equal(unavailableEvents[0].error_name, 'Error');
    assert.match(unavailableEvents[0].error_stack, /codex spawn failed: ENOENT/);
  } finally {
    await harness.cleanup();
  }
});
