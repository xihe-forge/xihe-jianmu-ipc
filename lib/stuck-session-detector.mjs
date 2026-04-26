import { statSync } from 'node:fs';

const COOLDOWN_MS_DEFAULT = 5 * 60 * 1000;
const STUCK_THRESHOLD_MS_DEFAULT = 5 * 60 * 1000;
const WS_OPEN = 1;
const DEFAULT_ERROR_KEYWORDS = [
  'ECONNRESET',
  '429',
  'Unable to connect',
  /attempt \d+\/10/,
  'rate limit',
];

function isThenable(value) {
  return value && typeof value.then === 'function';
}

function valuesOfSessions(sessions) {
  if (sessions?.values && typeof sessions.values === 'function') {
    return sessions.values();
  }
  return Array.isArray(sessions) ? sessions : [];
}

function keywordText(keyword) {
  return keyword instanceof RegExp ? keyword.source : String(keyword);
}

function matchKeyword(tail, errorKeywords) {
  for (const keyword of errorKeywords) {
    if (keyword instanceof RegExp) {
      keyword.lastIndex = 0;
      if (keyword.test(tail)) {
        return keywordText(keyword);
      }
      continue;
    }
    if (tail.includes(keyword)) {
      return keywordText(keyword);
    }
  }
  return null;
}

function resolveReason(tail) {
  return /429|rate limit/i.test(tail) ? 'stuck-rate-limited' : 'stuck-network';
}

export function createStuckSessionDetector({
  db,
  getSessions,
  getSessionState,
  readTranscriptTail,
  now = Date.now,
  cooldownMs = COOLDOWN_MS_DEFAULT,
  stuckThresholdMs = STUCK_THRESHOLD_MS_DEFAULT,
  errorKeywords = DEFAULT_ERROR_KEYWORDS,
}) {
  const recentlyDetected = new Map();

  function processSessions(sessions, ts) {
    const suspendedSet = new Set((db.listSuspendedSessions?.() || []).map((session) => session.name));
    const detected = [];
    const skipped = [];

    for (const session of valuesOfSessions(sessions)) {
      const name = session?.name;
      if (!session?.ws || session.ws.readyState !== WS_OPEN) {
        skipped.push({ name, reason: 'ws-not-open' });
        continue;
      }

      if (suspendedSet.has(name)) {
        skipped.push({ name, reason: 'already-suspended' });
        continue;
      }

      const sessionState = getSessionState(session.pid);
      if (!sessionState) {
        skipped.push({ name, reason: 'no-pid-state' });
        continue;
      }

      if (sessionState.status !== 'busy') {
        skipped.push({ name, reason: 'not-busy' });
        continue;
      }

      if (ts - sessionState.updatedAt < stuckThresholdMs) {
        skipped.push({ name, reason: 'fresh-update' });
        continue;
      }

      let stat;
      try {
        stat = statSync(sessionState.transcriptPath);
      } catch {
        skipped.push({ name, reason: 'no-transcript' });
        continue;
      }

      if (ts - stat.mtimeMs < stuckThresholdMs) {
        skipped.push({ name, reason: 'fresh-transcript' });
        continue;
      }

      let tail;
      try {
        tail = readTranscriptTail(sessionState.transcriptPath, 20);
      } catch {
        skipped.push({ name, reason: 'transcript-read-failed' });
        continue;
      }

      if (typeof tail !== 'string') {
        skipped.push({ name, reason: 'transcript-read-failed' });
        continue;
      }

      const matchedKeyword = matchKeyword(tail, errorKeywords);
      if (!matchedKeyword) {
        skipped.push({ name, reason: 'no-error-keyword' });
        continue;
      }

      const lastDetectedAt = recentlyDetected.get(name) || 0;
      if (ts - lastDetectedAt < cooldownMs) {
        skipped.push({ name, reason: 'cooldown' });
        continue;
      }

      db.suspendSession({
        name,
        reason: resolveReason(tail),
        task_description: `stuck detected by 5-signal AND · keyword=${matchedKeyword}`,
        suspended_by: 'watchdog',
      });
      recentlyDetected.set(name, ts);
      detected.push(name);
    }

    return { detected, skipped };
  }

  return {
    tick() {
      const ts = now();
      const sessions = getSessions();
      if (isThenable(sessions)) {
        return sessions.then((resolvedSessions) => processSessions(resolvedSessions, ts));
      }
      return processSessions(sessions, ts);
    },
  };
}
