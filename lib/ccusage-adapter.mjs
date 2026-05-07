import {
  calculateCostForEntry,
  extractProjectFromPath,
  getClaudePaths,
  globUsageFiles,
  loadDailyUsageData,
  loadSessionBlockData,
  loadSessionData,
} from 'ccusage/data-loader';
import Database from 'better-sqlite3';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VALID_WINDOWS = new Set(['today', '7d', '30d', 'all']);
const VALID_GROUPS = new Set(['none', 'ipc_name', 'model']);
const VALID_GRANULARITIES = new Set(['hour', 'day']);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DEFAULT_HOURLY_CACHE_DB_PATH = join(__dirname, '..', 'data', 'ccusage-hourly-cache.db');
const DEFAULT_IPC_DB_PATH = join(__dirname, '..', 'data', 'messages.db');
const ZERO_TOTALS = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalCost: 0,
  messageCount: 0,
});

let pricingFetcherModulePromise = null;
const pricingFetcherByOffline = new Map();

export async function getCostSummary(args = {}, loader = {}) {
  const window = VALID_WINDOWS.has(args.window) ? args.window : 'today';
  const groupBy = VALID_GROUPS.has(args.group_by) ? args.group_by : 'none';
  const granularity = normalizeGranularity(args.granularity, window);
  if (granularity === 'hour') {
    return getHourlyCostSummary({ ...args, window, group_by: groupBy, granularity }, loader);
  }

  const options = {
    offline: args.offline ?? true,
    ...windowFilter(window, loader.now ?? args.now),
  };
  if (args.timezone) options.timezone = args.timezone;
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
    granularity,
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

function windowFilter(window, referenceDate = undefined) {
  const now = toDate(referenceDate) ?? new Date();
  if (window === 'all') return {};
  const since = new Date(now);
  if (window === 'today') since.setHours(0, 0, 0, 0);
  if (window === '7d') since.setDate(since.getDate() - 6);
  if (window === '30d') since.setDate(since.getDate() - 29);
  return { since: formatLocalDate(since.getTime()).replaceAll('-', '') };
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

function normalizeGranularity(value, window) {
  if (VALID_GRANULARITIES.has(value)) return value;
  return window === 'today' ? 'hour' : 'day';
}

async function getHourlyCostSummary(args, loader = {}) {
  const startedAt = performance.now();
  const window = args.window;
  const groupBy = args.group_by;
  const now = toDate(loader.now ?? args.now) ?? new Date();
  const bounds = windowBounds(window, now);
  const dbPath =
    loader.cacheDbPath ??
    args.cache_db_path ??
    process.env.IPC_CCUSAGE_CACHE_DB ??
    DEFAULT_HOURLY_CACHE_DB_PATH;
  const db = loader.db ?? openHourlyCache(dbPath);
  const closeDb = loader.db === undefined;

  try {
    const sessionNameMap =
      loader.sessionNameMap instanceof Map
        ? loader.sessionNameMap
        : loadSessionNameMap(loader.ipcDbPath ?? process.env.IPC_DB_PATH ?? DEFAULT_IPC_DB_PATH);
    const scanStats = await refreshHourlyCache({
      db,
      args,
      loader,
      bounds,
    });
    const queryStartedAt = performance.now();
    const rows = queryHourlyRows(db, bounds);
    const queryMs = performance.now() - queryStartedAt;
    return buildHourlySummary({
      rows,
      window,
      groupBy,
      bounds,
      sessionNameMap,
      scanStats,
      queryMs,
      totalMs: performance.now() - startedAt,
    });
  } finally {
    if (closeDb) db.close();
  }
}

function openHourlyCache(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_cache (
      file_path TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL,
      project TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      usage_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS hourly_usage (
      file_path TEXT NOT NULL,
      bucket_start_ms INTEGER NOT NULL,
      bucket_label TEXT NOT NULL,
      bucket_date TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      total_cost REAL NOT NULL,
      message_count INTEGER NOT NULL,
      PRIMARY KEY (file_path, bucket_start_ms, session_id, project, model)
    );

    CREATE INDEX IF NOT EXISTS idx_hourly_usage_bucket ON hourly_usage(bucket_start_ms);
    CREATE INDEX IF NOT EXISTS idx_hourly_usage_session ON hourly_usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_hourly_usage_model ON hourly_usage(model);
    CREATE INDEX IF NOT EXISTS idx_file_cache_mtime ON file_cache(mtime_ms);
  `);
  return db;
}

async function refreshHourlyCache({ db, args, loader, bounds }) {
  const startedAt = performance.now();
  const files = await listUsageFiles(args, loader);
  const cachedStmt = db.prepare(`
    SELECT size_bytes AS sizeBytes, mtime_ms AS mtimeMs
    FROM file_cache
    WHERE file_path = @filePath
  `);
  const deleteUsageStmt = db.prepare('DELETE FROM hourly_usage WHERE file_path = @filePath');
  const upsertFileStmt = db.prepare(`
    INSERT INTO file_cache (file_path, size_bytes, mtime_ms, scanned_at, project, row_count, usage_count)
    VALUES (@filePath, @sizeBytes, @mtimeMs, @scannedAt, @project, @rowCount, @usageCount)
    ON CONFLICT(file_path) DO UPDATE SET
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      scanned_at = excluded.scanned_at,
      project = excluded.project,
      row_count = excluded.row_count,
      usage_count = excluded.usage_count
  `);
  const insertUsageStmt = db.prepare(`
    INSERT OR REPLACE INTO hourly_usage (
      file_path,
      bucket_start_ms,
      bucket_label,
      bucket_date,
      session_id,
      project,
      model,
      input_tokens,
      output_tokens,
      cache_creation_tokens,
      cache_read_tokens,
      total_cost,
      message_count
    )
    VALUES (
      @filePath,
      @bucketStartMs,
      @bucketLabel,
      @bucketDate,
      @sessionId,
      @project,
      @model,
      @inputTokens,
      @outputTokens,
      @cacheCreationTokens,
      @cacheReadTokens,
      @totalCost,
      @messageCount
    )
  `);
  const replaceFileTxn = db.transaction((payload) => {
    deleteUsageStmt.run({ filePath: payload.filePath });
    for (const aggregate of payload.aggregates) insertUsageStmt.run(aggregate);
    upsertFileStmt.run({
      filePath: payload.filePath,
      sizeBytes: payload.sizeBytes,
      mtimeMs: payload.mtimeMs,
      scannedAt: payload.scannedAt,
      project: payload.project,
      rowCount: payload.rowCount,
      usageCount: payload.usageCount,
    });
  });
  const costForEntry = await resolveCostForEntry(args, loader);
  const stats = {
    hit: true,
    files_total: files.length,
    files_considered: 0,
    files_scanned: 0,
    files_skipped: 0,
    bytes_scanned: 0,
    rows_scanned: 0,
    usage_rows: 0,
    scan_ms: 0,
  };

  for (const filePath of files) {
    let fileStat;
    try {
      fileStat = statSync(filePath);
    } catch {
      continue;
    }
    const mtimeMs = Math.trunc(fileStat.mtimeMs);
    const sizeBytes = fileStat.size;
    if (bounds.startMs !== null && mtimeMs < bounds.startMs) {
      stats.files_skipped += 1;
      continue;
    }

    stats.files_considered += 1;
    const cached = cachedStmt.get({ filePath });
    if (cached && cached.sizeBytes === sizeBytes && cached.mtimeMs === mtimeMs) {
      stats.files_skipped += 1;
      continue;
    }

    stats.hit = false;
    const scan = await scanTranscriptFile(filePath, { costForEntry });
    stats.files_scanned += 1;
    stats.bytes_scanned += sizeBytes;
    stats.rows_scanned += scan.rowCount;
    stats.usage_rows += scan.usageCount;
    replaceFileTxn({
      filePath,
      sizeBytes,
      mtimeMs,
      scannedAt: Date.now(),
      project: scan.project,
      rowCount: scan.rowCount,
      usageCount: scan.usageCount,
      aggregates: [...scan.aggregates.values()],
    });
  }

  stats.scan_ms = roundDuration(performance.now() - startedAt);
  stats.bytes_scanned_mb = roundMetric(stats.bytes_scanned / 1024 / 1024, 2);
  return stats;
}

async function listUsageFiles(args, loader) {
  if (Array.isArray(loader.files)) {
    return loader.files.map((file) => String(file));
  }
  const claudePaths = toArray(loader.claudePaths ?? args.claudePath ?? getClaudePaths());
  const globber = loader.globUsageFiles ?? globUsageFiles;
  const results = await globber(claudePaths);
  return results
    .map((entry) => (typeof entry === 'string' ? entry : entry?.file))
    .filter((file) => typeof file === 'string' && file.endsWith('.jsonl'));
}

async function scanTranscriptFile(filePath, { costForEntry }) {
  const project = safeExtractProject(filePath);
  const aggregates = new Map();
  const seen = new Set();
  let rowCount = 0;
  let usageCount = 0;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    rowCount += 1;
    if (!line.includes('"usage"') || !line.includes('"timestamp"')) continue;
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    const normalized = normalizeUsageEntry(data, filePath);
    if (!normalized) continue;
    if (normalized.uniqueHash) {
      if (seen.has(normalized.uniqueHash)) continue;
      seen.add(normalized.uniqueHash);
    }

    const cost = await costForEntry(normalized.data);
    usageCount += 1;
    const bucketStartMs = floorToLocalHourMs(normalized.timestampMs);
    const model = getDisplayModelName(normalized.data) ?? 'unknown';
    const key = [
      bucketStartMs,
      normalized.sessionId,
      project,
      model,
    ].join('\0');
    const usage = normalized.data.message.usage;
    const current = aggregates.get(key) ?? {
      filePath,
      bucketStartMs,
      bucketLabel: formatLocalHour(bucketStartMs),
      bucketDate: formatLocalDate(bucketStartMs),
      sessionId: normalized.sessionId,
      project,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      messageCount: 0,
    };
    current.inputTokens += usage.input_tokens ?? 0;
    current.outputTokens += usage.output_tokens ?? 0;
    current.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    current.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    current.totalCost += Number(cost) || 0;
    current.messageCount += 1;
    aggregates.set(key, current);
  }

  return { project, aggregates, rowCount, usageCount };
}

function normalizeUsageEntry(data, filePath) {
  const usage = data?.message?.usage;
  const timestampMs = Date.parse(data?.timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
    return null;
  }
  const sessionId =
    typeof data.sessionId === 'string' && data.sessionId.trim() !== ''
      ? data.sessionId.trim()
      : basename(filePath, '.jsonl');
  const messageId = data.message?.id;
  const requestId = data.requestId;
  return {
    data,
    timestampMs,
    sessionId,
    uniqueHash:
      typeof messageId === 'string' && typeof requestId === 'string'
        ? `${messageId}:${requestId}`
        : null,
  };
}

async function resolveCostForEntry(args, loader) {
  if (typeof loader.costForEntry === 'function') return loader.costForEntry;
  const fetcher = await getCcusagePricingFetcher(args.offline ?? true);
  return async (data) => calculateCostForEntry(data, 'auto', fetcher);
}

async function getCcusagePricingFetcher(offline) {
  const key = offline ? 'offline' : 'online';
  if (pricingFetcherByOffline.has(key)) return pricingFetcherByOffline.get(key);
  const module = await getCcusagePrivateDataLoaderModule();
  const PricingFetcher = module.PricingFetcher ?? module.A;
  if (typeof PricingFetcher !== 'function') {
    throw new Error('ccusage contract violation: PricingFetcher export not found');
  }
  const fetcher = new PricingFetcher(Boolean(offline));
  pricingFetcherByOffline.set(key, fetcher);
  return fetcher;
}

async function getCcusagePrivateDataLoaderModule() {
  if (!pricingFetcherModulePromise) {
    pricingFetcherModulePromise = (async () => {
      const packageJsonPath = require.resolve('ccusage/package.json');
      const distDir = join(dirname(packageJsonPath), 'dist');
      const privateChunk = readdirSync(distDir)
        .find((file) => /^data-loader-.*\.js$/.test(file));
      if (!privateChunk) {
        throw new Error('ccusage contract violation: private data-loader chunk not found');
      }
      return import(pathToFileURL(join(distDir, privateChunk)).href);
    })();
  }
  return pricingFetcherModulePromise;
}

function queryHourlyRows(db, bounds) {
  const clauses = [];
  const params = {};
  if (bounds.startMs !== null) {
    clauses.push('bucket_start_ms >= @startMs');
    params.startMs = bounds.startMs;
  }
  if (bounds.endMs !== null) {
    clauses.push('bucket_start_ms < @endMs');
    params.endMs = bounds.endMs;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      bucket_start_ms AS bucketStartMs,
      bucket_label AS bucketLabel,
      bucket_date AS bucketDate,
      session_id AS sessionId,
      project,
      model,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_creation_tokens) AS cacheCreationTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(total_cost) AS totalCost,
      SUM(message_count) AS messageCount
    FROM hourly_usage
    ${where}
    GROUP BY bucket_start_ms, bucket_label, bucket_date, session_id, project, model
    ORDER BY bucket_start_ms ASC
  `).all(params);
}

function buildHourlySummary({
  rows,
  window,
  groupBy,
  bounds,
  sessionNameMap,
  scanStats,
  queryMs,
  totalMs,
}) {
  const bucketSkeleton = createHourBucketSkeleton(bounds, rows);
  const totals = { ...ZERO_TOTALS };
  const totalBuckets = new Map();
  const groups = new Map();

  for (const row of rows) {
    addTotals(totals, row);
    addBucketTotals(totalBuckets, row.bucketStartMs, row);
    const key = groupKeyForRow(row, groupBy, sessionNameMap);
    if (!key) continue;
    const group = groups.get(key.key) ?? {
      key: key.key,
      ...(key.ipcName ? { ipc_name: key.ipcName } : {}),
      ...(key.sessionId ? { session_ids: new Set([key.sessionId]) } : {}),
      ...(key.project ? { projects: new Set([key.project]) } : {}),
      totals: { ...ZERO_TOTALS },
      bucketMap: new Map(),
    };
    if (key.sessionId) group.session_ids.add(key.sessionId);
    if (key.project) group.projects.add(key.project);
    addTotals(group.totals, row);
    addBucketTotals(group.bucketMap, row.bucketStartMs, row);
    groups.set(key.key, group);
  }

  return {
    ok: true,
    source: 'ccusage-jsonl-cache',
    window,
    group_by: groupBy,
    granularity: 'hour',
    timezone: formatTimezoneOffset(),
    totals: toPublicTotals(totals),
    buckets: materializeBuckets(bucketSkeleton, totalBuckets),
    groups: [...groups.values()]
      .map((group) => ({
        key: group.key,
        ...(group.ipc_name ? { ipc_name: group.ipc_name } : {}),
        ...(group.session_ids ? { session_ids: [...group.session_ids].sort() } : {}),
        ...(group.projects ? { projects: [...group.projects].sort() } : {}),
        ...toPublicTotals(group.totals),
        message_count: group.totals.messageCount,
        buckets: materializeBuckets(bucketSkeleton, group.bucketMap),
      }))
      .sort((a, b) => b.total_cost_usd - a.total_cost_usd || a.key.localeCompare(b.key)),
    bucket_count: bucketSkeleton.length,
    row_count: rows.length,
    message_count: totals.messageCount,
    cache: {
      ...scanStats,
      query_ms: roundDuration(queryMs),
      total_ms: roundDuration(totalMs),
    },
    generated_at: new Date().toISOString(),
  };
}

function groupKeyForRow(row, groupBy, sessionNameMap) {
  if (groupBy === 'none') return null;
  if (groupBy === 'model') {
    if (row.model === '<synthetic>') return null;
    return { key: row.model };
  }
  const mappedName = sessionNameMap.get(row.sessionId);
  if (mappedName) {
    return {
      key: mappedName,
      ipcName: mappedName,
      sessionId: row.sessionId,
      project: row.project,
    };
  }
  return {
    key: `${row.project}/${row.sessionId}`,
    sessionId: row.sessionId,
    project: row.project,
  };
}

function materializeBuckets(bucketSkeleton, bucketMap) {
  return bucketSkeleton.map((bucket) => ({
    bucket: bucket.label,
    bucket_start_ms: bucket.startMs,
    ...toPublicTotals(bucketMap.get(bucket.startMs) ?? ZERO_TOTALS),
    message_count: bucketMap.get(bucket.startMs)?.messageCount ?? 0,
  }));
}

function addBucketTotals(bucketMap, bucketStartMs, row) {
  const current = bucketMap.get(bucketStartMs) ?? { ...ZERO_TOTALS };
  addTotals(current, row);
  bucketMap.set(bucketStartMs, current);
}

function addTotals(target, row) {
  target.inputTokens += row.inputTokens ?? 0;
  target.outputTokens += row.outputTokens ?? 0;
  target.cacheCreationTokens += row.cacheCreationTokens ?? 0;
  target.cacheReadTokens += row.cacheReadTokens ?? 0;
  target.totalCost += row.totalCost ?? row.cost ?? 0;
  target.messageCount += row.messageCount ?? 0;
}

function createHourBucketSkeleton(bounds, rows) {
  if (bounds.startMs !== null && bounds.endMs !== null) {
    const buckets = [];
    for (let ms = bounds.startMs; ms < bounds.endMs; ms += HOUR_MS) {
      buckets.push({ startMs: ms, label: formatLocalHour(ms) });
    }
    return buckets;
  }
  return [...new Set(rows.map((row) => row.bucketStartMs))]
    .sort((a, b) => a - b)
    .map((startMs) => ({ startMs, label: formatLocalHour(startMs) }));
}

function windowBounds(window, now = new Date()) {
  if (window === 'all') return { startMs: null, endMs: null };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (window === '7d') start.setDate(start.getDate() - 6);
  if (window === '30d') start.setDate(start.getDate() - 29);
  const end = new Date(start);
  const days = window === 'today' ? 1 : (window === '7d' ? 7 : 30);
  end.setTime(start.getTime() + days * DAY_MS);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function loadSessionNameMap(dbPath) {
  const names = new Map();
  if (!existsSync(dbPath)) return names;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT session_id AS sessionId, name
      FROM sessions_history
      WHERE session_id IS NOT NULL
        AND session_id <> ''
        AND name IS NOT NULL
        AND name <> ''
      ORDER BY COALESCE(last_seen_at, spawn_at) DESC
    `).all();
    for (const row of rows) {
      if (!names.has(row.sessionId)) names.set(row.sessionId, row.name);
    }
  } catch {
    return names;
  } finally {
    db?.close();
  }
  return names;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function safeExtractProject(filePath) {
  try {
    return extractProjectFromPath(filePath);
  } catch {
    return 'unknown';
  }
}

function getDisplayModelName(data) {
  const model = data?.message?.model;
  if (model == null) return null;
  return data.message.usage?.speed === 'fast' ? `${model}-fast` : model;
}

function floorToLocalHourMs(timestampMs) {
  const date = new Date(timestampMs);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function formatLocalHour(ms) {
  const date = new Date(ms);
  return `${formatLocalDate(ms)} ${pad2(date.getHours())}:00 ${formatTimezoneOffset(date)}`;
}

function formatLocalDate(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTimezoneOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.trunc(abs / 60))}:${pad2(abs % 60)}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function roundDuration(value) {
  return roundMetric(value, 1);
}

function roundMetric(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function toDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}
