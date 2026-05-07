import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getCostSummary, getTokenStatus } from '../lib/ccusage-adapter.mjs';

function writeClaudeUsageFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ccusage-contract-'));
  const projectDir = join(root, 'projects', 'D--workspace-ai-research-xiheAi');
  mkdirSync(projectDir, { recursive: true });
  const now = new Date();
  const sessionPath = join(projectDir, 'session-alpha.jsonl');
  const rows = [
    usageRow({
      timestamp: now.toISOString(),
      sessionId: 'session-alpha',
      requestId: 'req-1',
      messageId: 'msg-1',
      model: 'claude-sonnet-4-5-20250929',
      input: 1000,
      output: 200,
      costUSD: 0.01,
    }),
    usageRow({
      timestamp: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: 'session-alpha',
      requestId: 'req-2',
      messageId: 'msg-2',
      model: 'claude-opus-4-1-20250805',
      input: 2000,
      output: 400,
      costUSD: 0.08,
    }),
  ];
  writeFileSync(sessionPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return root;
}

function usageRow({ timestamp, sessionId, requestId, messageId, model, input, output, costUSD }) {
  return {
    cwd: 'D:/workspace/ai/research/xiheAi',
    sessionId,
    timestamp,
    version: '1.0.0',
    requestId,
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    costUSD,
  };
}

test('getCostSummary: calls real ccusage loaders and returns model-grouped totals', async () => {
  const root = writeClaudeUsageFixture();
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const summary = await getCostSummary({ window: '30d', group_by: 'model', offline: true });

    assert.equal(summary.ok, true);
    assert.equal(summary.source, 'ccusage');
    assert.equal(summary.window, '30d');
    assert.equal(summary.group_by, 'model');
    assert.equal(summary.totals.total_tokens, 3600);
    assert.equal(summary.totals.total_cost_usd, 0.09);
    assert.equal(summary.groups.length, 2);
    assert.deepEqual(
      summary.groups.map((group) => group.key).sort(),
      ['claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929'],
    );
  } finally {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('getTokenStatus: normalizes active 5h block quota fields', async () => {
  const resetsAt = new Date(Date.now() + 60 * 60 * 1000);
  const status = await getTokenStatus(
    { token_limit: 10_000 },
    {
      loadSessionBlockData: async () => [
        {
          id: 'block-active',
          isActive: true,
          startTime: new Date(Date.now() - 60 * 60 * 1000),
          endTime: resetsAt,
          tokenCounts: {
            inputTokens: 6000,
            outputTokens: 2000,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 500,
          },
          costUSD: 1.23,
          models: ['claude-opus-4-1-20250805'],
        },
      ],
    },
  );

  assert.equal(status.ok, true);
  assert.equal(status.block_id, 'block-active');
  assert.equal(status.used_pct, 90);
  assert.equal(status.remaining_pct, 10);
  assert.equal(status.total_tokens, 9000);
  assert.equal(status.resets_at, resetsAt.toISOString());
});

test('getCostSummary: daily today uses local calendar date for ccusage since', async () => {
  const calls = [];
  const summary = await getCostSummary(
    { window: 'today', group_by: 'none', granularity: 'day' },
    {
      now: new Date(2026, 4, 7, 12, 0, 0),
      loadDailyUsageData: async (options) => {
        calls.push(options);
        return [];
      },
    },
  );

  assert.equal(summary.ok, true);
  assert.equal(calls[0].since, '20260507');
});

test('getCostSummary: hourly buckets aggregate transcript rows by IPC name with cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccusage-hourly-'));
  const projectDir = join(root, 'projects', 'D--workspace-ai-research-xiheAi');
  mkdirSync(projectDir, { recursive: true });
  const cacheDbPath = join(root, 'hourly-cache.db');
  const now = new Date(2026, 4, 7, 12, 0, 0);
  const sessionAlpha = join(projectDir, 'session-alpha.jsonl');
  const sessionBeta = join(projectDir, 'session-beta.jsonl');
  writeFileSync(sessionAlpha, [
    JSON.stringify(usageRow({
      timestamp: new Date(2026, 4, 7, 0, 15, 0).toISOString(),
      sessionId: 'session-alpha',
      requestId: 'req-a1',
      messageId: 'msg-a1',
      model: 'claude-opus-4-7',
      input: 10,
      output: 5,
      costUSD: 0.01,
    })),
    JSON.stringify(usageRow({
      timestamp: new Date(2026, 4, 7, 0, 16, 0).toISOString(),
      sessionId: 'session-alpha',
      requestId: 'req-a1',
      messageId: 'msg-a1',
      model: 'claude-opus-4-7',
      input: 10,
      output: 5,
      costUSD: 0.01,
    })),
    JSON.stringify(usageRow({
      timestamp: new Date(2026, 4, 7, 1, 5, 0).toISOString(),
      sessionId: 'session-alpha',
      requestId: 'req-a2',
      messageId: 'msg-a2',
      model: 'claude-opus-4-7',
      input: 20,
      output: 10,
      costUSD: 0.02,
    })),
  ].join('\n') + '\n');
  writeFileSync(sessionBeta, `${JSON.stringify(usageRow({
    timestamp: new Date(2026, 4, 7, 23, 55, 0).toISOString(),
    sessionId: 'session-beta',
    requestId: 'req-b1',
    messageId: 'msg-b1',
    model: 'claude-opus-4-7',
    input: 30,
    output: 15,
    costUSD: 0.03,
  }))}\n`);

  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const summary = await getCostSummary(
      { window: 'today', group_by: 'ipc_name', granularity: 'hour' },
      {
        now,
        cacheDbPath,
        sessionNameMap: new Map([
          ['session-alpha', 'alpha-ipc'],
          ['session-beta', 'beta-ipc'],
        ]),
        costForEntry: async (data) => data.costUSD ?? 0,
      },
    );

    assert.equal(summary.ok, true);
    assert.equal(summary.granularity, 'hour');
    assert.equal(summary.bucket_count, 24);
    assert.equal(summary.cache.hit, false);
    assert.equal(summary.cache.files_scanned, 2);
    assert.equal(summary.totals.total_cost_usd, 0.06);
    assert.equal(summary.totals.total_tokens, 90);
    assert.equal(summary.message_count, 3);
    assert.deepEqual(summary.groups.map((group) => group.key).sort(), ['alpha-ipc', 'beta-ipc']);

    const alpha = summary.groups.find((group) => group.key === 'alpha-ipc');
    const beta = summary.groups.find((group) => group.key === 'beta-ipc');
    assert.equal(alpha.total_cost_usd, 0.03);
    assert.equal(alpha.total_tokens, 45);
    assert.equal(alpha.message_count, 2);
    assert.equal(alpha.buckets[0].total_cost_usd, 0.01);
    assert.equal(alpha.buckets[1].total_cost_usd, 0.02);
    assert.equal(beta.buckets[23].total_cost_usd, 0.03);
    assert.equal(
      roundForAssert(summary.buckets.reduce((sum, bucket) => sum + bucket.total_cost_usd, 0)),
      summary.totals.total_cost_usd,
    );

    const cached = await getCostSummary(
      { window: 'today', group_by: 'ipc_name', granularity: 'hour' },
      {
        now,
        cacheDbPath,
        sessionNameMap: new Map([
          ['session-alpha', 'alpha-ipc'],
          ['session-beta', 'beta-ipc'],
        ]),
        costForEntry: async (data) => data.costUSD ?? 0,
      },
    );
    assert.equal(cached.cache.hit, true);
    assert.equal(cached.cache.files_scanned, 0);
    assert.equal(cached.totals.total_cost_usd, summary.totals.total_cost_usd);
  } finally {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('adapter contract: fake upstream breaking change fails loud', async () => {
  await assert.rejects(
    getCostSummary(
      { window: 'today', group_by: 'model', granularity: 'day' },
      {
        loadDailyUsageData: async () => [
          {
            date: '2026-04-27',
            total_cost: 1,
            tokens_total: 123,
          },
        ],
      },
    ),
    /ccusage contract/i,
  );
});

function roundForAssert(value) {
  return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
}
