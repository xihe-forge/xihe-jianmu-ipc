import { loadDailyUsageData, loadSessionBlockData, loadSessionData } from 'ccusage/data-loader';

const VALID_WINDOWS = new Set(['today', '7d', '30d', 'all']);
const VALID_GROUPS = new Set(['none', 'ipc_name', 'model']);

export async function getCostSummary(args = {}, loader = {}) {
  const window = VALID_WINDOWS.has(args.window) ? args.window : 'today';
  const groupBy = VALID_GROUPS.has(args.group_by) ? args.group_by : 'none';
  const options = { offline: args.offline ?? true, ...windowFilter(window) };
  const loadDaily = loader.loadDailyUsageData ?? loadDailyUsageData;
  const loadSessions = loader.loadSessionData ?? loadSessionData;
  const rows = groupBy === 'ipc_name' ? await loadSessions(options) : await loadDaily(options);
  assertCcusageRows(rows, groupBy);
  const groups = groupBy === 'none' ? [] : groupRows(rows, groupBy);
  return {
    ok: true,
    source: 'ccusage',
    window,
    group_by: groupBy,
    totals: toPublicTotals(sumRows(rows)),
    groups,
    row_count: rows.length,
    generated_at: new Date().toISOString(),
  };
}

export async function getTokenStatus(args = {}, loader = {}) {
  const loadBlocks = loader.loadSessionBlockData ?? loadSessionBlockData;
  const blocks = await loadBlocks({ offline: args.offline ?? true, sessionDurationHours: 5 });
  const block = blocks.find((entry) => entry.isActive) ?? blocks.at(-1) ?? null;
  if (!block) return { ok: true, source: 'ccusage', active: false, remaining_pct: null };
  const totalTokens = blockTokenTotal(block.tokenCounts ?? {});
  const tokenLimit = Number(args.token_limit ?? process.env.CCUSAGE_TOKEN_LIMIT ?? 0);
  const usedPct = tokenLimit > 0 ? Math.min(100, Math.round((totalTokens / tokenLimit) * 100)) : null;
  return {
    ok: true,
    source: 'ccusage',
    active: Boolean(block.isActive),
    block_id: block.id,
    total_tokens: totalTokens,
    total_cost_usd: roundMoney(block.costUSD ?? 0),
    used_pct: usedPct,
    remaining_pct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resets_at: (block.usageLimitResetTime ?? block.endTime)?.toISOString?.() ?? null,
    models: block.models ?? [],
    generated_at: new Date().toISOString(),
  };
}

function windowFilter(window) {
  const now = new Date();
  if (window === 'all') return {};
  const since = new Date(now);
  if (window === 'today') since.setHours(0, 0, 0, 0);
  if (window === '7d') since.setDate(since.getDate() - 6);
  if (window === '30d') since.setDate(since.getDate() - 29);
  return { since: since.toISOString().slice(0, 10).replaceAll('-', '') };
}

function assertCcusageRows(rows, groupBy) {
  if (!Array.isArray(rows)) throw new Error('ccusage contract violation: loader did not return an array');
  for (const row of rows) {
    if (typeof row?.totalCost !== 'number' || typeof row?.inputTokens !== 'number') {
      throw new Error('ccusage contract violation: expected totalCost/inputTokens fields');
    }
    if (groupBy === 'model' && !Array.isArray(row.modelBreakdowns)) {
      throw new Error('ccusage contract violation: expected modelBreakdowns array');
    }
  }
}

function groupRows(rows, groupBy) {
  const grouped = new Map();
  if (groupBy === 'model') {
    for (const row of rows) for (const model of row.modelBreakdowns) add(grouped, model.modelName, model);
  } else {
    for (const row of rows) add(grouped, row.projectPath ?? row.project ?? 'unknown', row);
  }
  return [...grouped.entries()].map(([key, totals]) => ({ key, ...toPublicTotals(totals) }));
}

function add(grouped, key, row) {
  grouped.set(key, sumRows([grouped.get(key), row].filter(Boolean)));
}

function sumRows(rows) {
  return rows.reduce((total, row) => ({
    inputTokens: total.inputTokens + (row.inputTokens ?? 0),
    outputTokens: total.outputTokens + (row.outputTokens ?? 0),
    cacheCreationTokens: total.cacheCreationTokens + (row.cacheCreationTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (row.cacheReadTokens ?? 0),
    totalCost: total.totalCost + (row.totalCost ?? row.cost ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0 });
}

function toPublicTotals(row) {
  return {
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_creation_tokens: row.cacheCreationTokens,
    cache_read_tokens: row.cacheReadTokens,
    total_tokens: row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
    total_cost_usd: roundMoney(row.totalCost),
  };
}

function blockTokenTotal(tokens) {
  return (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) +
    (tokens.cacheCreationInputTokens ?? tokens.cacheCreationTokens ?? 0) +
    (tokens.cacheReadInputTokens ?? tokens.cacheReadTokens ?? 0);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
}
