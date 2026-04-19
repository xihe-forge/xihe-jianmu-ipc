import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpTools } from '../lib/mcp-tools.mjs';

function createHarness(options = {}) {
  const calls = {
    recallObservations: [],
  };

  const tools = createMcpTools({
    getSessionName: () => 'alpha',
    setSessionName: () => {},
    getHubHost: () => '127.0.0.1',
    setHubHost: () => {},
    getHubPort: () => 8765,
    setHubPort: () => {},
    getWs: () => null,
    disconnectWs: () => {},
    reconnect: () => {},
    getPendingOutgoingCount: () => 0,
    wsSend: () => {},
    httpGet: async () => ({}),
    httpPost: async () => ({}),
    httpPatch: async () => ({}),
    spawnSession: async () => ({}),
    recallObservations: (input) => {
      calls.recallObservations.push(input);
      if (typeof options.recallObservations === 'function') {
        return options.recallObservations(input);
      }
      return { ok: true, project: input.project, count: 0, observations: [] };
    },
  });

  return { tools, calls };
}

function getJson(result) {
  return JSON.parse(result.content[0].text);
}

test('ipc_recall: 缺少 project 返回 isError', async () => {
  const { tools } = createHarness();

  const result = await tools.handleToolCall('ipc_recall', {});

  assert.equal(result.isError, true);
  assert.deepEqual(getJson(result), {
    ok: false,
    error: 'project is required',
  });
});

test('ipc_recall: 透传过滤参数给 observation-query 层，并对 limit 做 500 上限裁剪', async () => {
  const { tools, calls } = createHarness({
    recallObservations: (input) => ({
      ok: true,
      project: input.project,
      count: 1,
      observations: [{ id: 7 }],
    }),
  });

  const result = await tools.handleToolCall('ipc_recall', {
    project: '*',
    since: 3_600_000,
    limit: 999,
    ipc_name: 'houtu_builder',
    tool_name: 'Bash',
    tags: ['dev.to', 'ship'],
    keyword: 'unpublish',
  });

  assert.deepEqual(calls.recallObservations, [
    {
      project: '*',
      since: 3_600_000,
      limit: 500,
      ipc_name: 'houtu_builder',
      tool_name: 'Bash',
      tags: ['dev.to', 'ship'],
      keyword: 'unpublish',
    },
  ]);
  assert.deepEqual(getJson(result), {
    ok: true,
    project: '*',
    count: 1,
    observations: [{ id: 7 }],
  });
});

test('ipc_recall: observation-query 抛错时返回 JSON error result', async () => {
  const { tools } = createHarness({
    recallObservations: () => {
      throw new Error('sqlite unavailable');
    },
  });

  const result = await tools.handleToolCall('ipc_recall', {
    project: '_portfolio',
  });

  assert.equal(result.isError, true);
  assert.deepEqual(getJson(result), {
    ok: false,
    error: 'sqlite unavailable',
    project: '_portfolio',
  });
});
