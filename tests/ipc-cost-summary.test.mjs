import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpTools } from '../lib/mcp-tools.mjs';

function createHarness(impl = {}) {
  const ctx = {
    getSessionName: () => 'harness',
    setSessionName: () => {},
    getHubHost: () => '127.0.0.1',
    setHubHost: () => {},
    getHubPort: () => 8765,
    setHubPort: () => {},
    getWs: () => null,
    disconnectWs: () => {},
    reconnect: () => {},
    getPendingOutgoingCount: () => 0,
    wsSend: () => false,
    httpGet: async () => ({ sessions: [] }),
    httpPost: async () => ({ ok: true }),
    httpPatch: async () => ({ ok: true }),
    spawnSession: async () => ({ status: 'spawned' }),
    stderrLog: () => {},
    getCostSummary: impl.getCostSummary,
    getTokenStatus: impl.getTokenStatus,
  };
  return createMcpTools(ctx);
}

function parseToolJson(result) {
  return JSON.parse(result.content[0].text);
}

test('listTools: exposes ipc_cost_summary and ipc_token_status schemas', () => {
  const tools = createHarness();
  const listed = tools.listTools().tools;

  assert.ok(listed.find((tool) => tool.name === 'ipc_cost_summary'));
  assert.ok(listed.find((tool) => tool.name === 'ipc_token_status'));
  assert.deepEqual(
    listed.find((tool) => tool.name === 'ipc_cost_summary').inputSchema.properties.window.enum,
    ['today', '7d', '30d', 'all'],
  );
  assert.deepEqual(
    listed.find((tool) => tool.name === 'ipc_cost_summary').inputSchema.properties.group_by.enum,
    ['none', 'ipc_name', 'model'],
  );
  assert.deepEqual(
    listed.find((tool) => tool.name === 'ipc_cost_summary').inputSchema.properties.granularity.enum,
    ['hour', 'day'],
  );
});

test('ipc_cost_summary: delegates to adapter with normalized args', async () => {
  const calls = [];
  const tools = createHarness({
    getCostSummary: async (args) => {
      calls.push(args);
      return {
        ok: true,
        window: args.window,
        group_by: args.group_by,
        granularity: args.granularity,
        totals: { total_tokens: 42, total_cost_usd: 0.12 },
        groups: [],
      };
    },
  });

  const result = await tools.handleToolCall('ipc_cost_summary', {
    window: '7d',
    group_by: 'model',
    granularity: 'hour',
  });

  assert.deepEqual(calls, [{ window: '7d', group_by: 'model', granularity: 'hour' }]);
  assert.deepEqual(parseToolJson(result), {
    ok: true,
    window: '7d',
    group_by: 'model',
    granularity: 'hour',
    totals: { total_tokens: 42, total_cost_usd: 0.12 },
    groups: [],
  });
});

test('ipc_cost_summary: rejects invalid windows before adapter call', async () => {
  let called = false;
  const tools = createHarness({
    getCostSummary: async () => {
      called = true;
      return { ok: true };
    },
  });

  const result = await tools.handleToolCall('ipc_cost_summary', { window: 'yesterday' });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(parseToolJson(result).error, /window/i);
});

test('ipc_cost_summary: rejects invalid granularity before adapter call', async () => {
  let called = false;
  const tools = createHarness({
    getCostSummary: async () => {
      called = true;
      return { ok: true };
    },
  });

  const result = await tools.handleToolCall('ipc_cost_summary', { granularity: 'minute' });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(parseToolJson(result).error, /granularity/i);
});

test('ipc_token_status: delegates to adapter and returns 5h quota status', async () => {
  const tools = createHarness({
    getTokenStatus: async () => ({
      ok: true,
      remaining_pct: 18,
      used_pct: 82,
      total_tokens: 123456,
      resets_at: '2026-04-27T22:00:00.000Z',
    }),
  });

  const result = await tools.handleToolCall('ipc_token_status', {});

  assert.deepEqual(parseToolJson(result), {
    ok: true,
    remaining_pct: 18,
    used_pct: 82,
    total_tokens: 123456,
    resets_at: '2026-04-27T22:00:00.000Z',
  });
});
