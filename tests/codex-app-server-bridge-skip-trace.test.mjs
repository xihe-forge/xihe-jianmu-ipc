import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let importSeq = 0;

function sanitizeTraceName(name) {
  return name.replace(/[^\w.-]/g, '_');
}

async function importMcpServerWithBridgeSkipHook(testName, { fallback = '1' } = {}) {
  const originalName = process.env.IPC_NAME;
  const originalRuntime = process.env.IPC_RUNTIME;
  const originalFallback = process.env.IPC_CODEX_APP_SERVER_FALLBACK;
  const ipcName = `codex-app-server-bridge-skip-trace-${process.pid}-${testName}`;
  const sourcePath = resolve('mcp-server.mjs');
  const tempPath = resolve(
    `.codex-app-server-bridge-skip-trace-test-${process.pid}-${Date.now()}-${importSeq++}.mjs`,
  );
  const tracePath = resolve('data', `mcp-trace-${sanitizeTraceName(ipcName)}.log`);
  const source = await readFile(sourcePath, 'utf8');
  const testHook = `
export const __codexAppServerBridgeSkipTraceTest = {
  setResolveRuntime(fn) {
    resolveRuntime = fn;
  },
  setMcpClientInfo(value) {
    mcpClientInfo = value;
  },
  setLocalAppServerState({ client = null, threadId = null, pid = null } = {}) {
    localAppServerClient = client;
    localAppServerThreadId = threadId;
    localAppServerPid = pid;
  },
  ensureLocalCodexAppServer,
};
`;

  await rm(tracePath, { force: true });
  process.env.IPC_NAME = ipcName;
  process.env.IPC_RUNTIME = 'codex';
  if (fallback === null) {
    delete process.env.IPC_CODEX_APP_SERVER_FALLBACK;
  } else {
    process.env.IPC_CODEX_APP_SERVER_FALLBACK = fallback;
  }
  await writeFile(tempPath, `${source}\n${testHook}`, 'utf8');
  const mod = await import(`${pathToFileURL(tempPath).href}?case=${importSeq}`);

  return {
    api: mod.__codexAppServerBridgeSkipTraceTest,
    ipcName,
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
      if (originalFallback === undefined) {
        delete process.env.IPC_CODEX_APP_SERVER_FALLBACK;
      } else {
        process.env.IPC_CODEX_APP_SERVER_FALLBACK = originalFallback;
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

test('codex app-server bridge skip emits trace when runtime is not codex', async () => {
  const harness = await importMcpServerWithBridgeSkipHook('not-codex-runtime');
  try {
    harness.api.setResolveRuntime(() => 'unknown');
    harness.api.setMcpClientInfo({ name: 'plain-client' });

    const bridge = await harness.api.ensureLocalCodexAppServer();

    assert.equal(bridge, null);

    const events = await readTraceEvents(harness.tracePath);
    const skipEvents = events.filter(
      (event) => event.event === 'codex_app_server_bridge_skip',
    );
    assert.equal(skipEvents.length, 1);
    assert.equal(skipEvents[0].reason, 'not-codex-runtime');
    assert.equal(skipEvents[0].resolved_runtime, 'unknown');
    assert.equal(skipEvents[0].ipc_name, harness.ipcName);
    assert.deepEqual(skipEvents[0].mcp_client_info, { name: 'plain-client' });
  } finally {
    await harness.cleanup();
  }
});

test('codex app-server bridge is disabled by default when PTY bridge is missing', async () => {
  const harness = await importMcpServerWithBridgeSkipHook('fallback-disabled', {
    fallback: null,
  });
  try {
    harness.api.setResolveRuntime(() => 'codex');

    const bridge = await harness.api.ensureLocalCodexAppServer();

    assert.equal(bridge, null);
    const events = await readTraceEvents(harness.tracePath);
    const skipEvents = events.filter(
      (event) => event.event === 'codex_app_server_bridge_skip',
    );
    assert.equal(skipEvents.length, 1);
    assert.equal(skipEvents[0].reason, 'pty-bridge-missing-fallback-disabled');
  } finally {
    await harness.cleanup();
  }
});

test('codex app-server bridge skip emits trace when already initialized', async () => {
  const harness = await importMcpServerWithBridgeSkipHook('already-initialized');
  try {
    const client = {};
    harness.api.setResolveRuntime(() => 'codex');
    harness.api.setLocalAppServerState({
      client,
      threadId: 'existing-thread-id',
      pid: 45678,
    });

    const bridge = await harness.api.ensureLocalCodexAppServer();

    assert.equal(bridge.client, client);
    assert.equal(bridge.threadId, 'existing-thread-id');
    assert.equal(bridge.pid, 45678);

    const events = await readTraceEvents(harness.tracePath);
    const skipEvents = events.filter(
      (event) => event.event === 'codex_app_server_bridge_skip',
    );
    assert.equal(skipEvents.length, 1);
    assert.equal(skipEvents[0].reason, 'already-initialized');
    assert.equal(skipEvents[0].thread_id, 'existing-thread-id');
  } finally {
    await harness.cleanup();
  }
});
