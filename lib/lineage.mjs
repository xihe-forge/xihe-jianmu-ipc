import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LINEAGE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS lineage (
    child_name TEXT NOT NULL,
    parent_name TEXT,
    parent_session_id TEXT,
    reason TEXT,
    ts INTEGER NOT NULL,
    PRIMARY KEY (child_name, ts)
  );
  CREATE INDEX IF NOT EXISTS idx_lineage_child_ts
    ON lineage(child_name, ts DESC);
`;

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeReason(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function createStoreRecord(record) {
  return {
    childName: record.childName,
    parentName: record.parentName,
    parentSessionId: record.parentSessionId,
    reason: record.reason,
    ts: record.ts,
  };
}

function createStoreEntry() {
  return {
    chainRecords: [],
    wakeTimestamps: [],
  };
}

function ensureEntry(store, name) {
  if (!store.has(name)) {
    store.set(name, createStoreEntry());
  }
  return store.get(name);
}

function pruneWakeTimestamps(entry, cutoff) {
  if (!entry) return 0;
  const before = entry.wakeTimestamps.length;
  entry.wakeTimestamps = entry.wakeTimestamps.filter((ts) => ts >= cutoff);
  return before - entry.wakeTimestamps.length;
}

export function createLineageTracker({
  maxDepth = 5,
  maxWithinWindow = 3,
  windowMs = 10 * 60 * 1000,
  dbPath = null,
  now = Date.now,
} = {}) {
  const store = new Map();
  let db = null;
  let stmtInsert = null;
  let stmtSelectAll = null;
  let stmtDeleteChild = null;

  if (dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(LINEAGE_SCHEMA_SQL);
    stmtInsert = db.prepare(`
      INSERT INTO lineage (child_name, parent_name, parent_session_id, reason, ts)
      VALUES (@childName, @parentName, @parentSessionId, @reason, @ts)
    `);
    stmtSelectAll = db.prepare(`
      SELECT child_name, parent_name, parent_session_id, reason, ts
      FROM lineage
      ORDER BY ts ASC
    `);
    stmtDeleteChild = db.prepare(`
      DELETE FROM lineage
      WHERE child_name = @childName
    `);

    const rows = stmtSelectAll.all();
    for (const row of rows) {
      const childName = normalizeName(row.child_name);
      if (!childName) continue;
      const entry = ensureEntry(store, childName);
      entry.chainRecords.push(createStoreRecord({
        childName,
        parentName: normalizeName(row.parent_name),
        parentSessionId: normalizeSessionId(row.parent_session_id),
        reason: normalizeReason(row.reason),
        ts: row.ts,
      }));
      entry.wakeTimestamps.push(row.ts);
    }
  }

  function nextTimestamp(name) {
    const current = Number(now());
    const entry = store.get(name);
    const lastTs = entry?.chainRecords.at(-1)?.ts;
    if (Number.isFinite(lastTs) && current <= lastTs) {
      return lastTs + 1;
    }
    return current;
  }

  function getSnapshot(name) {
    const sessionName = normalizeName(name);
    if (!sessionName) {
      return createStoreEntry();
    }

    const entry = ensureEntry(store, sessionName);
    pruneWakeTimestamps(entry, Number(now()) - windowMs);
    return entry;
  }

  function record({
    childName,
    parentName = null,
    parentSessionId = null,
    reason = null,
  }) {
    const normalizedChildName = normalizeName(childName);
    if (!normalizedChildName) {
      throw new TypeError('childName is required');
    }

    const recordTs = nextTimestamp(normalizedChildName);
    const normalizedRecord = {
      childName: normalizedChildName,
      parentName: normalizeName(parentName) || null,
      parentSessionId: normalizeSessionId(parentSessionId),
      reason: normalizeReason(reason),
      ts: recordTs,
    };

    const entry = ensureEntry(store, normalizedChildName);
    entry.chainRecords.push(createStoreRecord(normalizedRecord));
    entry.wakeTimestamps.push(recordTs);

    if (stmtInsert) {
      stmtInsert.run(normalizedRecord);
    }

    const status = check(normalizedChildName);
    return {
      childName: normalizedChildName,
      parentName: normalizedRecord.parentName,
      parentSessionId: normalizedRecord.parentSessionId,
      reason: normalizedRecord.reason,
      ts: recordTs,
      depth: status.depth,
      wakesInWindow: status.wakesInWindow,
    };
  }

  function check(name) {
    const sessionName = normalizeName(name);
    const entry = getSnapshot(sessionName);
    const depth = entry.chainRecords.length;
    const wakesInWindow = entry.wakeTimestamps.length;

    if (depth >= maxDepth) {
      return {
        allowed: false,
        depth,
        wakesInWindow,
        reason: 'max-depth',
      };
    }

    if (wakesInWindow >= maxWithinWindow) {
      return {
        allowed: false,
        depth,
        wakesInWindow,
        reason: 'max-within-window',
      };
    }

    return {
      allowed: true,
      depth,
      wakesInWindow,
    };
  }

  function chain(name) {
    const sessionName = normalizeName(name);
    const entry = getSnapshot(sessionName);
    return entry.chainRecords
      .map((record) => record.parentSessionId)
      .filter(Boolean);
  }

  function reset(name) {
    const sessionName = normalizeName(name);
    if (!sessionName) return 0;

    const existing = store.get(sessionName);
    const removed = existing?.chainRecords.length ?? 0;
    store.delete(sessionName);
    if (stmtDeleteChild) {
      stmtDeleteChild.run({ childName: sessionName });
    }
    return removed;
  }

  function cleanup() {
    const cutoff = Number(now()) - windowMs;
    let removed = 0;
    for (const [, entry] of store) {
      removed += pruneWakeTimestamps(entry, cutoff);
    }
    return removed;
  }

  return {
    record,
    check,
    chain,
    reset,
    cleanup,
  };
}
