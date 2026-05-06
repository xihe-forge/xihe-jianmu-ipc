#!/usr/bin/env node
import * as pty from '@lydell/node-pty';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createCodexPtyBridgeReady,
  processCodexPtyBridgeQueue,
} from '../lib/codex-pty-bridge.mjs';

const [, , codexBin, ...codexArgs] = process.argv;

if (!codexBin) {
  process.stderr.write('usage: codex-title-wrapper.mjs <codex-bin> [...args]\n');
  process.exit(2);
}

let child;
try {
  child = pty.spawn(codexBin, codexArgs, {
    name: 'xterm-256color',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env,
  });
} catch (error) {
  process.stderr.write(`[codex-title-wrapper] pty spawn failed: ${error?.message ?? error}\n`);
  process.exit(1);
}

const OSC_TITLE_PATTERN = /\x1B\][012];[^\x07\x1B]*(?:\x07|\x1B\\)/g;
const ipcName = (process.env.IPC_NAME ?? '').trim();
const codexPtySubmitDelayMs = parseNonNegativeInteger(
  process.env.IPC_CODEX_PTY_SUBMIT_DELAY_MS,
  1000,
);
const codexSessionMapPollMs = parseNonNegativeInteger(
  process.env.IPC_CODEX_SESSION_MAP_POLL_MS,
  1000,
);
const codexSessionMapTimeoutMs = parseNonNegativeInteger(
  process.env.IPC_CODEX_SESSION_MAP_TIMEOUT_MS,
  5 * 60 * 1000,
);
const wrapperStartedAt = Date.now();
const wrapperCwd = process.cwd();
const codexHome = resolveCodexHome();
const codexSessionsRoot = join(codexHome, 'sessions');
const resumeSessionId = parseResumeSessionId(codexArgs);
let exited = false;
let ptyBridgeProcessing = false;
let ptyBridgeWatcher = null;
let sessionMapTimer = null;
let sessionMapDeadlineTimer = null;
let sessionMapRecordedId = null;

function titleSequence(title) {
  return `\x1b]0;${title}\x07`;
}

function rewriteTitle(data) {
  if (!ipcName) return String(data);
  return String(data).replace(OSC_TITLE_PATTERN, titleSequence(ipcName));
}

function exitOnce(code) {
  if (exited) return;
  exited = true;
  process.exit(code);
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveCodexHome() {
  const configured = process.env.CODEX_HOME?.trim();
  return configured || join(homedir(), '.codex');
}

function normalizePath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function safeMapFileName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
}

function parseResumeSessionId(args) {
  const resumeIndex = args.indexOf('resume');
  if (resumeIndex < 0) return null;
  for (let index = resumeIndex + 1; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (!arg || arg.startsWith('-')) continue;
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(arg)) {
      return arg;
    }
    return null;
  }
  return null;
}

function* walkJsonlFiles(root, depth = 0) {
  if (depth > 5) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonlFiles(fullPath, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield fullPath;
    }
  }
}

function parseCodexSessionMeta(filePath) {
  try {
    const firstLine = readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0];
    const event = JSON.parse(firstLine);
    if (event?.type !== 'session_meta') return null;
    const payload = event.payload ?? {};
    if (typeof payload.id !== 'string' || payload.id.trim() === '') return null;
    const timestampMs = parseTimestampMs(payload.timestamp) ?? parseTimestampMs(event.timestamp);
    return {
      id: payload.id,
      cwd: payload.cwd ?? null,
      source: payload.source ?? null,
      originator: payload.originator ?? null,
      timestampMs,
      transcriptPath: filePath,
    };
  } catch {
    return null;
  }
}

function parseTimestampMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function findCodexSessionById(sessionId) {
  if (!sessionId || !existsSync(codexSessionsRoot)) return null;
  for (const filePath of walkJsonlFiles(codexSessionsRoot)) {
    if (!basename(filePath, '.jsonl').endsWith(sessionId)) continue;
    const meta = parseCodexSessionMeta(filePath);
    if (meta?.id === sessionId) return meta;
  }
  return null;
}

function findCurrentCodexSession() {
  if (!existsSync(codexSessionsRoot)) return null;
  const expectedCwd = normalizePath(wrapperCwd);
  const candidates = [];

  for (const filePath of walkJsonlFiles(codexSessionsRoot)) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    const statTimeMs = stat.birthtimeMs || stat.ctimeMs || 0;
    if (statTimeMs < wrapperStartedAt - 2_000) continue;
    const meta = parseCodexSessionMeta(filePath);
    if (!meta) continue;
    const fileTimeMs = meta.timestampMs ?? statTimeMs;
    if (fileTimeMs < wrapperStartedAt - 2_000) continue;
    if (normalizePath(meta.cwd) !== expectedCwd) continue;
    if (meta.source && meta.source !== 'cli') continue;
    if (meta.originator && meta.originator !== 'codex-tui') continue;
    candidates.push({ ...meta, fileTimeMs });
  }

  candidates.sort((a, b) => b.fileTimeMs - a.fileTimeMs);
  return candidates[0] ?? null;
}

function recordIpcxSession(session) {
  if (!ipcName || !session?.id || sessionMapRecordedId === session.id) return;
  sessionMapRecordedId = session.id;
  const now = Date.now();
  const record = {
    name: ipcName,
    runtime: 'codex',
    sessionId: session.id,
    transcriptPath: session.transcriptPath,
    cwd: session.cwd ?? wrapperCwd,
    spawnAt: wrapperStartedAt,
    lastSeenAt: now,
    wrapperPid: process.pid,
  };

  try {
    const mapDir = join(codexHome, 'ipcx-session-map');
    mkdirSync(mapDir, { recursive: true });
    appendFileSync(
      join(mapDir, `${safeMapFileName(ipcName)}.jsonl`),
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
  } catch (error) {
    process.stderr.write(`[codex-title-wrapper] session map write failed: ${error?.message ?? error}\n`);
  }

  void postSessionHistory(record);
}

async function postSessionHistory(record) {
  if (process.env.IPC_CODEX_SESSION_MAP_POST_HUB === '0') return;
  if (typeof fetch !== 'function') return;
  const host = process.env.IPC_HUB_HOST || '127.0.0.1';
  const port = process.env.IPC_PORT || '3179';
  try {
    await fetch(`http://${host}:${port}/sessions/register-history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: record.name,
        sessionId: record.sessionId,
        runtime: 'codex',
        transcriptPath: record.transcriptPath,
        cwd: record.cwd,
        spawnAt: record.spawnAt,
      }),
    });
  } catch {}
}

function stopSessionMapPolling() {
  if (sessionMapTimer) {
    clearInterval(sessionMapTimer);
    sessionMapTimer = null;
  }
  if (sessionMapDeadlineTimer) {
    clearTimeout(sessionMapDeadlineTimer);
    sessionMapDeadlineTimer = null;
  }
}

function tryRecordSessionMap() {
  if (!ipcName || sessionMapRecordedId) return true;
  const session = resumeSessionId ? findCodexSessionById(resumeSessionId) : findCurrentCodexSession();
  if (!session) return false;
  recordIpcxSession(session);
  stopSessionMapPolling();
  return true;
}

function startSessionMapPolling() {
  if (!ipcName) return;
  if (tryRecordSessionMap()) return;
  sessionMapTimer = setInterval(() => {
    tryRecordSessionMap();
  }, Math.max(10, codexSessionMapPollMs));
  sessionMapTimer.unref?.();
  sessionMapDeadlineTimer = setTimeout(() => {
    stopSessionMapPolling();
  }, codexSessionMapTimeoutMs);
  sessionMapDeadlineTimer.unref?.();
}

child.onData((data) => {
  process.stdout.write(rewriteTitle(data));
});

child.onExit(({ exitCode }) => {
  exitOnce(exitCode ?? 0);
});

if (ipcName) {
  process.stdout.write(titleSequence(ipcName));
}
setTimeout(startSessionMapPolling, 25).unref?.();

async function processPtyBridgeQueueOnce() {
  if (!ipcName || ptyBridgeProcessing || exited) return;
  ptyBridgeProcessing = true;
  try {
    await processCodexPtyBridgeQueue(ipcName, {
      writePrompt: async (prompt) => child.write(prompt),
      submitDelayMs: codexPtySubmitDelayMs,
    });
  } catch (error) {
    process.stderr.write(`[codex-title-wrapper] pty bridge queue failed: ${error?.message ?? error}\n`);
  } finally {
    ptyBridgeProcessing = false;
  }
}

async function startPtyBridge() {
  if (!ipcName) return;
  try {
    const { paths } = await createCodexPtyBridgeReady(ipcName);
    ptyBridgeWatcher = watch(paths.queueDir, () => {
      void processPtyBridgeQueueOnce();
    });
    void processPtyBridgeQueueOnce();
    setInterval(() => {
      void createCodexPtyBridgeReady(ipcName).catch(() => {});
    }, 5000).unref();
    setInterval(() => {
      void processPtyBridgeQueueOnce();
    }, 500).unref();
  } catch (error) {
    process.stderr.write(`[codex-title-wrapper] pty bridge unavailable: ${error?.message ?? error}\n`);
  }
}

void startPtyBridge();

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  child.write(data);
});

process.stdout.on('resize', () => {
  child.resize(process.stdout.columns || 120, process.stdout.rows || 30);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopSessionMapPolling();
    try {
      ptyBridgeWatcher?.close?.();
    } catch {}
    try {
      child.kill();
    } catch {}
  });
}
