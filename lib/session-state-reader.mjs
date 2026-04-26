import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeDir } from './claude-paths.mjs';

const VALID_STATUSES = new Set(['busy', 'idle']);

function defaultSessionsDir(options = {}) {
  return join(getClaudeDir(options), 'sessions');
}

function encodeProjectPath(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return null;
  }
  return cwd.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-');
}

export function findLatestTranscriptByCwd(cwd, opts = {}) {
  const projectDir = encodeProjectPath(cwd);
  if (!projectDir) return null;

  const transcriptsDir = join(getClaudeDir(opts), 'projects', projectDir);
  if (!existsSync(transcriptsDir)) return null;

  let entries;
  try {
    entries = readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const jsonlFiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const transcriptPath = join(transcriptsDir, entry.name);
    try {
      jsonlFiles.push({ transcriptPath, mtimeMs: statSync(transcriptPath).mtimeMs });
    } catch {}
  }

  if (jsonlFiles.length === 0) return null;
  jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return jsonlFiles[0].transcriptPath;
}

function inferTranscriptPath(session, options = {}) {
  const projectDir = encodeProjectPath(session.cwd);
  if (!projectDir || typeof session.sessionId !== 'string' || session.sessionId.trim() === '') {
    return '';
  }
  return join(getClaudeDir(options), 'projects', projectDir, `${session.sessionId}.jsonl`);
}

function normalizeSession(session, opts) {
  const pid = Number(session?.pid);
  const status = session?.status;
  const updatedAt = Number(session?.updatedAt);

  if (!Number.isInteger(pid) || !VALID_STATUSES.has(status) || !Number.isFinite(updatedAt)) {
    return null;
  }

  const nowMs = opts.now();
  const elapsedMs = Math.max(0, nowMs - updatedAt);
  return {
    pid,
    sessionId: session.sessionId ?? '',
    status,
    updatedAt,
    transcriptPath: session.transcriptPath || inferTranscriptPath(session, opts),
    idleMs: status === 'idle' ? elapsedMs : 0,
    busyMs: status === 'busy' ? elapsedMs : 0,
  };
}

export function getAllSessionStates(opts = {}) {
  const options = {
    ...opts,
    dir: opts.dir ?? defaultSessionsDir(opts),
    now: opts.now ?? Date.now,
  };

  if (!existsSync(options.dir)) {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(options.dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const states = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(join(options.dir, entry.name), 'utf8'));
      const state = normalizeSession(parsed, options);
      if (state) {
        states.push(state);
      }
    } catch {}
  }

  return states;
}

export function getSessionState(pid, opts = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid)) {
    return null;
  }
  return getAllSessionStates(opts).find((state) => state.pid === numericPid) ?? null;
}
