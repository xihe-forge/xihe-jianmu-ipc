import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServerClient } from '../../lib/codex-app-server-client.mjs';
import { createThreadKeepalive } from '../../lib/codex-thread-keepalive.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAppServerEnv(env = process.env) {
  return {
    ...env,
    RUST_LOG: env.RUST_LOG || 'warn',
    LOG_FORMAT: env.LOG_FORMAT || 'json',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

test(
  'real codex app-server thread stays alive across three keepalive pings',
  { timeout: 60_000 },
  async () => {
    const client = createAppServerClient({
      cwd: process.cwd(),
      env: buildAppServerEnv(),
      requestTimeoutMs: 60_000,
      trace: () => {},
    });
    let keepalive = null;
    let pingCount = 0;

    try {
      client.on('stderr', () => {});
      await client.initialize({
        clientInfo: { name: 'xihe-ipc-keepalive-test', version: '0.5.0' },
      });
      const { threadId } = await client.threadStart({
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      });

      assert.equal(typeof client.threadRead, 'function');
      assert.ok(threadId);

      const countedClient = {
        ...client,
        threadRead: async (id) => {
          pingCount += 1;
          return await client.threadRead(id);
        },
        threadStatus: (id) => client.threadStatus(id),
        on: (eventName, handler) => client.on(eventName, handler),
        off: (eventName, handler) => client.off(eventName, handler),
      };

      keepalive = createThreadKeepalive({
        client: countedClient,
        threadId,
        sessionName: 'integration-codex-keepalive',
        intervalMs: 10_000,
      });
      keepalive.start();

      const startedAt = Date.now();
      await delay(31_500);
      const elapsedMs = Date.now() - startedAt;
      const read = await client.threadRead(threadId);

      assert.ok(pingCount >= 3, `expected >=3 keepalive pings, got ${pingCount}`);
      assert.notEqual(read.thread?.status?.type, 'closed');
      assert.ok(elapsedMs < 45_000, `30s timeline exceeded: ${elapsedMs}ms`);
    } finally {
      keepalive?.stop();
      await client.close();
    }
  },
);
