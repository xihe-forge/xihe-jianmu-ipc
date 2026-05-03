import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

export const DEFAULT_IDLE_PATROL_INTERVAL_MS = 3 * 60 * 1000;
export const DEFAULT_IDLE_THRESHOLD_MS = 3 * 60 * 1000;
export const DEFAULT_BAKED_GRACE_MS = 5 * 60 * 1000;
export const DEFAULT_ACK_GRACE_MS = 5 * 60 * 1000;
export const DEFAULT_OFFLINE_GRACE_MS = 30 * 60 * 1000;
export const DEFAULT_L1_DEDUP_MS = 30 * 60 * 1000;
export const DEFAULT_L2_AFTER_MS = 30 * 60 * 1000;
export const DEFAULT_L3_AFTER_MS = 90 * 60 * 1000;
export const DEFAULT_MAX_TRUSTED_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const ACTIONABLE_STATUSES = new Set(['pending', 'in_progress']);
const HOLD_PATTERN = /(等老板拍|等用户决策|blocker|hold for ack|待.+完成|等待|暂停|blocked|on hold)/i;
const DISPATCH_PATTERN = /(派|写|改|修|实施|ship|写完|做)/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.stryker-tmp', '.tmp', 'temp', 'tmp']);
const ACTION_TOOL_NAMES = new Set([
  'Edit',
  'Write',
  'Bash',
  'TaskUpdate',
  'mcp__ipc__ipc_send',
  'ScheduleWakeup',
]);

function encodeProjectPath(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  return cwd.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-');
}

function getClaudeDir(options = {}) {
  return options.claudeDir ?? process.env.CLAUDE_HOME ?? join(homedir(), '.claude');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeStateName(name) {
  return String(name ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function toTimestamp(value) {
  if (Number.isFinite(value)) return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function hasToolUseNamed(entry, name) {
  const parts = entry?.message?.content;
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => part?.type === 'tool_use' && part?.name === name);
}

function hasActionToolUse(entry) {
  const parts = entry?.message?.content;
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => part?.type === 'tool_use' && ACTION_TOOL_NAMES.has(String(part?.name ?? '')));
}

function loadJsonFile(path) {
  try {
    return safeJsonParse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function saveJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function getStatePath(stateDir, sessionName) {
  return join(stateDir, `escalation-state-${sanitizeStateName(sessionName)}.json`);
}

function loadEscalationState(stateDir, sessionName) {
  return loadJsonFile(getStatePath(stateDir, sessionName)) ?? {
    task_fingerprint: '',
    last_nudge_at: 0,
    nudge_count: 0,
    escalation_level: 0,
    last_action_at: 0,
  };
}

function saveEscalationState(stateDir, sessionName, state) {
  saveJsonFile(getStatePath(stateDir, sessionName), state);
}

function resetEscalationState(stateDir, sessionName, taskFingerprint, lastActionAt) {
  saveEscalationState(stateDir, sessionName, {
    task_fingerprint: taskFingerprint,
    last_nudge_at: 0,
    nudge_count: 0,
    escalation_level: 0,
    last_action_at: lastActionAt,
  });
}

export function resolveTaskDir(session, options = {}) {
  if (typeof session?.taskDir === 'string' && session.taskDir.trim() !== '') return session.taskDir;
  if (typeof session?.sessionId !== 'string' || session.sessionId.trim() === '') return null;
  return join(getClaudeDir(options), 'tasks', session.sessionId);
}

export function resolveTranscriptPath(session, options = {}) {
  if (typeof session?.transcriptPath === 'string' && session.transcriptPath.trim() !== '') {
    return session.transcriptPath;
  }
  if (typeof session?.sessionId !== 'string' || session.sessionId.trim() === '') return null;
  const projectDir = encodeProjectPath(session.cwd);
  if (!projectDir) return null;
  return join(getClaudeDir(options), 'projects', projectDir, `${session.sessionId}.jsonl`);
}

export function readTasksForSession(session, options = {}) {
  const taskDir = resolveTaskDir(session, options);
  if (!taskDir || !existsSync(taskDir)) return [];
  return readdirSync(taskDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => loadJsonFile(join(taskDir, entry.name)))
    .filter(Boolean);
}

export function getActionableTasks(tasks) {
  const unfinished = new Set(
    tasks.filter((task) => ACTIONABLE_STATUSES.has(String(task.status ?? '').toLowerCase()))
      .map((task) => String(task.id)),
  );
  return tasks.filter((task) => {
    const status = String(task.status ?? '').toLowerCase();
    if (!ACTIONABLE_STATUSES.has(status)) return false;
    const text = [
      task.subject,
      task.description,
      task.activeForm,
      task.reason,
      JSON.stringify(task.metadata ?? {}),
    ].filter(Boolean).join(' ');
    if (HOLD_PATTERN.test(text)) return false;
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    if (blockedBy.some((id) => unfinished.has(String(id)))) return false;
    const eta = toTimestamp(task.eta ?? task.eta_at ?? task.notBefore ?? task.not_before);
    if (eta && eta > Date.now()) return false;
    return true;
  });
}

export function analyzeTranscript(session, options = {}) {
  const path = resolveTranscriptPath(session, options);
  if (!path || !existsSync(path)) {
    return {
      path,
      mtimeMs: 0,
      lastUserText: '',
      lastUserAt: 0,
      lastToolUseAt: 0,
      hasScheduleWakeup: false,
      lastStopReason: null,
      baked: false,
    };
  }

  const text = readFileSync(path, 'utf8');
  const stat = statSync(path);
  const entries = text.trim().split(/\r?\n/).slice(-120).map(safeJsonParse).filter(Boolean);
  let lastUserIndex = -1;
  let lastUserText = '';
  let lastUserAt = 0;
  let lastToolUseAt = 0;
  let hasScheduleWakeup = false;
  let lastStopReason = null;

  entries.forEach((entry, index) => {
    const ts = toTimestamp(entry.timestamp) ?? 0;
    if (entry.type === 'user' || entry.message?.role === 'user') {
      const content = entry.message?.content;
      if (Array.isArray(content) && content.every((part) => part?.type === 'tool_result')) return;
      const text = contentToText(entry.message?.content).trim();
      if (text === '') return;
      lastUserIndex = index;
      lastUserText = text;
      lastUserAt = ts;
    }
  });

  const afterUser = lastUserIndex >= 0 ? entries.slice(lastUserIndex + 1) : entries;
  for (const entry of afterUser) {
    const ts = toTimestamp(entry.timestamp) ?? 0;
    if (hasActionToolUse(entry)) lastToolUseAt = Math.max(lastToolUseAt, ts);
    if (hasToolUseNamed(entry, 'ScheduleWakeup')) hasScheduleWakeup = true;
    if (entry.message?.stop_reason !== undefined) lastStopReason = entry.message.stop_reason;
    if (entry.stop_reason !== undefined) lastStopReason = entry.stop_reason;
  }

  return {
    path,
    mtimeMs: stat.mtimeMs,
    lastUserText,
    lastUserAt,
    lastToolUseAt,
    hasScheduleWakeup,
    lastStopReason,
    baked: lastStopReason == null && Date.now() - stat.mtimeMs < (options.bakedGraceMs ?? DEFAULT_BAKED_GRACE_MS),
  };
}

export function getQuotaUsedPct(rateLimits) {
  const fiveHour = Number(rateLimits?.five_hour?.used_pct ?? rateLimits?.five_hour?.used_percentage);
  const sevenDay = Number(rateLimits?.seven_day?.used_pct ?? rateLimits?.seven_day?.used_percentage);
  return {
    fiveHour: Number.isFinite(fiveHour) ? fiveHour : null,
    sevenDay: Number.isFinite(sevenDay) ? sevenDay : null,
  };
}

function findRecentMtime(root, sinceMs, options = {}) {
  if (typeof root !== 'string' || root.trim() === '' || !existsSync(root)) return 0;
  const maxFiles = options.maxFiles ?? 2000;
  let scanned = 0;
  let latest = 0;
  const stack = [root];
  while (stack.length > 0 && scanned < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime >= sinceMs) latest = Math.max(latest, mtime);
      } catch {}
      if (scanned >= maxFiles) break;
    }
  }
  return latest;
}

function defaultResolveSessionGitPath(session, options = {}) {
  const candidates = [
    session?.gitPath,
    session?.worktreePath,
    resolveTaskDir(session, options),
    resolveTranscriptPath(session, options),
  ].filter((value) => typeof value === 'string' && value.trim() !== '');

  if (typeof session?.cwd === 'string' && session.cwd.trim() !== '' && typeof session?.name === 'string') {
    const cwdName = basename(session.cwd).toLowerCase();
    if (cwdName.includes(session.name.toLowerCase())) candidates.push(session.cwd);
  }

  return candidates.find((value) => existsSync(value)) ?? null;
}

function toGitPathspec(cwd, target) {
  if (typeof cwd !== 'string' || typeof target !== 'string') return null;
  const resolvedTarget = isAbsolute(target) ? target : join(cwd, target);
  const rel = relative(cwd, resolvedTarget);
  if (rel === '') return '.';
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function countRecentCommits(cwd, sinceMs, execFileSyncImpl = execFileSync, pathspec = null) {
  if (typeof cwd !== 'string' || cwd.trim() === '' || !existsSync(cwd)) return { count: 0, lastAt: 0 };
  const args = [
    'log',
    `--since=@${Math.floor(sinceMs / 1000)}`,
    '--pretty=%ct',
  ];
  if (pathspec) args.push('--', pathspec);
  try {
    const stdout = execFileSyncImpl('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const stamps = stdout.trim().split(/\s+/).filter(Boolean).map((value) => Number(value) * 1000);
    return { count: stamps.length, lastAt: stamps.length ? Math.max(...stamps) : 0 };
  } catch {
    return { count: 0, lastAt: 0 };
  }
}

function hasCodexProcessForSessionBrief(session, options = {}) {
  if (typeof options.hasCodexProcessForSessionBrief === 'function') {
    return options.hasCodexProcessForSessionBrief(session, options);
  }
  if (typeof options.hasCodexProcessForCwd === 'function') {
    return options.hasCodexProcessForCwd(session, options);
  }
  const briefPath = session?.briefPath ?? session?.brief_path ?? session?.taskBriefPath;
  if (typeof briefPath !== 'string' || briefPath.trim() === '') return false;
  try {
    const needle = briefPath.toLowerCase();
    const stdout = (options.execFileSync ?? execFileSync)('powershell', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'codex|claude' } | ForEach-Object { $_.CommandLine }",
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return stdout.toLowerCase().includes(needle);
  } catch {}
  return false;
}

async function fetchJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  if (!response || response.status < 200 || response.status >= 300) return null;
  return response.json();
}

async function fetchSessions({ fetchImpl, ipcPort, hubAuthToken }) {
  const headers = hubAuthToken ? { Authorization: `Bearer ${hubAuthToken}` } : {};
  const result = await fetchJson(fetchImpl, `http://127.0.0.1:${ipcPort}/sessions`, { headers });
  return Array.isArray(result) ? result : [];
}

async function fetchOutboundMessages(sessionName, { fetchImpl, ipcPort, hubAuthToken, sinceMs }) {
  const headers = hubAuthToken ? { Authorization: `Bearer ${hubAuthToken}` } : {};
  const params = new URLSearchParams({ from: sessionName, limit: '50' });
  const result = await fetchJson(fetchImpl, `http://127.0.0.1:${ipcPort}/outbound?${params.toString()}`, { headers });
  const list = Array.isArray(result) ? result : [];
  return list.filter((message) => (toTimestamp(message.ts ?? message.timestamp ?? message.created_at) ?? 0) >= sinceMs);
}

async function sendIpcMessage({ to, topic, content }, options) {
  if (typeof options.ipcSend === 'function') {
    await options.ipcSend({ to, topic, content, from: options.watchdogSessionName });
    return;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (options.hubAuthToken) headers.Authorization = `Bearer ${options.hubAuthToken}`;
  await options.fetchImpl(`http://127.0.0.1:${options.ipcPort}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: options.watchdogSessionName,
      to,
      topic,
      content,
    }),
  });
}

function taskFingerprint(tasks) {
  return tasks.map((task) => String(task.id)).sort((a, b) => a.localeCompare(b)).join(',');
}

function taskIds(tasks) {
  return tasks.map((task) => String(task.id));
}

function newestActionAt({ transcript, commitLastAt, outboundLastAt }) {
  return Math.max(
    transcript.lastUserAt ?? 0,
    transcript.lastToolUseAt ?? 0,
    commitLastAt ?? 0,
    outboundLastAt ?? 0,
  );
}

function buildNudge(level, sessionName, idleMinutes, ids) {
  const taskList = ids.join(',');
  if (level === 1) {
    return `[idle-patrol L1] ${sessionName} 你 ${idleMinutes}min 无工具调用 / 无 commit / 无 IPC outbound·actionable task: ${taskList}·是真 idle 还是 hold？hold 请 TaskUpdate 标 status + 写 reason。`;
  }
  if (level === 2) {
    return `[idle-patrol L2 escalate] ${sessionName} 第 2 次敦促·距 L1 已 30min·仍未干活·actionable task: ${taskList}·harness 请关注。`;
  }
  return `[idle-patrol L3 失能] ${sessionName} 第 3 次敦促·距 L1 已 90min·session 可能失能·建议老板介入或 ipc_spawn 重启 lineage。`;
}

export async function evaluateIdlePatrolSession(session, options = {}) {
  const nowMs = options.now();
  const sessionName = session.name ?? session.label ?? 'unknown';
  const stateDir = options.stateDir;

  if (session.frozen === true || session.dormant === true || /^(frozen|dormant)$/i.test(String(session.status ?? session.charterStatus ?? ''))) {
    resetEscalationState(stateDir, sessionName, '', nowMs);
    return { session: sessionName, action: 'skip', reason: 'frozen-dormant' };
  }

  const connectedAt = Number(session.connectedAt);
  if (!Number.isFinite(connectedAt) || (session.connected === false && nowMs - connectedAt >= options.offlineGraceMs)) {
    return { session: sessionName, action: 'skip', reason: 'offline > 30min' };
  }

  const quota = getQuotaUsedPct(session.rateLimits);
  if ((quota.fiveHour ?? 0) >= 95 || (quota.sevenDay ?? 0) >= 95) {
    return { session: sessionName, action: 'skip', reason: 'quota-exhausted' };
  }

  const tasks = options.readTasksForSession(session, options);
  const actionable = options.getActionableTasks(tasks);
  const fingerprint = taskFingerprint(actionable);
  if (actionable.length === 0) {
    resetEscalationState(stateDir, sessionName, fingerprint, nowMs);
    return { session: sessionName, action: 'skip', reason: 'no-actionable-tasks' };
  }

  const transcript = options.analyzeTranscript(session, options);
  if (transcript.baked) return { session: sessionName, action: 'skip', reason: 'baked' };
  if (transcript.hasScheduleWakeup) return { session: sessionName, action: 'skip', reason: 'schedule-wakeup' };
  if (hasCodexProcessForSessionBrief(session, options)) return { session: sessionName, action: 'skip', reason: 'codex-bg' };

  const sinceMs = nowMs - options.idleThresholdMs;
  const outbound = await options.fetchOutboundMessages(sessionName, { ...options, sinceMs });
  const outboundLastAt = Math.max(0, ...outbound.map((message) => toTimestamp(message.ts ?? message.timestamp ?? message.created_at) ?? 0));
  if (outbound.length > 0 && nowMs - outboundLastAt < options.ackGraceMs) {
    return { session: sessionName, action: 'skip', reason: 'ipc-ack-grace' };
  }

  const sessionGitPath = options.resolveSessionGitPath(session, options);
  const gitPathspec = toGitPathspec(session.cwd, sessionGitPath);
  const commits = gitPathspec
    ? options.countRecentCommits(session.cwd, sinceMs, options.execFileSync, gitPathspec)
    : { count: 0, lastAt: 0 };
  const actionAt = newestActionAt({
    transcript,
    commitLastAt: commits.lastAt,
    outboundLastAt,
  });
  const idleAgeMs = nowMs - actionAt;
  if (!Number.isFinite(actionAt) || actionAt <= 0 || idleAgeMs < 0 || idleAgeMs > options.maxTrustedIdleMs) {
    return { session: sessionName, action: 'skip', reason: 'untrusted-action-time', actionAt };
  }
  const state = loadEscalationState(stateDir, sessionName);
  if (state.task_fingerprint !== fingerprint || actionAt > (Number(state.last_action_at) || 0)) {
    resetEscalationState(stateDir, sessionName, fingerprint, actionAt);
    state.task_fingerprint = fingerprint;
    state.last_nudge_at = 0;
    state.nudge_count = 0;
    state.escalation_level = 0;
    state.last_action_at = actionAt;
  }

  if (idleAgeMs < options.idleThresholdMs) {
    return { session: sessionName, action: 'skip', reason: 'recent-action', actionAt };
  }

  const hasDispatch = DISPATCH_PATTERN.test(transcript.lastUserText);
  if (!hasDispatch && actionable.length === 0) {
    return { session: sessionName, action: 'skip', reason: 'no-dispatch-signal' };
  }

  const currentLevel = Number(state.escalation_level) || 0;
  const lastNudgeAt = Number(state.last_nudge_at) || 0;
  let nextLevel = 0;
  if (currentLevel <= 0) nextLevel = 1;
  else if (currentLevel === 1 && nowMs - lastNudgeAt >= options.l2AfterMs) nextLevel = 2;
  else if (currentLevel === 2 && nowMs - lastNudgeAt >= options.l3AfterMs - options.l2AfterMs) nextLevel = 3;

  if (nextLevel === 0 || (currentLevel === 1 && nowMs - lastNudgeAt < options.l1DedupMs)) {
    return { session: sessionName, action: 'skip', reason: 'dedup', level: currentLevel };
  }

  const ids = taskIds(actionable);
  const idleMinutes = Math.max(0, Math.floor(idleAgeMs / 60_000));
  const content = buildNudge(nextLevel, sessionName, idleMinutes, ids);
  const to = nextLevel === 3 ? options.bossSessionName : sessionName;
  await sendIpcMessage({ to, topic: 'idle-patrol', content }, options);
  if (nextLevel === 2) {
    await sendIpcMessage({ to: options.harnessSessionName, topic: 'idle-patrol', content }, options);
  }

  saveEscalationState(stateDir, sessionName, {
    task_fingerprint: fingerprint,
    last_nudge_at: nowMs,
    nudge_count: nextLevel,
    escalation_level: nextLevel,
    last_action_at: actionAt,
  });

  return { session: sessionName, action: 'nudge', level: nextLevel, taskIds: ids, content };
}

export function createIdlePatrol(userOptions = {}) {
  const options = {
    ipcPort: 3179,
    hubAuthToken: '',
    watchdogSessionName: 'network-watchdog',
    harnessSessionName: 'harness',
    bossSessionName: 'boss',
    fetchImpl: globalThis.fetch,
    now: Date.now,
    stateDir: join(process.cwd(), 'data', 'watchdog', 'idle-patrol'),
    idleThresholdMs: DEFAULT_IDLE_THRESHOLD_MS,
    bakedGraceMs: DEFAULT_BAKED_GRACE_MS,
    ackGraceMs: DEFAULT_ACK_GRACE_MS,
    offlineGraceMs: DEFAULT_OFFLINE_GRACE_MS,
    l1DedupMs: DEFAULT_L1_DEDUP_MS,
    l2AfterMs: DEFAULT_L2_AFTER_MS,
    l3AfterMs: DEFAULT_L3_AFTER_MS,
    maxTrustedIdleMs: DEFAULT_MAX_TRUSTED_IDLE_MS,
    readTasksForSession,
    getActionableTasks,
    analyzeTranscript,
    fetchOutboundMessages,
    findRecentMtime,
    resolveSessionGitPath: defaultResolveSessionGitPath,
    countRecentCommits,
    execFileSync,
    stderr: (...args) => process.stderr.write(`${args.join(' ')}\n`),
    expectedSessionCount: Number(process.env.WATCHDOG_EXPECTED_SESSION_COUNT || 0),
    ...userOptions,
  };

  async function reconcileSessionCount() {
    const liveSessions = await fetchSessions(options);
    const expected = Number(options.expectedSessionCount);
    if (Number.isFinite(expected) && expected > 0 && Math.abs(liveSessions.length - expected) >= 2) {
      options.stderr(`[idle-patrol] warning: Hub /sessions connected=${liveSessions.length}, expected=${expected}; continuing patrol`);
    }
    return liveSessions;
  }

  async function tick() {
    const liveSessions = await reconcileSessionCount();
    const sessions = Array.isArray(options.sessions)
      ? options.sessions
      : liveSessions;
    const results = [];
    for (const session of sessions) {
      try {
        results.push(await evaluateIdlePatrolSession(session, options));
      } catch (error) {
        options.stderr(`[idle-patrol] session=${session?.name ?? '?'} failed: ${error?.message ?? error}`);
        results.push({ session: session?.name ?? '?', action: 'error', error: error?.message ?? String(error) });
      }
    }
    return results;
  }

  return { tick };
}

export function getTranscriptBasename(session, options = {}) {
  const path = resolveTranscriptPath(session, options);
  return path ? basename(path) : null;
}
