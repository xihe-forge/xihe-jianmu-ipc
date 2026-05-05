/**
 * lib/db.mjs — SQLite message persistence
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { redactSensitive } from './redact.mjs';
import { extractPidFromSessionName, normalizeSessionName } from './session-names.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.IPC_DB_PATH || join(__dirname, '..', 'data', 'messages.db');

// Ensure data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

export const ERR_REBIND_PENDING = 'ERR_REBIND_PENDING';

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'message',
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    content TEXT,
    content_type TEXT DEFAULT 'text',
    topic TEXT,
    ts INTEGER NOT NULL,
    status TEXT DEFAULT 'delivered',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_from ON messages("from");
  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to");
  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic);
  CREATE INDEX IF NOT EXISTS idx_messages_to_ts ON messages("to", ts);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

ensureColumn('messages', 'from_name', 'from_name TEXT');
ensureColumn('messages', 'from_pid', 'from_pid INTEGER');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 3,
    deadline INTEGER,
    payload TEXT,
    ts INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_to ON tasks("to");
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_from ON tasks("from");
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_name TEXT NOT NULL,
    message TEXT NOT NULL,
    ts INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_session ON inbox(session_name);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS suspended_sessions (
    name TEXT PRIMARY KEY,
    reason TEXT,
    task_description TEXT,
    suspended_at INTEGER NOT NULL,
    suspended_by TEXT NOT NULL DEFAULT 'self'
  );

  CREATE INDEX IF NOT EXISTS idx_suspended_sessions_at ON suspended_sessions(suspended_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS wake_records (
    name TEXT PRIMARY KEY,
    last_wake_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_rebind (
    name TEXT PRIMARY KEY,
    last_topics TEXT,
    buffered_messages TEXT,
    released_at INTEGER NOT NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 5,
    next_session_hint TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pending_rebind_released_at ON pending_rebind(released_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS lineage (
    child_name TEXT NOT NULL,
    parent_name TEXT,
    parent_session_id TEXT,
    reason TEXT,
    ts INTEGER NOT NULL,
    PRIMARY KEY (child_name, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_lineage_child_ts ON lineage(child_name, ts DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions_history (
    session_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_name TEXT,
    parent_session_id TEXT,
    spawn_reason TEXT,
    cwd TEXT,
    runtime TEXT DEFAULT 'claude',
    transcript_path TEXT,
    spawn_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    ended_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_history_name_spawn
    ON sessions_history(name, spawn_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_history_parent
    ON sessions_history(parent_session_id);
`);

// Prepared statements
const insertMsg = db.prepare(`
  INSERT OR IGNORE INTO messages (
    id,
    type,
    "from",
    "to",
    content,
    content_type,
    topic,
    ts,
    status,
    from_name,
    from_pid
  )
  VALUES (
    @id,
    @type,
    @from,
    @to,
    @content,
    @contentType,
    @topic,
    @ts,
    @status,
    @fromName,
    @fromPid
  )
`);

const updateMessageStatusStmt = db.prepare(`
  UPDATE messages
  SET status = @status
  WHERE id = @id
`);

const queryMessages = db.prepare(`
  SELECT * FROM messages
  WHERE ("from" = @peer OR "to" = @peer)
  ORDER BY ts DESC
  LIMIT @limit
`);

const queryBetween = db.prepare(`
  SELECT * FROM messages
  WHERE (("from" = @from AND "to" = @to) OR ("from" = @to AND "to" = @from))
  ORDER BY ts DESC
  LIMIT @limit
`);

const queryFrom = db.prepare(`
  SELECT * FROM messages
  WHERE "from" = @from
  ORDER BY ts DESC
  LIMIT @limit
`);

const queryTo = db.prepare(`
  SELECT * FROM messages
  WHERE "to" = @to
  ORDER BY ts DESC
  LIMIT @limit
`);

const queryRecent = db.prepare(`
  SELECT * FROM messages ORDER BY ts DESC LIMIT @limit
`);

const queryRecipientRecent = db.prepare(`
  SELECT * FROM messages
  WHERE ("to" = @name OR "to" = '*')
    AND ts >= @since
  ORDER BY ts ASC
  LIMIT @limit
`);

const countMessages = db.prepare(`SELECT COUNT(*) as count FROM messages`);

const countByAgent = db.prepare(`
  SELECT name, SUM(cnt) as count FROM (
    SELECT "from" as name, COUNT(*) as cnt FROM messages WHERE ts >= @since GROUP BY "from"
    UNION ALL
    SELECT "to" as name, COUNT(*) as cnt FROM messages WHERE ts >= @since GROUP BY "to"
  ) GROUP BY name ORDER BY count DESC
`);

const insertTask = db.prepare(`
  INSERT INTO tasks (id, "from", "to", title, description, status, priority, deadline, payload, ts, updated_at)
  VALUES (@id, @from, @to, @title, @description, @status, @priority, @deadline, @payload, @ts, @updatedAt)
`);

const getTaskById = db.prepare(`SELECT * FROM tasks WHERE id = @id`);

const updateTask = db.prepare(`
  UPDATE tasks SET status = @status, updated_at = @updatedAt, completed_at = @completedAt
  WHERE id = @id
`);

const queryTasks = db.prepare(`
  SELECT * FROM tasks ORDER BY ts DESC LIMIT @limit
`);

const queryTasksByAgent = db.prepare(`
  SELECT * FROM tasks WHERE "to" = @agent ORDER BY ts DESC LIMIT @limit
`);

const queryTasksByStatus = db.prepare(`
  SELECT * FROM tasks WHERE status = @status ORDER BY ts DESC LIMIT @limit
`);

const queryTasksByAgentAndStatus = db.prepare(`
  SELECT * FROM tasks WHERE "to" = @agent AND status = @status ORDER BY ts DESC LIMIT @limit
`);

const countTasksByStatus = db.prepare(`
  SELECT status, COUNT(*) as count FROM tasks GROUP BY status
`);

// Auto-cleanup: delete messages older than TTL
const cleanupOld = db.prepare(`DELETE FROM messages WHERE ts < @cutoff`);
const cleanupOldTasks = db.prepare(`DELETE FROM tasks WHERE ts < @cutoff`);
const insertInboxMessage = db.prepare(`
  INSERT INTO inbox (session_name, message, ts)
  VALUES (@sessionName, @message, @ts)
`);
const queryInboxMessages = db.prepare(`
  SELECT message FROM inbox
  WHERE session_name = @sessionName
  ORDER BY ts ASC, id ASC
`);
const deleteInboxBySession = db.prepare(`
  DELETE FROM inbox WHERE session_name = @sessionName
`);
const cleanupOldInbox = db.prepare(`
  DELETE FROM inbox WHERE ts < @cutoff
`);
// suspended_by is validated at the API layer to one of: self | watchdog | harness.
const upsertSuspendedSession = db.prepare(`
  INSERT INTO suspended_sessions (name, reason, task_description, suspended_at, suspended_by)
  VALUES (@name, @reason, @taskDescription, @suspendedAt, @suspendedBy)
  ON CONFLICT(name) DO UPDATE SET
    reason = excluded.reason,
    task_description = excluded.task_description,
    suspended_at = excluded.suspended_at,
    suspended_by = excluded.suspended_by
`);
const getSuspendedSessionByName = db.prepare(`
  SELECT name, reason, task_description, suspended_at, suspended_by
  FROM suspended_sessions
  WHERE name = @name
`);
const querySuspendedSessions = db.prepare(`
  SELECT name, reason, task_description, suspended_at, suspended_by
  FROM suspended_sessions
  ORDER BY suspended_at ASC
`);
const querySuspendedSessionNames = db.prepare(`
  SELECT name
  FROM suspended_sessions
  ORDER BY suspended_at ASC
`);
const clearAllSuspendedSessions = db.prepare(`
  DELETE FROM suspended_sessions
`);
const clearSuspendedSessionsByReason = db.prepare(`
  DELETE FROM suspended_sessions
  WHERE reason = @reason
`);
const getWakeRecordByName = db.prepare(`
  SELECT name, last_wake_at
  FROM wake_records
  WHERE name = @name
`);
const upsertWakeRecordStmt = db.prepare(`
  INSERT INTO wake_records (name, last_wake_at)
  VALUES (@name, @lastWakeAt)
  ON CONFLICT(name) DO UPDATE SET
    last_wake_at = excluded.last_wake_at
`);
const upsertPendingRebind = db.prepare(`
  INSERT INTO pending_rebind (
    name,
    last_topics,
    buffered_messages,
    released_at,
    ttl_seconds,
    next_session_hint
  )
  VALUES (
    @name,
    @lastTopics,
    @bufferedMessages,
    @releasedAt,
    @ttlSeconds,
    @nextSessionHint
  )
  ON CONFLICT(name) DO UPDATE SET
    last_topics = excluded.last_topics,
    buffered_messages = excluded.buffered_messages,
    released_at = excluded.released_at,
    ttl_seconds = excluded.ttl_seconds,
    next_session_hint = excluded.next_session_hint
`);
const getPendingRebindByName = db.prepare(`
  SELECT
    name,
    last_topics,
    buffered_messages,
    released_at,
    ttl_seconds,
    next_session_hint
  FROM pending_rebind
  WHERE name = @name
`);
const updatePendingRebindBufferedMessages = db.prepare(`
  UPDATE pending_rebind
  SET buffered_messages = @bufferedMessages
  WHERE name = @name
`);
const deletePendingRebindByName = db.prepare(`
  DELETE FROM pending_rebind
  WHERE name = @name
`);
const cleanupExpiredPendingRebindStmt = db.prepare(`
  DELETE FROM pending_rebind
  WHERE released_at + ttl_seconds * 1000 < @now
`);
const insertSessionHistoryStmt = db.prepare(`
  INSERT OR IGNORE INTO sessions_history (
    session_id,
    name,
    parent_name,
    parent_session_id,
    spawn_reason,
    cwd,
    runtime,
    transcript_path,
    spawn_at,
    last_seen_at,
    ended_at
  )
  VALUES (
    @sessionId,
    @name,
    @parentName,
    @parentSessionId,
    @spawnReason,
    @cwd,
    @runtime,
    @transcriptPath,
    @spawnAt,
    @lastSeenAt,
    @endedAt
  )
`);
const updateSessionHistorySeenStmt = db.prepare(`
  UPDATE sessions_history
  SET last_seen_at = @ts
  WHERE session_id = @sessionId
`);
const updateSessionHistoryFromHookStmt = db.prepare(`
  UPDATE sessions_history
  SET
    spawn_reason = 'hook-discovery',
    cwd = COALESCE(@cwd, cwd),
    runtime = COALESCE(@runtime, runtime),
    transcript_path = COALESCE(@transcriptPath, transcript_path),
    last_seen_at = @ts
  WHERE session_id = @sessionId
`);
const updateSessionHistoryEndedStmt = db.prepare(`
  UPDATE sessions_history
  SET ended_at = @ts, last_seen_at = @ts
  WHERE session_id = @sessionId
`);
const querySessionsHistoryByNameStmt = db.prepare(`
  SELECT
    session_id AS sessionId,
    name,
    parent_name AS parentName,
    parent_session_id AS parentSessionId,
    spawn_reason AS spawnReason,
    cwd,
    runtime,
    transcript_path AS transcriptPath,
    spawn_at AS spawnAt,
    last_seen_at AS lastSeenAt,
    ended_at AS endedAt
  FROM sessions_history
  WHERE name = @name
    AND session_id NOT LIKE 'pending-%'
  ORDER BY spawn_at DESC
  LIMIT @limit
`);
const querySessionsHistoryStmt = db.prepare(`
  SELECT
    session_id AS sessionId,
    name,
    parent_name AS parentName,
    parent_session_id AS parentSessionId,
    spawn_reason AS spawnReason,
    cwd,
    runtime,
    transcript_path AS transcriptPath,
    spawn_at AS spawnAt,
    last_seen_at AS lastSeenAt,
    ended_at AS endedAt
  FROM sessions_history
  WHERE session_id NOT LIKE 'pending-%'
  ORDER BY spawn_at DESC
  LIMIT @limit
`);
const querySessionHistoryByIdFullStmt = db.prepare(`
  SELECT
    session_id AS sessionId,
    name,
    parent_name AS parentName,
    parent_session_id AS parentSessionId,
    spawn_reason AS spawnReason,
    cwd,
    runtime,
    transcript_path AS transcriptPath,
    spawn_at AS spawnAt,
    last_seen_at AS lastSeenAt,
    ended_at AS endedAt
  FROM sessions_history
  WHERE session_id = @sessionId
    AND session_id NOT LIKE 'pending-%'
`);
const querySessionsHistoryOlderEndedStmt = db.prepare(`
  SELECT
    session_id AS sessionId,
    name,
    parent_name AS parentName,
    parent_session_id AS parentSessionId,
    spawn_reason AS spawnReason,
    cwd,
    runtime,
    transcript_path AS transcriptPath,
    spawn_at AS spawnAt,
    last_seen_at AS lastSeenAt,
    ended_at AS endedAt
  FROM sessions_history
  WHERE session_id NOT LIKE 'pending-%'
    AND ended_at IS NOT NULL
    AND ended_at < @endedBefore
  ORDER BY ended_at ASC
`);
const querySessionsHistoryOlderLastSeenStmt = db.prepare(`
  SELECT
    session_id AS sessionId,
    name,
    parent_name AS parentName,
    parent_session_id AS parentSessionId,
    spawn_reason AS spawnReason,
    cwd,
    runtime,
    transcript_path AS transcriptPath,
    spawn_at AS spawnAt,
    last_seen_at AS lastSeenAt,
    ended_at AS endedAt
  FROM sessions_history
  WHERE session_id NOT LIKE 'pending-%'
    AND last_seen_at IS NOT NULL
    AND last_seen_at < @lastSeenBefore
  ORDER BY last_seen_at ASC
`);
const querySessionsHistoryWithTranscriptStmt = db.prepare(`
  SELECT
    session_id AS sessionId,
    name,
    parent_name AS parentName,
    parent_session_id AS parentSessionId,
    spawn_reason AS spawnReason,
    cwd,
    runtime,
    transcript_path AS transcriptPath,
    spawn_at AS spawnAt,
    last_seen_at AS lastSeenAt,
    ended_at AS endedAt
  FROM sessions_history
  WHERE session_id NOT LIKE 'pending-%'
    AND transcript_path IS NOT NULL
    AND transcript_path <> ''
  ORDER BY spawn_at DESC
`);
const getSessionHistoryByIdStmt = db.prepare(`
  SELECT session_id AS sessionId
  FROM sessions_history
  WHERE session_id = @sessionId
`);
const getPendingSessionHistoryByNameStmt = db.prepare(`
  SELECT
    session_id AS sessionId,
    parent_name AS parentName,
    parent_session_id AS parentSessionId,
    spawn_reason AS spawnReason,
    spawn_at AS spawnAt
  FROM sessions_history
  WHERE name = @name
    AND session_id LIKE 'pending-%'
  ORDER BY spawn_at DESC
  LIMIT 1
`);
const deleteSessionHistoryByIdStmt = db.prepare(`
  DELETE FROM sessions_history
  WHERE session_id = @sessionId
`);
const deleteSessionsHistoryByNameStmt = db.prepare(`
  DELETE FROM sessions_history
  WHERE name = @name
    AND session_id NOT LIKE 'pending-%'
`);
const deleteLineageByChildNameStmt = db.prepare(`
  DELETE FROM lineage
  WHERE child_name = @name
`);

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

function isPendingRebindExpiredRow(row, currentTime = Date.now()) {
  if (!row) return true;
  return row.released_at + row.ttl_seconds * 1000 < currentTime;
}

function normalizePendingRebindRow(row) {
  if (!row) return null;
  return {
    name: row.name,
    lastTopics: parseJsonArray(row.last_topics),
    bufferedMessages: parseJsonArray(row.buffered_messages),
    releasedAt: row.released_at,
    ttlSeconds: row.ttl_seconds,
    nextSessionHint: row.next_session_hint ?? null,
  };
}

const createPendingRebindTxn = db.transaction(({
  name,
  lastTopics = [],
  releasedAt = Date.now(),
  ttlSeconds = 5,
  nextSessionHint = null,
}) => {
  const existing = getPendingRebindByName.get({ name });
  if (existing && !isPendingRebindExpiredRow(existing, releasedAt)) {
    const error = new Error('rebind already pending');
    error.code = ERR_REBIND_PENDING;
    error.willReleaseAt = existing.released_at + existing.ttl_seconds * 1000;
    throw error;
  }

  upsertPendingRebind.run({
    name,
    lastTopics: JSON.stringify(Array.isArray(lastTopics) ? lastTopics : []),
    bufferedMessages: JSON.stringify([]),
    releasedAt,
    ttlSeconds,
    nextSessionHint,
  });

  return normalizePendingRebindRow(getPendingRebindByName.get({ name }));
});

const appendBufferedMessageTxn = db.transaction((name, msgObj, currentTime = Date.now()) => {
  const row = getPendingRebindByName.get({ name });
  if (!row || isPendingRebindExpiredRow(row, currentTime)) {
    return 0;
  }

  const messages = parseJsonArray(row.buffered_messages);
  messages.push(msgObj);
  return updatePendingRebindBufferedMessages.run({
    name,
    bufferedMessages: JSON.stringify(messages),
  }).changes;
});

const recordSessionSpawnTxn = db.transaction((payload) => {
  const existing = getSessionHistoryByIdStmt.get({ sessionId: payload.sessionId });
  if (existing) {
    const ts = payload.lastSeenAt ?? payload.spawnAt;
    if (payload.spawnReason === 'hook-discovery') {
      updateSessionHistoryFromHookStmt.run({
        sessionId: payload.sessionId,
        cwd: payload.cwd ?? null,
        runtime: payload.runtime ?? null,
        transcriptPath: payload.transcriptPath ?? null,
        ts,
      });
    } else {
      updateSessionHistorySeenStmt.run({
        sessionId: payload.sessionId,
        ts,
      });
    }
    return { recorded: false, sessionId: payload.sessionId };
  }

  const pending = payload.sessionId.startsWith('pending-')
    ? null
    : getPendingSessionHistoryByNameStmt.get({ name: payload.name });
  const parentName = payload.parentName ?? pending?.parentName ?? null;
  const parentSessionId = payload.parentSessionId ?? pending?.parentSessionId ?? null;
  const spawnReason = payload.spawnReason ?? pending?.spawnReason ?? 'fresh';

  const result = insertSessionHistoryStmt.run({
    ...payload,
    parentName,
    parentSessionId,
    spawnReason,
  });

  if (result.changes > 0 && pending?.sessionId) {
    deleteSessionHistoryByIdStmt.run({ sessionId: pending.sessionId });
  }

  return { recorded: result.changes > 0, sessionId: payload.sessionId };
});

const deleteSessionsByNameTxn = db.transaction((name) => {
  const deleted = querySessionsHistoryByNameStmt.all({ name, limit: 1000000 });
  deleteLineageByChildNameStmt.run({ name });
  deleteSessionsHistoryByNameStmt.run({ name });
  return deleted;
});

function normalizeCleanupRow(row, reason) {
  return {
    sessionId: row.sessionId,
    name: row.name,
    spawnAt: row.spawnAt ?? null,
    endedAt: row.endedAt ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    transcriptPath: row.transcriptPath ?? null,
    reason,
  };
}

function addCleanupCandidate(candidates, row, reason) {
  if (!row?.sessionId || row.sessionId.startsWith('pending-')) return;
  const current = candidates.get(row.sessionId);
  if (!current) {
    candidates.set(row.sessionId, normalizeCleanupRow(row, reason));
    return;
  }
  const reasons = new Set(String(current.reason).split('+').filter(Boolean));
  reasons.add(reason);
  current.reason = [...reasons].join('+');
}

export function saveMessage(msg, { status = 'delivered' } = {}) {
  try {
    const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const inferredPid = extractPidFromSessionName(msg.from);
    const fromName =
      normalizeSessionName(msg.from_name) ||
      (inferredPid === null ? normalizeSessionName(msg.from) || null : null);
    const fromPid =
      Number.isInteger(msg.from_pid) && msg.from_pid > 0 ? msg.from_pid : inferredPid;
    insertMsg.run({
      id: msg.id,
      type: msg.type || 'message',
      from: msg.from,
      to: msg.to,
      content: redactSensitive(rawContent),
      contentType: msg.contentType || 'text',
      topic: msg.topic || null,
      ts: msg.ts || Date.now(),
      status,
      fromName,
      fromPid,
    });
  } catch (err) {
    // Ignore duplicate key errors
    if (!err.message.includes('UNIQUE')) throw err;
  }
}

export function updateMessageStatus(id, status) {
  if (typeof id !== 'string' || id.length === 0) return 0;
  if (typeof status !== 'string' || status.length === 0) return 0;
  return updateMessageStatusStmt.run({ id, status }).changes;
}

function mapMessageRow(row) {
  const inferredPid = extractPidFromSessionName(row.from);
  return {
    ...row,
    content: redactSensitive(row.content),
    from_name:
      normalizeSessionName(row.from_name) ||
      (inferredPid === null ? normalizeSessionName(row.from) || null : null),
    from_pid: Number.isInteger(row.from_pid) && row.from_pid > 0 ? row.from_pid : inferredPid,
  };
}

export function getMessages(opts = {}) {
  let rows;
  if (opts.from && opts.to) {
    rows = queryBetween.all({ from: opts.from, to: opts.to, limit: opts.limit || 50 });
  } else if (opts.from) {
    rows = queryFrom.all({ from: opts.from, limit: opts.limit || 50 });
  } else if (opts.to) {
    rows = queryTo.all({ to: opts.to, limit: opts.limit || 50 });
  } else if (opts.peer) {
    rows = queryMessages.all({ peer: opts.peer, limit: opts.limit || 50 });
  } else {
    rows = queryRecent.all({ limit: opts.limit || 50 });
  }
  // Redact sensitive content in API responses (defense-in-depth)
  return rows.map(mapMessageRow);
}

export function getRecipientRecent(name, sinceMs = 6 * 60 * 60 * 1000, limit = 50) {
  const since = Date.now() - sinceMs;
  const rows = queryRecipientRecent.all({ name, since, limit });
  return rows.map(mapMessageRow);
}

export function getMessageCount() {
  return countMessages.get().count;
}

export function cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  cleanupOldTasks.run({ cutoff });
  return cleanupOld.run({ cutoff });
}

export function getMessageCountByAgent(sinceMs = 24 * 60 * 60 * 1000) {
  const since = Date.now() - sinceMs;
  return countByAgent.all({ since });
}

export function saveInboxMessage(sessionName, msg) {
  insertInboxMessage.run({
    sessionName,
    message: JSON.stringify(msg),
    ts: msg?.ts || Date.now(),
  });
}

export function getInboxMessages(sessionName) {
  const rows = queryInboxMessages.all({ sessionName });
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.message)];
    } catch {
      return [];
    }
  });
}

export function clearInbox(sessionName) {
  return deleteInboxBySession.run({ sessionName });
}

export function clearExpiredInbox(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  return cleanupOldInbox.run({ cutoff });
}

export function createPendingRebind(options) {
  return createPendingRebindTxn(options);
}

export function findPendingRebind(name) {
  const row = getPendingRebindByName.get({ name });
  if (!row || isPendingRebindExpiredRow(row)) {
    return null;
  }
  return normalizePendingRebindRow(row);
}

export function appendBufferedMessage(name, msgObj) {
  return appendBufferedMessageTxn(name, msgObj);
}

export function clearPendingRebind(name) {
  return deletePendingRebindByName.run({ name }).changes;
}

export function cleanupExpiredPendingRebind() {
  return cleanupExpiredPendingRebindStmt.run({ now: Date.now() }).changes;
}

function normalizeSessionHistoryPayload(payload = {}) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!sessionId) throw new Error('sessionId is required');
  if (!name) throw new Error('name is required');

  const spawnAt = Number.isFinite(payload.spawnAt) && payload.spawnAt > 0
    ? Math.trunc(payload.spawnAt)
    : Date.now();
  return {
    sessionId,
    name,
    parentName: typeof payload.parentName === 'string' && payload.parentName.trim() !== ''
      ? payload.parentName.trim()
      : null,
    parentSessionId:
      typeof payload.parentSessionId === 'string' && payload.parentSessionId.trim() !== ''
        ? payload.parentSessionId.trim()
        : null,
    spawnReason:
      typeof payload.spawnReason === 'string' && payload.spawnReason.trim() !== ''
        ? payload.spawnReason.trim()
        : 'fresh',
    cwd: typeof payload.cwd === 'string' && payload.cwd.trim() !== '' ? payload.cwd.trim() : null,
    runtime:
      typeof payload.runtime === 'string' && payload.runtime.trim() !== ''
        ? payload.runtime.trim()
        : 'claude',
    transcriptPath:
      typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim() !== ''
        ? payload.transcriptPath.trim()
        : null,
    spawnAt,
    lastSeenAt: Number.isFinite(payload.lastSeenAt) && payload.lastSeenAt > 0
      ? Math.trunc(payload.lastSeenAt)
      : spawnAt,
    endedAt: Number.isFinite(payload.endedAt) && payload.endedAt > 0
      ? Math.trunc(payload.endedAt)
      : null,
  };
}

export function recordSessionSpawn(payload) {
  return recordSessionSpawnTxn(normalizeSessionHistoryPayload(payload));
}

export function updateSessionLastSeen(sessionId, ts = Date.now()) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return 0;
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return updateSessionHistorySeenStmt.run({
    sessionId: sessionId.trim(),
    ts: Math.trunc(ts),
  }).changes;
}

export function markSessionEnded(sessionId, ts = Date.now()) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return 0;
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return updateSessionHistoryEndedStmt.run({
    sessionId: sessionId.trim(),
    ts: Math.trunc(ts),
  }).changes;
}

export function getSessionsByName(name, limit = 10) {
  if (typeof name !== 'string' || name.trim() === '') return [];
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 100) : 10;
  return querySessionsHistoryByNameStmt.all({ name: name.trim(), limit: safeLimit });
}

export function listSessionsHistory({ name = null, limit = 20 } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 500) : 20;
  if (typeof name === 'string' && name.trim() !== '') {
    return querySessionsHistoryByNameStmt.all({ name: name.trim(), limit: safeLimit });
  }
  return querySessionsHistoryStmt.all({ limit: safeLimit });
}

export function deleteSessionsByName(name) {
  if (typeof name !== 'string' || name.trim() === '') return [];
  return deleteSessionsByNameTxn(name.trim());
}

export function deleteSessionById(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null;
  const normalizedSessionId = sessionId.trim();
  const row = querySessionHistoryByIdFullStmt.get({ sessionId: normalizedSessionId });
  if (!row) return null;
  const result = deleteSessionHistoryByIdStmt.run({ sessionId: normalizedSessionId });
  return result.changes > 0 ? row : null;
}

export function findSessionsOlderThan({ endedBefore = null, lastSeenBefore = null } = {}) {
  const rows = [];
  if (Number.isFinite(endedBefore) && endedBefore > 0) {
    rows.push(...querySessionsHistoryOlderEndedStmt.all({ endedBefore: Math.trunc(endedBefore) }));
  }
  if (Number.isFinite(lastSeenBefore) && lastSeenBefore > 0) {
    rows.push(...querySessionsHistoryOlderLastSeenStmt.all({
      lastSeenBefore: Math.trunc(lastSeenBefore),
    }));
  }
  const byId = new Map();
  for (const row of rows) byId.set(row.sessionId, row);
  return [...byId.values()];
}

export function deleteSessionsOlderThan({ endedBefore = null, lastSeenBefore = null } = {}) {
  const deleted = [];
  for (const row of findSessionsOlderThan({ endedBefore, lastSeenBefore })) {
    const removed = deleteSessionById(row.sessionId);
    if (removed) deleted.push(removed);
  }
  return deleted;
}

export function findOrphanSessions({ exists = existsSync } = {}) {
  return querySessionsHistoryWithTranscriptStmt
    .all()
    .filter((row) => !exists(row.transcriptPath));
}

export function cleanupSessionsHistory({
  dryRun = true,
  name = null,
  olderThanMs = null,
  endedOlderThanMs = null,
  lastSeenOlderThanMs = null,
  orphan = false,
  now = Date.now(),
  exists = existsSync,
} = {}) {
  const candidates = new Map();
  const normalizedName = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;

  if (normalizedName) {
    for (const row of querySessionsHistoryByNameStmt.all({ name: normalizedName, limit: 1000000 })) {
      addCleanupCandidate(candidates, row, 'name');
    }
  }

  const endedMs = Number.isFinite(endedOlderThanMs) && endedOlderThanMs > 0
    ? endedOlderThanMs
    : olderThanMs;
  if (Number.isFinite(endedMs) && endedMs > 0) {
    const endedBefore = Math.trunc(now - endedMs);
    for (const row of querySessionsHistoryOlderEndedStmt.all({ endedBefore })) {
      addCleanupCandidate(candidates, row, 'ended-old');
    }
  }

  if (Number.isFinite(lastSeenOlderThanMs) && lastSeenOlderThanMs > 0) {
    const lastSeenBefore = Math.trunc(now - lastSeenOlderThanMs);
    for (const row of querySessionsHistoryOlderLastSeenStmt.all({ lastSeenBefore })) {
      addCleanupCandidate(candidates, row, 'last-seen-old');
    }
  }

  if (orphan) {
    for (const row of findOrphanSessions({ exists })) {
      addCleanupCandidate(candidates, row, 'orphan');
    }
  }

  const deleted = [...candidates.values()].sort((a, b) => (a.spawnAt ?? 0) - (b.spawnAt ?? 0));
  if (!dryRun) {
    if (normalizedName && deleted.every((row) => row.reason === 'name')) {
      deleteSessionsByName(normalizedName);
    } else {
      for (const row of deleted) {
        deleteSessionById(row.sessionId);
      }
    }
  }

  return { deleted, dryRun: Boolean(dryRun), count: deleted.length };
}

export function suspendSession({ name, reason = null, task_description = null, suspended_by = 'self' }) {
  const suspendedAt = Date.now();
  upsertSuspendedSession.run({
    name,
    reason,
    taskDescription: task_description,
    suspendedAt,
    suspendedBy: suspended_by,
  });
  return getSuspendedSessionByName.get({ name }) ?? null;
}

export function listSuspendedSessions() {
  return querySuspendedSessions.all();
}

export function getWakeRecord(name) {
  return getWakeRecordByName.get({ name }) ?? null;
}

export function upsertWakeRecord({ name, last_wake_at }) {
  upsertWakeRecordStmt.run({ name, lastWakeAt: last_wake_at });
  return getWakeRecord(name);
}

export function clearSuspendedSessions(reason = null) {
  if (reason === null || reason === undefined) {
    const names = querySuspendedSessionNames.all().map((row) => row.name);
    if (names.length === 0) {
      return names;
    }

    clearAllSuspendedSessions.run();
    return names;
  }

  const names = querySuspendedSessions.all()
    .filter((session) => session.reason === reason)
    .map((session) => session.name);
  if (names.length === 0) {
    return names;
  }

  clearSuspendedSessionsByReason.run({ reason });
  return names;
}

export function saveTask(task) {
  insertTask.run({
    id: task.id,
    from: task.from,
    to: task.to,
    title: task.title,
    description: task.description || '',
    status: task.status || 'pending',
    priority: task.priority || 3,
    deadline: task.deadline || null,
    payload: task.payload ? JSON.stringify(task.payload) : null,
    ts: task.ts || Date.now(),
    updatedAt: task.ts || Date.now(),
  });
}

export function getTask(id) {
  const row = getTaskById.get({ id });
  if (row && row.payload) {
    try { row.payload = JSON.parse(row.payload); } catch {}
  }
  return row || null;
}

export function updateTaskStatus(id, status, completedAt = null) {
  const now = Date.now();
  const finalCompletedAt = (status === 'completed' || status === 'failed') ? (completedAt || now) : null;
  return updateTask.run({ id, status, updatedAt: now, completedAt: finalCompletedAt });
}

export function listTasks(opts = {}) {
  const { agent, status, limit = 20 } = opts;
  let rows;
  if (agent && status) {
    rows = queryTasksByAgentAndStatus.all({ agent, status, limit });
  } else if (agent) {
    rows = queryTasksByAgent.all({ agent, limit });
  } else if (status) {
    rows = queryTasksByStatus.all({ status, limit });
  } else {
    rows = queryTasks.all({ limit });
  }
  return rows.map(r => {
    if (r.payload) {
      try { r.payload = JSON.parse(r.payload); } catch {}
    }
    return r;
  });
}

export function getTaskStats() {
  return countTasksByStatus.all();
}

export function close() {
  db.close();
}
