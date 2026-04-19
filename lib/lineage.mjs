import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = process.env.IPC_DB_PATH || join(__dirname, '..', 'data', 'messages.db');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeOptionalString(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function normalizeRecord(record) {
  return {
    childName: record.childName,
    parentName: record.parentName ?? null,
    parentSessionId: record.parentSessionId ?? null,
    reason: record.reason ?? null,
    ts: record.ts,
  };
}

function normalizeRow(row) {
  return normalizeRecord({
    childName: row.child_name,
    parentName: row.parent_name,
    parentSessionId: row.parent_session_id,
    reason: row.reason,
    ts: row.ts,
  });
}

function dedupe(values) {
  return [...new Set(values.filter((value) => isNonEmptyString(value)))];
}

function ensureDbPath(dbPath) {
  const resolved = dbPath ?? DEFAULT_DB_PATH;
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

export function createLineageTracker({
  maxDepth = 5,
  maxWithinWindow = 3,
  windowMs = 10 * 60 * 1000,
  dbPath = null,
  now = Date.now,
} = {}) {
  const records = new Map();
  const sqlite = dbPath ? new Database(ensureDbPath(dbPath)) : null;

  if (sqlite) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec(`
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
  }

  const selectByChildAsc = sqlite?.prepare(`
    SELECT child_name, parent_name, parent_session_id, reason, ts
    FROM lineage
    WHERE child_name = @childName
    ORDER BY ts ASC
  `);
  const selectNames = sqlite?.prepare(`
    SELECT DISTINCT child_name
    FROM lineage
  `);
  const selectLatestTsByChild = sqlite?.prepare(`
    SELECT ts
    FROM lineage
    WHERE child_name = @childName
    ORDER BY ts DESC
    LIMIT 1
  `);
  const insertRecord = sqlite?.prepare(`
    INSERT INTO lineage (child_name, parent_name, parent_session_id, reason, ts)
    VALUES (@childName, @parentName, @parentSessionId, @reason, @ts)
  `);
  const deleteByChild = sqlite?.prepare(`
    DELETE FROM lineage
    WHERE child_name = @childName
  `);
  const deleteByChildAndTs = sqlite?.prepare(`
    DELETE FROM lineage
    WHERE child_name = @childName AND ts = @ts
  `);

  function readChildRecords(childName) {
    if (sqlite) {
      return selectByChildAsc.all({ childName }).map(normalizeRow);
    }
    return (records.get(childName) ?? []).map((record) => ({ ...record }));
  }

  function writeChildRecords(childName, childRecords) {
    if (sqlite) {
      deleteByChild.run({ childName });
      for (const record of childRecords) {
        insertRecord.run(record);
      }
      return;
    }

    if (childRecords.length === 0) {
      records.delete(childName);
      return;
    }
    records.set(childName, childRecords.map((record) => ({ ...record })));
  }

  function getChildNames() {
    if (sqlite) {
      return selectNames.all().map((row) => row.child_name);
    }
    return [...records.keys()];
  }

  function getNextTimestamp(childName, baseTs) {
    if (sqlite) {
      const latest = selectLatestTsByChild.get({ childName });
      const latestTs = latest?.ts ?? null;
      return latestTs != null && latestTs >= baseTs ? latestTs + 1 : baseTs;
    }

    const childRecords = records.get(childName) ?? [];
    const latestTs = childRecords.length > 0 ? childRecords[childRecords.length - 1].ts : null;
    return latestTs != null && latestTs >= baseTs ? latestTs + 1 : baseTs;
  }

  function trimExpired(currentTime = now()) {
    const cutoff = currentTime - windowMs;
    const keepLimit = Math.max(maxDepth, maxWithinWindow, 1);

    for (const childName of getChildNames()) {
      const childRecords = readChildRecords(childName);
      if (childRecords.length === 0) {
        continue;
      }

      const startKeepIndex = Math.max(0, childRecords.length - keepLimit);
      const retained = childRecords.filter((record, index) =>
        record.ts >= cutoff || index >= startKeepIndex);

      if (sqlite) {
        const retainedTs = new Set(retained.map((record) => record.ts));
        for (const record of childRecords) {
          if (!retainedTs.has(record.ts)) {
            deleteByChildAndTs.run({ childName, ts: record.ts });
          }
        }
      } else {
        writeChildRecords(childName, retained);
      }
    }
  }

  function buildChain(name, seen = new Set()) {
    if (!isNonEmptyString(name) || seen.has(name)) {
      return [];
    }
    seen.add(name);

    const childRecords = readChildRecords(name.trim());
    if (childRecords.length === 0) {
      return [];
    }

    const latest = childRecords[childRecords.length - 1];
    const parentChain = latest.parentName && latest.parentName !== name
      ? buildChain(latest.parentName, seen)
      : [];
    const localChain = childRecords.map((record) => record.parentSessionId);

    return dedupe([...parentChain, ...localChain]);
  }

  function countWithinWindow(name, currentTime = now()) {
    const cutoff = currentTime - windowMs;
    return readChildRecords(name).filter((record) => record.ts >= cutoff).length;
  }

  function record({ childName, parentName = null, parentSessionId = null, reason = null }) {
    if (!isNonEmptyString(childName)) {
      throw new TypeError('childName is required');
    }

    const normalizedChildName = childName.trim();
    const ts = getNextTimestamp(normalizedChildName, Number(now()));
    const entry = normalizeRecord({
      childName: normalizedChildName,
      parentName: normalizeOptionalString(parentName),
      parentSessionId: normalizeOptionalString(parentSessionId),
      reason: normalizeOptionalString(reason),
      ts,
    });

    if (sqlite) {
      insertRecord.run(entry);
    } else {
      const childRecords = readChildRecords(normalizedChildName);
      childRecords.push(entry);
      writeChildRecords(normalizedChildName, childRecords);
    }

    trimExpired(ts);
    return { ...entry };
  }

  function check(name) {
    trimExpired();

    const normalizedName = normalizeOptionalString(name);
    if (!normalizedName) {
      return { allowed: true, depth: 0, wakesInWindow: 0 };
    }

    const depth = buildChain(normalizedName).length;
    const wakesInWindow = countWithinWindow(normalizedName);
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
        reason: 'rate-limit',
      };
    }
    return { allowed: true, depth, wakesInWindow };
  }

  function chain(name) {
    trimExpired();
    return buildChain(name);
  }

  function reset(name) {
    const normalizedName = normalizeOptionalString(name);
    if (!normalizedName) {
      return 0;
    }

    if (sqlite) {
      return deleteByChild.run({ childName: normalizedName }).changes;
    }

    const existed = records.has(normalizedName);
    records.delete(normalizedName);
    return existed ? 1 : 0;
  }

  return {
    record,
    check,
    chain,
    reset,
    cleanup() {
      trimExpired();
    },
    close() {
      sqlite?.close();
    },
  };
}
