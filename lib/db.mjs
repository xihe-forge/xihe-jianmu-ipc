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

const countMessages = db.prepare(`SELECT COUNT(*) as count FROM messages`);

// Auto-cleanup: delete messages older than TTL
const cleanupOld = db.prepare(`DELETE FROM messages WHERE ts < @cutoff`);

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

export function getMessageCount() {
  return countMessages.get().count;
}

export function cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  return cleanupOld.run({ cutoff });
}

export function close() {
  db.close();
}
