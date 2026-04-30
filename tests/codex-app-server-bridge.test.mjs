import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let importSeq = 0;

async function importMcpServerWithBridgeRetryHook(testName) {
  const originalName = process.env.IPC_NAME;
  const originalRuntime = process.env.IPC_RUNTIME;
  const ipcName = `codex-app-server-bridge-retry-${process.pid}-${testName}`;
  const sourcePath = resolve('mcp-server.mjs');
  const tempPath = resolve(
    `.codex-app-server-bridge-retry-test-${process.pid}-${Date.now()}-${importSeq++}.mjs`,
  );
  const source = await readFile(sourcePath, 'utf8');
  const testHook = `
export const __codexAppServerBridgeRetryTest = {
  setResolveRuntime(fn) {
    resolveRuntime = fn;
  },
  setStartCodexAppServerBridge(fn) {
    startCodexAppServerBridge = fn;
  },
  setLocalAppServerState({ client = null, threadId = null, pid = null } = {}) {
    localAppServerClient = client;
    localAppServerThreadId = threadId;
    localAppServerPid = pid;
  },
  getLocalAppServerState() {
    return {
      client: localAppServerClient,
      threadId: localAppServerThreadId,
      pid: localAppServerPid,
    };
  },
  createCurrentRegisterMessage,
  ensureLocalCodexAppServer,
};
`;

  process.env.IPC_NAME = ipcName;
  delete process.env.IPC_RUNTIME;
  await writeFile(tempPath, `${source}\n${testHook}`, 'utf8');
  const mod = await import(`${pathToFileURL(tempPath).href}?case=${importSeq}`);

  return {
    api: mod.__codexAppServerBridgeRetryTest,
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
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail('condition was not met before timeout');
}

test('codex app-server bridge retries when register resolves codex after early unknown runtime', async () => {
  const harness = await importMcpServerWithBridgeRetryHook('register-runtime-ready');
  try {
    harness.api.setResolveRuntime(() => 'unknown');
    assert.equal(await harness.api.ensureLocalCodexAppServer(), null);

    let bridgeStarts = 0;
    const client = {};
    harness.api.setStartCodexAppServerBridge(async () => {
      bridgeStarts += 1;
      return { client, threadId: 'retry-thread-id', pid: 34567 };
    });
    harness.api.setResolveRuntime(() => 'codex');

    const registerMessage = harness.api.createCurrentRegisterMessage();

    assert.equal(registerMessage.runtime, 'codex');
    await waitFor(() => bridgeStarts === 1);
    assert.deepEqual(harness.api.getLocalAppServerState(), {
      client,
      threadId: 'retry-thread-id',
      pid: 34567,
    });
    assert.equal(harness.api.createCurrentRegisterMessage().appServerThreadId, 'retry-thread-id');
  } finally {
    await harness.cleanup();
  }
});
