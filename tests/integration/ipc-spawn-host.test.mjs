import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpTools } from '../../lib/mcp-tools.mjs';

function createHarness() {
  const calls = {
    spawnSession: [],
  };

  const tools = createMcpTools({
    getSessionName: () => 'alpha',
    setSessionName: () => {},
    getHubHost: () => '127.0.0.1',
    setHubHost: () => {},
    getHubPort: () => 8765,
    setHubPort: () => {},
    getWs: () => ({ readyState: 1 }),
    disconnectWs: () => {},
    reconnect: () => {},
    getPendingOutgoingCount: () => 0,
    wsSend: () => true,
    httpGet: async () => [],
    httpPost: async () => ({ accepted: true }),
    httpPatch: async () => ({ ok: true }),
    spawnSession: async (params) => {
      calls.spawnSession.push(params);
      return { spawned: false, host: params.host ?? 'legacy' };
    },
    stderrLog: () => {},
  });

  return { tools, calls };
}

test('ipc_spawn host integration: 显式 host=external 时保留 host 参数', async () => {
  const { tools, calls } = createHarness();

  await tools.handleToolCall('ipc_spawn', {
    name: 'harness',
    task: 'resume from handover',
    host: 'external',
  });

  assert.equal(calls.spawnSession.length, 1);
  assert.equal(calls.spawnSession[0].host, 'external');
});

test('ipc_spawn host integration: host=wt 时透传给 spawnSession', async () => {
  const { tools, calls } = createHarness();

  await tools.handleToolCall('ipc_spawn', {
    name: 'harness',
    task: 'resume from handover',
    host: 'wt',
  });

  assert.equal(calls.spawnSession.length, 1);
  assert.equal(calls.spawnSession[0].host, 'wt');
});
