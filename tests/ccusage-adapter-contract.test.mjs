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

test('adapter contract: fake upstream breaking change fails loud', async () => {
  await assert.rejects(
    getCostSummary(
      { window: 'today', group_by: 'model' },
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
