import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { getObservationDbPath, getProjectStateDir } from './claude-paths.mjs';

export const DEFAULT_RECALL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const MAX_RECALL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_RECALL_LIMIT = 50;
export const MAX_RECALL_LIMIT = 500;
export const OBSERVATION_TEXT_PREVIEW_LIMIT = 500;

function truncateText(value, limit = OBSERVATION_TEXT_PREVIEW_LIMIT) {
  if (typeof value !== 'string' || value.length <= limit) {
    return value ?? null;
  }
  return `${value.slice(0, limit)}...`;
}

function parseJsonArray(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function mapObservationRow(row, { project, truncateLongText = true } = {}) {
  const toolInput = truncateLongText ? truncateText(row.tool_input) : (row.tool_input ?? null);
  const toolOutput = truncateLongText ? truncateText(row.tool_output) : (row.tool_output ?? null);

  return {
    project,
    id: row.id,
    session_id: row.session_id,
    ipc_name: row.ipc_name,
    ts: row.ts,
    tool_name: row.tool_name ?? null,
    tool_input: toolInput,
    tool_output: toolOutput,
    files_touched: parseJsonArray(row.files_touched),
    commit_sha: row.commit_sha ?? null,
    tags: parseJsonArray(row.tags),
    ipc_peer: row.ipc_peer ?? null,
  };
}

function getNowValue(now = Date.now) {
  return typeof now === 'function' ? now() : Number(now);
}

export function normalizeRecallSince(value, { now = Date.now } = {}) {
  const currentTime = getNowValue(now);
  if (!Number.isFinite(currentTime)) {
    throw new TypeError('now must resolve to a finite timestamp');
  }

  if (value === null || value === undefined || value === '') {
    return currentTime - DEFAULT_RECALL_LOOKBACK_MS;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return currentTime - DEFAULT_RECALL_LOOKBACK_MS;
  }

  if (numeric >= 1_000_000_000_000) {
    return Math.max(Math.trunc(numeric), currentTime - MAX_RECALL_LOOKBACK_MS);
  }

  const lookback = Math.min(Math.trunc(numeric), MAX_RECALL_LOOKBACK_MS);
  return currentTime - lookback;
}

export function clampObservationLimit(
  value,
  fallback = DEFAULT_RECALL_LIMIT,
  max = MAX_RECALL_LIMIT,
) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(numeric), max);
}

function openObservationDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    // readonly or incompatible SQLite builds can ignore WAL reconfiguration.
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function listObservationTargets({ project, homeDir = null } = {}) {
  if (project !== '*') {
    const dbPath = getObservationDbPath(project, { homeDir });
    return existsSync(dbPath) ? [{ project, dbPath }] : [];
  }

  const projectStateDir = getProjectStateDir({ homeDir });
  if (!existsSync(projectStateDir)) {
    return [];
  }

  return readdirSync(projectStateDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      project: entry.name,
      dbPath: getObservationDbPath(entry.name, { homeDir }),
    }))
    .filter((entry) => existsSync(entry.dbPath));
}

function hasFtsTable(db) {
  const row = db
    .prepare(
      `
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'observations_fts'
    LIMIT 1
  `,
    )
    .get();
  return !!row;
}

function buildKeywordFallbackFilter(params, keyword) {
  params.keywordLike = `%${keyword}%`;
  return `(
    observations.tool_input LIKE @keywordLike
    OR observations.tool_output LIKE @keywordLike
    OR observations.tags LIKE @keywordLike
  )`;
}

function buildRecallQuery({ db, since, limit, ipcName, toolName, tags, keyword }) {
  const params = {
    since,
    limit,
  };
  const where = ['observations.ts >= @since'];

  if (ipcName) {
    params.ipcName = ipcName;
    where.push('observations.ipc_name = @ipcName');
  }

  if (toolName) {
    params.toolName = toolName;
    where.push('observations.tool_name = @toolName');
  }

  tags.forEach((tag, index) => {
    const key = `tag_${index}`;
    params[key] = tag;
    where.push(`
      EXISTS (
        SELECT 1
        FROM json_each(
          CASE
            WHEN json_valid(observations.tags) THEN observations.tags
            ELSE '[]'
          END
        ) AS ${key}
        WHERE ${key}.value = @${key}
      )
    `);
  });

  let joins = '';
  if (keyword) {
    if (hasFtsTable(db)) {
      params.keyword = keyword;
      joins = 'INNER JOIN observations_fts ON observations_fts.rowid = observations.id';
      where.push('observations_fts MATCH @keyword');
    } else {
      where.push(buildKeywordFallbackFilter(params, keyword));
    }
  }

  const sql = `
    SELECT observations.*
    FROM observations
    ${joins}
    WHERE ${where.join('\n      AND ')}
    ORDER BY observations.ts DESC, observations.id DESC
    LIMIT @limit
  `;

  return { sql, params };
}

function queryObservationDb({ project, dbPath, since, limit, ipcName, toolName, tags, keyword }) {
  const db = openObservationDb(dbPath);

  try {
    const { sql, params } = buildRecallQuery({
      db,
      since,
      limit,
      ipcName,
      toolName,
      tags,
      keyword,
    });
    return db
      .prepare(sql)
      .all(params)
      .map((row) => mapObservationRow(row, { project }));
  } finally {
    db.close();
  }
}

function parseJsonlTag(tags = []) {
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.startsWith('jsonl:')) {
      continue;
    }

    const match = /^jsonl:(.+):([^:]+)$/.exec(tag);
    if (!match) {
      continue;
    }

    return {
      jsonl_path: match[1],
      line_range: match[2],
    };
  }

  return null;
}

export function recallObservations(input = {}, options = {}) {
  const project = typeof input.project === 'string' ? input.project.trim() : '';
  if (!project) {
    throw new TypeError('project is required');
  }

  const limit = clampObservationLimit(input.limit);
  const since = normalizeRecallSince(input.since, options);
  const ipcName =
    typeof input.ipc_name === 'string' && input.ipc_name.trim() !== ''
      ? input.ipc_name.trim()
      : null;
  const toolName =
    typeof input.tool_name === 'string' && input.tool_name.trim() !== ''
      ? input.tool_name.trim()
      : null;
  const keyword =
    typeof input.keyword === 'string' && input.keyword.trim() !== '' ? input.keyword.trim() : null;
  const tags = normalizeStringArray(input.tags);
  const targets = listObservationTargets({
    project,
    homeDir: options.homeDir ?? null,
  });

  if (targets.length === 0) {
    return {
      ok: true,
      project,
      count: 0,
      observations: [],
      note: 'db not found',
    };
  }

  const observations = targets
    .flatMap((target) =>
      queryObservationDb({
        project: target.project,
        dbPath: target.dbPath,
        since,
        limit,
        ipcName,
        toolName,
        tags,
        keyword,
      }),
    )
    .sort((left, right) => {
      if (right.ts !== left.ts) {
        return right.ts - left.ts;
      }
      return right.id - left.id;
    })
    .slice(0, limit);

  return {
    ok: true,
    project,
    count: observations.length,
    observations,
  };
}

export function getObservationDetail(input = {}, options = {}) {
  const project = typeof input.project === 'string' ? input.project.trim() : '';
  const id = Number(input.id);

  if (!project) {
    throw new TypeError('project is required');
  }
  if (!Number.isFinite(id) || id <= 0) {
    throw new TypeError('id must be a positive number');
  }

  const dbPath = getObservationDbPath(project, { homeDir: options.homeDir ?? null });
  if (!existsSync(dbPath)) {
    return { ok: false, error: 'db not found', project, id: Math.trunc(id) };
  }

  const db = openObservationDb(dbPath);

  try {
    const row = db
      .prepare(
        `
      SELECT *
      FROM observations
      WHERE id = @id
    `,
      )
      .get({ id: Math.trunc(id) });

    if (!row) {
      return { ok: false, error: 'observation not found', project, id: Math.trunc(id) };
    }

    const observation = mapObservationRow(row, { project, truncateLongText: false });
    const jsonlMetadata = parseJsonlTag(observation.tags);

    return {
      ok: true,
      observation: {
        ...observation,
        ...(jsonlMetadata ?? {}),
      },
    };
  } finally {
    db.close();
  }
}
