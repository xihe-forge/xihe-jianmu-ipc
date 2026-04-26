/**
 * lib/db.mjs — SQLite message persistence
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { redactSensitive } from './redact.mjs';

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

// Prepared statements
const insertMsg = db.prepare(`
  INSERT OR IGNORE INTO messages (id, type, "from", "to", content, content_type, topic, ts, status)
  VALUES (@id, @type, @from, @to, @content, @contentType, @topic, @ts, @status)
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

export function saveMessage(msg) {
  try {
    const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    insertMsg.run({
      id: msg.id,
      type: msg.type || 'message',
      from: msg.from,
      to: msg.to,
      content: redactSensitive(rawContent),
      contentType: msg.contentType || 'text',
      topic: msg.topic || null,
      ts: msg.ts || Date.now(),
      status: 'delivered',
    });
  } catch (err) {
    // Ignore duplicate key errors
    if (!err.message.includes('UNIQUE')) throw err;
  }
}

export function getMessages(opts = {}) {
  let rows;
  if (opts.from && opts.to) {
    rows = queryBetween.all({ from: opts.from, to: opts.to, limit: opts.limit || 50 });
  } else if (opts.peer) {
    rows = queryMessages.all({ peer: opts.peer, limit: opts.limit || 50 });
  } else {
    rows = queryRecent.all({ limit: opts.limit || 50 });
  }
  // Redact sensitive content in API responses (defense-in-depth)
  return rows.map(r => ({ ...r, content: redactSensitive(r.content) }));
}

export function getRecipientRecent(name, sinceMs = 6 * 60 * 60 * 1000, limit = 50) {
  const since = Date.now() - sinceMs;
  const rows = queryRecipientRecent.all({ name, since, limit });
  return rows.map(r => ({ ...r, content: redactSensitive(r.content) }));
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

export function clearSuspendedSessions() {
  const names = querySuspendedSessionNames.all().map((row) => row.name);
  if (names.length === 0) {
    return names;
  }

  clearAllSuspendedSessions.run();
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
