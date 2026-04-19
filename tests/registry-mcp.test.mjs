import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpTools } from '../lib/mcp-tools.mjs';

function createHarness(options = {}) {
  const calls = {
    httpPost: [],
  };

  const tools = createMcpTools({
    getSessionName: () => 'jianmu-pm',
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
    httpPost: async (url, body) => {
      calls.httpPost.push({ url, body });
      if (typeof options.httpPost === 'function') {
        return options.httpPost(url, body);
      }
      return { ok: true };
    },
    httpPatch: async () => ({}),
    spawnSession: async () => ({}),
  });

  return { tools, calls };
}

function getJson(result) {
  return JSON.parse(result.content[0].text);
}

test('ipc_register_session: 通过 Hub /registry/register 包装并带上 requested_by', async () => {
  const { tools, calls } = createHarness({
    httpPost: async () => ({
      ok: true,
      name: 'test-session',
      registered: true,
      action: 'created',
    }),
  });

  const result = await tools.handleToolCall('ipc_register_session', {
    name: 'test-session',
    role: 'worker',
    projects: ['alpha', 'alpha', 'beta'],
    access_scope: 'primary',
    cold_start_strategy: 'single-db-50',
    note: 'demo',
  });

  assert.deepEqual(calls.httpPost, [
    {
      url: 'http://127.0.0.1:8765/registry/register',
      body: {
        name: 'test-session',
        role: 'worker',
        projects: ['alpha', 'beta'],
        access_scope: 'primary',
        cold_start_strategy: 'single-db-50',
        note: 'demo',
        requested_by: 'jianmu-pm',
      },
    },
  ]);
  assert.deepEqual(getJson(result), {
    ok: true,
    name: 'test-session',
    registered: true,
    action: 'created',
  });
});

test('ipc_update_session: projects 必填为数组，Hub 返回 ok=false 时透传 isError', async () => {
  const { tools, calls } = createHarness({
    httpPost: async () => ({
      ok: false,
      error: 'session not found',
      name: 'missing-session',
    }),
  });

  const result = await tools.handleToolCall('ipc_update_session', {
    name: 'missing-session',
    projects: ['alpha'],
  });

  assert.deepEqual(calls.httpPost, [
    {
      url: 'http://127.0.0.1:8765/registry/update',
      body: {
        name: 'missing-session',
        projects: ['alpha'],
        requested_by: 'jianmu-pm',
      },
    },
  ]);
  assert.equal(result.isError, true);
  assert.deepEqual(getJson(result), {
    ok: false,
    error: 'session not found',
    name: 'missing-session',
  });
});

test('ipc_update_session: 非数组 projects 直接参数报错', async () => {
  const { tools } = createHarness();

  const result = await tools.handleToolCall('ipc_update_session', {
    name: 'worker',
    projects: 'alpha',
  });

  assert.equal(result.isError, true);
  assert.deepEqual(getJson(result), {
    ok: false,
    error: 'projects must be an array of strings',
  });
});

test('ipc_register_session: 未提供的可选字段不会被序列化成 null', async () => {
  const { tools, calls } = createHarness();

  await tools.handleToolCall('ipc_register_session', {
    name: 'minimal-session',
  });

  assert.deepEqual(calls.httpPost, [
    {
      url: 'http://127.0.0.1:8765/registry/register',
      body: {
        name: 'minimal-session',
        requested_by: 'jianmu-pm',
      },
    },
  ]);
});
