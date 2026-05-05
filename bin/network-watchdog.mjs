import http from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const DEDUP_STATE_FILE = process.env.WATCHDOG_DEDUP_STATE_PATH
  || join(tmpdir(), 'jianmu-ipc-watchdog-dedup.json');

function loadDedupState() {
  try {
    const raw = readFileSync(DEDUP_STATE_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)).map(([k, v]) => [k, Number(v)]));
  } catch { return new Map(); }
}

function saveDedupState(map) {
  try {
    mkdirSync(dirname(DEDUP_STATE_FILE), { recursive: true });
    writeFileSync(DEDUP_STATE_FILE, JSON.stringify(Object.fromEntries(map)), 'utf8');
  } catch {}
}
import WebSocket from 'ws';
import { createRegisterMessage, resolveContextUsagePct } from '../lib/protocol.mjs';
import { createWakeCooldown } from '../lib/wake-cooldown.mjs';
import { createStateMachine } from '../lib/network-state.mjs';
import { createHarnessStateMachine } from '../lib/harness-state.mjs';
import { probeHarnessHeartbeat } from '../lib/harness-heartbeat.mjs';
import {
  DEFAULT_CHECKPOINT_PATH,
  DEFAULT_HANDOVER_REPO_PATH,
  DEFAULT_LAST_BREATH_PATH,
  DEFAULT_STATUS_PATH,
  triggerHarnessSelfHandover,
} from '../lib/harness-handover.mjs';
import { createLineageTracker } from '../lib/lineage.mjs';
import { isLoopbackAddress, loadInternalToken } from '../lib/internal-auth.mjs';
import {
  probeAnthropic,
  probeAvailableRamMb,
  probeCpuUsedPct,
  probeCliProxy,
  probeCommittedPct,
  probeDns,
  probeDiskUsedPct,
  probeHub,
  probeOrphanGitProcesses,
} from '../lib/network-probes.mjs';
import { createStuckSessionDetector } from '../lib/stuck-session-detector.mjs';
import {
  createZombiePidDetector,
  isPidAlive,
  ZOMBIE_PID_TICK_INTERVAL_MS_DEFAULT,
} from '../lib/zombie-pid-detector.mjs';
import {
  createAtomicHandoverTrigger,
  createContextUsageAutoHandover,
  createMinimalTaskUnitCompleteChecker,
  hasInFlightCodexTask,
  isGitTreeClean,
} from '../lib/context-usage-auto-handover.mjs';
import { getSessionState } from '../lib/session-state-reader.mjs';
import {
  getWakeRecord,
  listSuspendedSessions,
  recordSessionSpawn,
  suspendSession,
  upsertWakeRecord,
} from '../lib/db.mjs';
import {
  createIdlePatrol,
  DEFAULT_IDLE_PATROL_INTERVAL_MS,
} from '../lib/watchdog/idle-patrol.mjs';
import {
  DEFAULT_ORPHAN_GIT_REAPER_INTERVAL_MS,
  getOrphanGitReaperStatus,
  runOrphanGitReaper,
} from '../lib/watchdog/orphan-git-reaper.mjs';

export const DEFAULT_IPC_PORT = 3179;
export const DEFAULT_WATCHDOG_PORT = 3180;
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;
export const DEFAULT_WATCHDOG_COLD_START_GRACE_MS = 120_000;
export const WATCHDOG_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
export const WATCHDOG_HOST = '127.0.0.1';
export const WATCHDOG_SESSION_NAME = 'network-watchdog';
export const HARNESS_SESSION_NAME = 'harness';
export const FALLBACK_STORM_LOG = join(process.cwd(), 'reports', 'cron-巡视', 'fallback-storm.log');
export const HARNESS_HEARTBEAT_TOPIC = 'harness-heartbeat';
export const HARNESS_HEARTBEAT_PATTERN = /【harness\s+(.+?)\s+·\s+context-pct】(\d+)% \| state=(\w+) \| next_action=(\S+)/;
export const WATCHDOG_WS_RECONNECT_DELAY_MS = 3_000;
export const COMMIT_WARN_PCT = 90;
export const COMMIT_CRIT_PCT = 95;
export const COMMIT_DEDUP_MS = 5 * 60 * 1000;
export const AVAILABLE_RAM_WARN_MB = 10000;
export const AVAILABLE_RAM_CRIT_MB = 5000;
export const PHYS_RAM_TREE_KILL_AVAILABLE_MB = 3000;
export const PHYS_RAM_TREE_KILL_DEDUP_MS = 5 * 60 * 1000;
export const AVAILABLE_RAM_DEDUP_MS = 5 * 60 * 1000;
export const PHYS_RAM_WARN_PCT = 80;
export const PHYS_RAM_CRIT_PCT = 90;
export const PHYS_RAM_RESET_PCT = 70;
export const PHYS_RAM_DEDUP_MS = 5 * 60 * 1000;
export const CPU_WARN_PCT = 80;
export const DISK_WARN_PCT = 80;
export const CPU_DEDUP_MS = 30 * 60 * 1000;
export const DISK_DEDUP_MS = 30 * 60 * 1000;
export const ORPHAN_GIT_AGE_MS = 5 * 60 * 1000;
export const ORPHAN_GIT_DEDUP_MS = 30 * 60 * 1000;
export const ORPHAN_GIT_COUNT_WARN = 3;
export const DEFAULT_HANDOVER_THRESHOLD = 50;
export const RATE_LIMIT_WARN_FIVE_HOUR = 95;
export const RATE_LIMIT_WARN_SEVEN_DAY = 95;
export const RATE_LIMIT_CRITIQUE_DEDUP_MS = 30 * 60 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePercentThreshold(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

function createWait(waitImpl, setTimeoutImpl) {
  if (typeof waitImpl === 'function') {
    return waitImpl;
  }

  return (delayMs) => new Promise((resolveWait) => {
    setTimeoutImpl(resolveWait, delayMs);
  });
}

function isSuccessfulResponse(response) {
  return Number.isFinite(response?.status)
    && response.status >= 200
    && response.status < 300;
}

function toErrorMessage(error) {
  return error?.message ?? String(error);
}

function normalizePhysRamError(error) {
  if (!error) {
    return 'unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error.name === 'AbortError' || error.code === 'ETIMEDOUT') {
    return 'timeout';
  }
  return toErrorMessage(error);
}

function runWithPhysRamTimeout(runner, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve().then(runner);
  }

  let timer = null;
  return Promise.race([
    Promise.resolve().then(runner),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`timeout after ${timeoutMs}ms`);
        error.code = 'ETIMEDOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function sampleWindowsPhysRam() {
  return new Promise((resolveSample, rejectSample) => {
    const child = spawn('pwsh', [
      '-NoProfile',
      '-Command',
      "$ErrorActionPreference='Stop'; $total=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; $avail=(Get-Counter '\\Memory\\Available MBytes' -EA Stop).CounterSamples[0].CookedValue; [pscustomobject]@{available_mb=$avail;total_mb=($total/1MB)} | ConvertTo-Json -Compress",
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      if (code !== 0) {
        rejectSample(new Error(`phys_ram_used_pct sample exit ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolveSample(JSON.parse(stdout.trim()));
      } catch {
        rejectSample(new Error(`invalid phys_ram_used_pct sample: ${stdout.trim()}`));
      }
    });
    child.on('error', rejectSample);
  });
}

async function defaultSamplePhysRam() {
  if (process.platform === 'win32') {
    return sampleWindowsPhysRam();
  }
  return null;
}

export async function probeAvailableRamPct({
  sample = defaultSamplePhysRam,
  now = Date.now,
  timeoutMs = 5000,
} = {}) {
  try {
    const result = await runWithPhysRamTimeout(() => sample(), timeoutMs);
    if (!result) {
      return { ok: false, error: 'unsupported platform' };
    }

    const availableMb = Number(result.available_mb);
    const totalMb = Number(result.total_mb);
    if (!Number.isFinite(availableMb) || !Number.isFinite(totalMb) || totalMb <= 0) {
      return { ok: false, error: 'invalid phys ram sample' };
    }

    return {
      ok: true,
      pct: Math.round((1 - availableMb / totalMb) * 1000) / 10,
      available_mb: availableMb,
      total_mb: totalMb,
      timestamp: now(),
    };
  } catch (error) {
    return { ok: false, error: normalizePhysRamError(error) };
  }
}

function normalizeMaybeFunction(value) {
  return typeof value === 'function' ? value() : value;
}

function isHeldByColdStartGrace(reason) {
  return typeof reason === 'string' && reason.startsWith('held-by-grace');
}

function buildHubUrl(ipcPort) {
  return `http://127.0.0.1:${ipcPort}`;
}

function buildHubWsUrl({ ipcPort, sessionName, hubAuthToken }) {
  const url = new URL(`ws://127.0.0.1:${ipcPort}/ws`);
  url.searchParams.set('name', sessionName);
  if (typeof hubAuthToken === 'string' && hubAuthToken.trim() !== '') {
    url.searchParams.set('token', hubAuthToken);
  }
  return url.toString();
}

function readTranscriptTail(path, lines = 20) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function mapHarnessTransitionToHandoverReason(reason) {
  if (reason === 'hard-signal' || reason === 'context-critical-no-action') {
    return 'threshold_65';
  }
  if (reason === 'warn-without-compact' || reason === 'context-warn') {
    return 'threshold_55';
  }
  if (reason === 'ws-down-grace-exceeded') {
    return 'crash_recovery';
  }
  return 'manual';
}

async function loadDefaultIpcSpawn() {
  const module = await import('../mcp-server.mjs');
  return module.spawnSession;
}

export function parseHarnessHeartbeatContent(content) {
  if (typeof content !== 'string') {
    return null;
  }

  const match = content.match(HARNESS_HEARTBEAT_PATTERN);
  if (!match) {
    return null;
  }

  const [, isoTs, pctText, state, nextAction] = match;
  const pct = Number.parseInt(pctText, 10);
  if (!Number.isFinite(pct)) {
    return null;
  }

  const parsedTs = Date.parse(isoTs);

  return {
    ts: Number.isNaN(parsedTs) ? Number.NaN : parsedTs,
    tsIso: isoTs,
    pct,
    state,
    nextAction,
  };
}

async function postInternalNetworkEvent({
  body,
  ipcPort,
  internalToken,
  fetchImpl,
  stderr,
  wait,
}) {
  const url = `${buildHubUrl(ipcPort)}/internal/network-event`;
  let lastError = null;

  for (let attempt = 0; attempt <= WATCHDOG_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': internalToken,
        },
        body: JSON.stringify(body),
      });

      if (isSuccessfulResponse(response)) {
        return true;
      }

      lastError = new Error(`HTTP ${response?.status ?? 'unknown'}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < WATCHDOG_RETRY_DELAYS_MS.length) {
      await wait(WATCHDOG_RETRY_DELAYS_MS[attempt]);
    }
  }

  stderr(
    `[network-watchdog] failed to POST /internal/network-event after ${WATCHDOG_RETRY_DELAYS_MS.length + 1} attempt(s): ${lastError?.message ?? lastError}`,
  );
  return false;
}

export function createDefaultWatchdogProbes({
  ipcPort = DEFAULT_IPC_PORT,
  timeoutMs = 5000,
  harnessProbeConfig = {},
} = {}) {
  const nowImpl = harnessProbeConfig.now ?? Date.now;
  let lastSeenOnlineAt = normalizeMaybeFunction(harnessProbeConfig.lastSeenOnlineAt);
  if (!Number.isFinite(lastSeenOnlineAt)) {
    lastSeenOnlineAt = null;
  }

  const harnessProbe = () => probeHarnessHeartbeat({
    hubUrl: harnessProbeConfig.hubUrl ?? buildHubUrl(ipcPort),
    timeoutMs: harnessProbeConfig.timeoutMs,
    wsDisconnectGraceMs: harnessProbeConfig.wsDisconnectGraceMs ?? 60 * 1000,
    lastSeenOnlineAt,
    sessionName: harnessProbeConfig.sessionName,
    authToken: harnessProbeConfig.authToken ?? process.env.IPC_AUTH_TOKEN ?? null,
    fetchImpl: harnessProbeConfig.fetchImpl,
    now: nowImpl,
  });
  harnessProbe.onProbeResult = (result) => {
    if (result?.ok && result?.connected === true) {
      lastSeenOnlineAt = nowImpl();
    }
    if (typeof harnessProbeConfig.onProbeResult === 'function') {
      harnessProbeConfig.onProbeResult(result);
    }
  };

  return {
    cliProxy: () => probeCliProxy(),
    hub: () => probeHub({ port: ipcPort }),
    anthropic: () => probeAnthropic(),
    dns: () => probeDns(),
    committed_pct: () => probeCommittedPct({ timeoutMs }),
    available_ram_mb: () => probeAvailableRamMb({ timeoutMs }),
    phys_ram_used_pct: () => probeAvailableRamPct({ timeoutMs }),
    cpu_used_pct: () => probeCpuUsedPct({ timeoutMs }),
    disk_used_pct: () => probeDiskUsedPct({ timeoutMs }),
    orphan_git: () => probeOrphanGitProcesses({ timeoutMs, minAgeMs: ORPHAN_GIT_AGE_MS }),
    harness: harnessProbe,
  };
}

export function invokeTreeKill({
  dryRun = false,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolveTreeKill, rejectTreeKill) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'D:/workspace/ai/research/xiheAi/xihe-tianshu-harness/tools/session-guard.ps1',
      '-Action',
      'tree-kill',
      '-ExcludePattern',
      '(?i)claude|anthropic|session-guard|codex|openai',
    ];
    if (dryRun) {
      args.push('-DryRun');
    }

    const child = spawnImpl('pwsh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      if (code !== 0) {
        rejectTreeKill(new Error(`session-guard exit ${code}: ${stderr}`));
        return;
      }
      try {
        resolveTreeKill(JSON.parse(stdout));
      } catch {
        rejectTreeKill(new Error(`session-guard JSON parse fail: ${stdout}`));
      }
    });
    child.on('error', rejectTreeKill);
  });
}

export function handleCommittedPct(result, {
  ipcSend = null,
  spawnImpl = spawn,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  lastCommitAction = { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY },
} = {}) {
  void ipcSend;
  void spawnImpl;
  void now;
  void stderr;
  void lastCommitAction;
  return false;
}

function triggerPhysicalRamTreeKill({ metric, value }, {
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  spawnImpl = spawn,
  lastPhysRamTreeKillAction = { CRIT: Number.NEGATIVE_INFINITY },
} = {}) {
  const nowTs = now();
  if (nowTs - lastPhysRamTreeKillAction.CRIT < PHYS_RAM_TREE_KILL_DEDUP_MS) {
    return false;
  }

  lastPhysRamTreeKillAction.CRIT = nowTs;
  void invokeTreeKill({ pct: value, dryRun: false, spawnImpl })
    .then((json) => {
      stderr(`[watchdog] ${metric} CRIT ${value} -> tree-kill suspects=${json?.suspects_found ?? '?'} killed=${json?.killed?.length ?? 0} aborted_reason=${json?.aborted_reason ?? 'none'}`);
    })
    .catch((error) => {
      stderr(`[watchdog] ${metric} CRIT ${value} -> tree-kill FAILED: ${toErrorMessage(error)}`);
    });
  return true;
}

export function handleAvailableRamMb(result, {
  ipcSend = null,
  alertComputerWorkerImpl = alertComputerWorker,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  lastAvailableRamAction = { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY },
  spawnImpl = spawn,
  lastPhysRamTreeKillAction = { CRIT: Number.NEGATIVE_INFINITY },
} = {}) {
  if (!result?.ok || !Number.isFinite(result.availableMb)) {
    return false;
  }

  const mb = result.availableMb;
  const nowTs = now();
  if (mb < PHYS_RAM_TREE_KILL_AVAILABLE_MB) {
    triggerPhysicalRamTreeKill({ metric: 'available_ram_mb', value: mb }, {
      now,
      stderr,
      spawnImpl,
      lastPhysRamTreeKillAction,
    });
  }
  if (mb < AVAILABLE_RAM_CRIT_MB) {
    if (nowTs - lastAvailableRamAction.CRIT < AVAILABLE_RAM_DEDUP_MS) {
      return false;
    }
    lastAvailableRamAction.CRIT = nowTs;
    void Promise.resolve(ipcSend?.({
      to: '*',
      topic: 'critique',
      content: `🚨 available_ram_mb=${mb.toFixed(0)} 破 5GB 临界。立即：kill 正在跑的 Stryker/cargo mutants / 停 pnpm test 新启动 / 轻量工作（docs/git/IPC）照常干`,
    })).catch((error) => {
      stderr(`[watchdog] available_ram_mb CRIT ${mb}MB -> broadcast FAILED: ${toErrorMessage(error)}`);
    });
    alertComputerWorkerImpl('⚠️ 内存超 80%·建议排查', { ipcSend, stderr });
    return true;
  }

  if (mb < AVAILABLE_RAM_WARN_MB) {
    if (nowTs - lastAvailableRamAction.WARN < AVAILABLE_RAM_DEDUP_MS) {
      return false;
    }
    lastAvailableRamAction.WARN = nowTs;
    void Promise.resolve(ipcSend?.({
      to: '*',
      topic: 'critique',
      content: `⚠️ available_ram_mb=${mb.toFixed(0)} 破 10GB 警戒。建议：降多 worker 测试频率 / 暂停新 Codex dispatch / 等 ~15min 观察回升`,
    })).catch((error) => {
      stderr(`[watchdog] available_ram_mb WARN ${mb}MB -> broadcast FAILED: ${toErrorMessage(error)}`);
    });
    alertComputerWorkerImpl('⚠️ 内存超 80%·建议排查', { ipcSend, stderr });
    return true;
  }

  return false;
}

function buildAuthJsonHeaders(hubAuthToken) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (typeof hubAuthToken === 'string' && hubAuthToken.trim() !== '') {
    headers.Authorization = `Bearer ${hubAuthToken}`;
  }
  return headers;
}

async function notifyOldSessionQuit({ name, fetchImpl, hubAuthToken, ipcPort, watchdogSessionName }) {
  const response = await fetchImpl(`${buildHubUrl(ipcPort)}/send`, {
    method: 'POST',
    headers: buildAuthJsonHeaders(hubAuthToken),
    body: JSON.stringify({
      from: watchdogSessionName,
      to: name,
      topic: 'atomic-handoff',
      content: 'atomic-handoff-quit',
    }),
  });
  return {
    ok: isSuccessfulResponse(response),
    status: response.status,
    ...(typeof response.json === 'function' ? await response.json() : {}),
  };
}

export function createWakeReaper({
  fetchHealth,
  recentAnthropicProbes,
  postWakeSuspended,
  now = Date.now,
  cooldownMs = 5 * 60 * 1000,
  requiredConsecutiveOk = 3,
  tickIntervalMs = 0,
  initialLastTickAt = null,
  cooldown = null,
}) {
  let lastTriggerAt = null;
  let lastTickAt = Number.isFinite(initialLastTickAt) ? initialLastTickAt : null;

  return {
    async tick() {
      if (lastTickAt !== null && now() - lastTickAt < tickIntervalMs) {
        return { triggered: false, reason: 'not-due' };
      }
      lastTickAt = now();

      if (lastTriggerAt !== null && now() - lastTriggerAt < cooldownMs) {
        return { triggered: false, reason: 'cooldown' };
      }

      const recent = (recentAnthropicProbes() || []).slice(-requiredConsecutiveOk);
      if (recent.length < requiredConsecutiveOk || recent.some((probe) => !probe?.ok)) {
        return { triggered: false, reason: 'anthropic-not-stable' };
      }

      const health = await fetchHealth().catch(() => null);
      const suspended = Array.isArray(health?.suspended_sessions) ? health.suspended_sessions : [];
      if (suspended.length === 0) {
        return { triggered: false, reason: 'no-suspended' };
      }

      const records = suspended.map((session) => (typeof session === 'string' ? { name: session, reason: null } : session));
      const eligible = records.filter((session) => cooldown?.canWake ? cooldown.canWake(session.name) : true);
      if (eligible.length === 0) {
        return { triggered: false, reason: 'cooldown', skippedCount: records.length };
      }

      const reasons = [...new Set(eligible.map((session) => session.reason).filter(Boolean))];
      for (const reason of reasons.length > 0 ? reasons : [null]) {
        await postWakeSuspended({
          triggeredBy: 'watchdog-reaper',
          ...(reason ? { reason } : {}),
        }).catch(() => {});
      }
      for (const session of eligible) {
        cooldown?.recordWake?.(session.name);
      }
      lastTriggerAt = now();
      return { triggered: true, suspendedCount: eligible.length };
    },
  };
}

export function alertComputerWorker(content = '⚠️ CPU/磁盘 超 80%·建议排查', {
  ipcSend = null,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
} = {}) {
  if (typeof ipcSend !== 'function') {
    return false;
  }

  void Promise.resolve(ipcSend({
    to: 'computer-worker',
    topic: 'critique',
    content,
  })).catch((error) => {
    stderr(`[watchdog] computer-worker alert failed: ${toErrorMessage(error)}`);
  });
  return true;
}

export function handleAvailableRamPct(check, {
  ipcSend = null,
  alertComputerWorkerImpl = alertComputerWorker,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  lastPhysRamAction = { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY },
  spawnImpl = spawn,
  lastPhysRamTreeKillAction = { CRIT: Number.NEGATIVE_INFINITY },
} = {}) {
  if (check?.ok !== true || !Number.isFinite(check.pct)) {
    return null;
  }

  const pct = check.pct;
  if (pct < PHYS_RAM_RESET_PCT) {
    lastPhysRamAction.WARN = Number.NEGATIVE_INFINITY;
    lastPhysRamAction.CRIT = Number.NEGATIVE_INFINITY;
    return null;
  }

  const nowTs = now();
  let level = null;
  let threshold = null;
  let content = null;
  if (pct >= PHYS_RAM_CRIT_PCT) {
    level = 'CRIT';
    threshold = PHYS_RAM_CRIT_PCT;
    content = `[watchdog] system phys_ram_used_pct ${pct.toFixed(1)}% 破 90% CRIT · watchdog 将按真实物理内存触发 tree-kill`;
    triggerPhysicalRamTreeKill({ metric: 'phys_ram_used_pct', value: pct }, {
      now,
      stderr,
      spawnImpl,
      lastPhysRamTreeKillAction,
    });
  } else if (pct >= PHYS_RAM_WARN_PCT) {
    level = 'WARN';
    threshold = PHYS_RAM_WARN_PCT;
    content = `[watchdog] system phys_ram_used_pct ${pct.toFixed(1)}% 破 80% WARN（90% CRIT 将按真实物理内存触发 tree-kill）`;
  } else {
    return null;
  }

  if (nowTs - lastPhysRamAction[level] < PHYS_RAM_DEDUP_MS) {
    return null;
  }

  lastPhysRamAction[level] = nowTs;
  void Promise.resolve(ipcSend?.({
    to: '*',
    topic: 'critique',
    content,
  })).catch((error) => {
    stderr(`[watchdog] phys_ram_used_pct ${level} ${pct}% >= ${threshold}% -> broadcast FAILED: ${toErrorMessage(error)}`);
  });
  alertComputerWorkerImpl('⚠️ 内存超 80%·建议排查', { ipcSend, stderr });
  return level;
}

export function handleCpuUsedPct(check, {
  ipcSend = null,
  alertComputerWorkerImpl = alertComputerWorker,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  lastCpuAction = { WARN: Number.NEGATIVE_INFINITY },
} = {}) {
  if (check?.ok !== true || !Number.isFinite(check.pct) || check.pct < CPU_WARN_PCT) {
    return false;
  }

  const nowTs = now();
  if (nowTs - lastCpuAction.WARN < CPU_DEDUP_MS) {
    return false;
  }

  lastCpuAction.WARN = nowTs;
  const content = `[watchdog] system cpu_used_pct ${check.pct.toFixed(1)}% 破 80% WARN`;
  void Promise.resolve(ipcSend?.({
    to: '*',
    topic: 'critique',
    content,
  })).catch((error) => {
    stderr(`[watchdog] cpu_used_pct WARN ${check.pct}% >= ${CPU_WARN_PCT}% -> broadcast FAILED: ${toErrorMessage(error)}`);
  });
  alertComputerWorkerImpl('⚠️ CPU/磁盘 超 80%·建议排查', { ipcSend, stderr });
  return true;
}

export function handleDiskUsedPct(check, {
  ipcSend = null,
  alertComputerWorkerImpl = alertComputerWorker,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  lastDiskAction = { WARN: Number.NEGATIVE_INFINITY },
} = {}) {
  if (check?.ok !== true || !Number.isFinite(check.maxUsedPct) || check.maxUsedPct < DISK_WARN_PCT) {
    return false;
  }

  const nowTs = now();
  if (nowTs - lastDiskAction.WARN < DISK_DEDUP_MS) {
    return false;
  }

  lastDiskAction.WARN = nowTs;
  const hottest = Array.isArray(check.drives)
    ? check.drives.find((drive) => drive?.usedPct === check.maxUsedPct)
    : null;
  const driveLabel = hottest?.drive ? ` ${hottest.drive}` : '';
  const content = `[watchdog] system disk_used_pct${driveLabel} ${check.maxUsedPct.toFixed(1)}% 破 80% WARN`;
  void Promise.resolve(ipcSend?.({
    to: '*',
    topic: 'critique',
    content,
  })).catch((error) => {
    stderr(`[watchdog] disk_used_pct WARN ${check.maxUsedPct}% >= ${DISK_WARN_PCT}% -> broadcast FAILED: ${toErrorMessage(error)}`);
  });
  alertComputerWorkerImpl('⚠️ CPU/磁盘 超 80%·建议排查', { ipcSend, stderr });
  return true;
}

export function handleOrphanGitProcesses(check, {
  ipcSend = null,
  alertComputerWorkerImpl = alertComputerWorker,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  lastOrphanGitAction = { WARN: Number.NEGATIVE_INFINITY },
} = {}) {
  if (!check?.ok || !Array.isArray(check.orphans) || check.orphans.length < ORPHAN_GIT_COUNT_WARN) {
    return false;
  }

  const nowTs = now();
  if (nowTs - lastOrphanGitAction.WARN < ORPHAN_GIT_DEDUP_MS) {
    return false;
  }

  lastOrphanGitAction.WARN = nowTs;
  const maxAgeMs = Number.isFinite(check.maxAgeMs)
    ? check.maxAgeMs
    : Math.max(...check.orphans.map((processInfo) => Number(processInfo.ageMs) || 0));
  const maxAgeMin = Math.max(0, Math.round(maxAgeMs / 60_000));
  const content = `⚠️ ${check.orphans.length} 个孤儿 git.exe 父进程已退·最长 age=${maxAgeMin}min·CPU 雪崩风险`;
  void Promise.resolve(ipcSend?.({
    to: '*',
    topic: 'critique',
    content,
  })).catch((error) => {
    stderr(`[watchdog] orphan_git WARN count=${check.orphans.length} maxAgeMs=${maxAgeMs} -> broadcast FAILED: ${toErrorMessage(error)}`);
  });
  alertComputerWorkerImpl(content, { ipcSend, stderr });
  return true;
}

function formatResetTime(resetsAt) {
  if (!Number.isFinite(Number(resetsAt))) {
    return 'unknown';
  }
  return new Date(Number(resetsAt) * 1000).toISOString();
}

export async function checkRateLimits(sessions, {
  ipcSend = null,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  lastRateLimitCritiqueAt = new Map(),
} = {}) {
  if (!Array.isArray(sessions) || typeof ipcSend !== 'function') {
    return [];
  }

  const nowTs = now();
  const critiques = [];
  const windows = [
    ['five_hour', RATE_LIMIT_WARN_FIVE_HOUR],
    ['seven_day', RATE_LIMIT_WARN_SEVEN_DAY],
  ];

  for (const session of sessions) {
    const name = typeof session?.name === 'string' && session.name.trim() ? session.name : null;
    if (!name) continue;
    for (const [windowName, threshold] of windows) {
      const window = session?.rateLimits?.[windowName];
      const pct = Number(window?.used_percentage);
      if (!Number.isFinite(pct) || pct < threshold) continue;
      const resetsAt = Number(window?.resets_at);
      if (Number.isFinite(resetsAt) && resetsAt * 1000 <= nowTs) continue;

      const dedupKey = `portfolio:${windowName}`;
      if (nowTs - (lastRateLimitCritiqueAt.get(dedupKey) ?? Number.NEGATIVE_INFINITY) < RATE_LIMIT_CRITIQUE_DEDUP_MS) {
        continue;
      }

      lastRateLimitCritiqueAt.set(dedupKey, nowTs);
      saveDedupState(lastRateLimitCritiqueAt);
      const content = `[rate-limit-critique] ${name} ${windowName} ${pct}% >= ${threshold}% · resets ${formatResetTime(window?.resets_at)}`;
      try {
        await ipcSend({ to: 'harness', topic: 'critique', content });
        critiques.push({ name, window: windowName, pct, threshold });
      } catch (error) {
        stderr(`[watchdog] rate_limit ${name} ${windowName} ${pct}% -> critique FAILED: ${toErrorMessage(error)}`);
      }
    }
  }

  return critiques;
}

export function createWatchdogIpcClient({
  ipcPort = DEFAULT_IPC_PORT,
  sessionName = WATCHDOG_SESSION_NAME,
  harnessSessionName = HARNESS_SESSION_NAME,
  harnessHeartbeatTopic = HARNESS_HEARTBEAT_TOPIC,
  hubAuthToken = process.env.IPC_AUTH_TOKEN ?? '',
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  wsImpl = WebSocket,
  onHarnessHeartbeat = null,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
} = {}) {
  let ws = null;
  let reconnectTimer = null;
  let stopped = false;

  function buildSendHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (typeof hubAuthToken === 'string' && hubAuthToken.trim() !== '') {
      headers.Authorization = `Bearer ${hubAuthToken}`;
    }
    return headers;
  }

  async function postSend(body, errorLabel) {
    try {
      const response = await fetchImpl(`${buildHubUrl(ipcPort)}/send`, {
        method: 'POST',
        headers: buildSendHeaders(),
        body: JSON.stringify(body),
      });
      return isSuccessfulResponse(response);
    } catch (error) {
      stderr(`[network-watchdog] ${errorLabel}: ${toErrorMessage(error)}`);
      return false;
    }
  }

  function handleInboundMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.topic === harnessHeartbeatTopic && typeof message.content === 'string') {
      const parsed = parseHarnessHeartbeatContent(message.content);
      if (parsed && typeof onHarnessHeartbeat === 'function') {
        onHarnessHeartbeat(parsed);
      }
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer != null) {
      return;
    }

    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, WATCHDOG_WS_RECONNECT_DELAY_MS);
  }

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message?.type === 'message') {
      handleInboundMessage(message);
      return;
    }

    if (message?.type === 'inbox' && Array.isArray(message.messages)) {
      for (const item of message.messages) {
        handleInboundMessage(item);
      }
    }
  }

  function connect() {
    if (stopped) {
      return;
    }

    let socket;
    try {
      socket = new wsImpl(buildHubWsUrl({ ipcPort, sessionName, hubAuthToken }));
    } catch (error) {
      stderr(`[network-watchdog] watchdog WS connect failed: ${toErrorMessage(error)}`);
      scheduleReconnect();
      return;
    }

    ws = socket;

    socket.on('open', () => {
      try {
        socket.send(JSON.stringify(createRegisterMessage({ name: sessionName, pid: process.pid })));
        socket.send(JSON.stringify({ type: 'subscribe', topic: harnessHeartbeatTopic }));
      } catch (error) {
        stderr(`[network-watchdog] watchdog WS subscribe failed: ${toErrorMessage(error)}`);
      }
    });

    socket.on('message', handleMessage);
    socket.on('close', () => {
      if (ws === socket) {
        ws = null;
      }
      scheduleReconnect();
    });
    socket.on('error', (error) => {
      stderr(`[network-watchdog] watchdog WS error: ${toErrorMessage(error)}`);
    });
  }

  async function sendMessage({ to, topic = null, content } = {}) {
    return postSend({
      from: sessionName,
      to,
      ...(topic == null ? {} : { topic }),
      content,
    }, 'watchdog message send failed');
  }

  return {
    async start() {
      stopped = false;
      connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer != null) {
        clearTimeoutImpl(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
    },
    sendMessage,
  };
}

function omitHarnessProbe(probes) {
  return Object.fromEntries(
    Object.entries(probes).filter(([name]) => ![
      'harness',
      'committed_pct',
      'available_ram_mb',
      'phys_ram_used_pct',
      'cpu_used_pct',
      'disk_used_pct',
      'orphan_git',
    ].includes(name)),
  );
}

function getSessionPendingOutgoingCount(sessionRecord) {
  for (const key of ['pendingOutgoing', 'pending_outgoing', 'pendingOutgoingCount', 'pending_outgoing_count']) {
    const count = Number(sessionRecord?.[key]);
    if (Number.isFinite(count) && count >= 0) return count;
  }
  return 0;
}

function getSessionCwd(sessionRecord, fallbackCwd) {
  const cwd = typeof sessionRecord?.cwd === 'string' ? sessionRecord.cwd.trim() : '';
  return cwd || fallbackCwd || process.cwd();
}

function getSessionContextUsagePct(sessionRecord) {
  return resolveContextUsagePct({
    contextWindow: sessionRecord?.contextWindow,
    contextUsagePct: sessionRecord?.contextUsagePct,
  });
}

export function createWatchdogStatusHandler({
  getSnapshot,
  getHarnessSnapshot = null,
  getUptime,
} = {}) {
  return function handleStatus(req, res) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const snapshot = getSnapshot();
      const harness = typeof getHarnessSnapshot === 'function'
        ? getHarnessSnapshot()
        : (snapshot?.harness ?? null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        state: snapshot.state,
        failing: [...snapshot.failing],
        lastChecks: snapshot.lastChecks,
        uptime: getUptime(),
        harness,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  };
}

export function createNetworkWatchdog({
  probes = null,
  ipcPort = DEFAULT_IPC_PORT,
  watchdogPort = DEFAULT_WATCHDOG_PORT,
  intervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
  internalToken,
  hubAuthToken = process.env.IPC_AUTH_TOKEN ?? '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  waitImpl,
  spawnImpl = spawn,
  createStateMachineImpl = createStateMachine,
  createHarnessStateMachineImpl = createHarnessStateMachine,
  createWatchdogIpcClientImpl = createWatchdogIpcClient,
  createServerImpl = http.createServer,
  watchdogHost = WATCHDOG_HOST,
  watchdogSessionName = WATCHDOG_SESSION_NAME,
  harnessSessionName = HARNESS_SESSION_NAME,
  coldStartGraceMs = DEFAULT_WATCHDOG_COLD_START_GRACE_MS,
  harnessProbeConfig = {},
  onHarnessStateChange = null,
  triggerHarnessSelfHandoverImpl = null,
  handoverConfig = null,
  lineage = null,
  ipcSpawn = null,
  stuckDetectorEnabled = false,
  stuckDetectorTickIntervalMs = 60 * 1000,
  zombiePidDetectorEnabled = true,
  zombiePidDetectorTickIntervalMs = ZOMBIE_PID_TICK_INTERVAL_MS_DEFAULT,
  zombiePidDetectorInitialLastTickAt = Date.now(),
  zombiePidDetectorDryRun = process.env.WATCHDOG_K_D_DRY_RUN !== 'false',
  zombiePidDetectorIsPidAlive = isPidAlive,
  handoverEnabled = false,
  handoverTickIntervalMs = 60 * 1000,
  handoverThreshold = DEFAULT_HANDOVER_THRESHOLD,
  handoverDryRun = true,
  getSessionStateImpl = getSessionState,
  rateLimitCritiqueEnabled = true,
  rateLimitDedupState = loadDedupState(),
  idlePatrolEnabled = process.env.WATCHDOG_IDLE_PATROL_ENABLED !== 'false',
  idlePatrolIntervalMs = DEFAULT_IDLE_PATROL_INTERVAL_MS,
  idlePatrolConfig = {},
  orphanGitReaperEnabled = process.env.WATCHDOG_ORPHAN_GIT_REAPER_ENABLED !== 'false',
  orphanGitReaperIntervalMs = DEFAULT_ORPHAN_GIT_REAPER_INTERVAL_MS,
  orphanGitReaperStatusIntervalMs = 5 * 60 * 1000,
  orphanGitReaperInitialLastTickAt = Date.now(),
  orphanGitReaperInitialLastStatusAt = Date.now(),
  orphanGitReaperNow = Date.now,
  orphanGitReaperImpl = runOrphanGitReaper,
} = {}) {
  if (typeof internalToken !== 'string' || internalToken.trim() === '') {
    throw new Error('internalToken is required');
  }

  let timer = null;
  let stopped = false;
  let started = false;
  let unhealthySince = null;
  let downSince = null;
  let startedAt = null;
  let currentWatchdogPort = watchdogPort;
  let statusServer = null;
  let lastHarnessProbe = null;
  let lastHandoverResult = null;
  let pendingHarnessHandover = null;
  const wait = createWait(waitImpl, setTimeoutImpl);
  const pendingTransitions = new Set();
  const lastCommitAction = { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY };
  const lastAvailableRamAction = { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY };
  const lastPhysRamAction = { WARN: Number.NEGATIVE_INFINITY, CRIT: Number.NEGATIVE_INFINITY };
  const lastCpuAction = { WARN: Number.NEGATIVE_INFINITY };
  const lastDiskAction = { WARN: Number.NEGATIVE_INFINITY };
  const lastOrphanGitAction = { WARN: Number.NEGATIVE_INFINITY };
  const lastPhysRamTreeKillAction = { CRIT: Number.NEGATIVE_INFINITY };
  const lastRateLimitCritiqueAt = rateLimitDedupState;
  let lastCommittedPctCheck = null;
  let lastAvailableRamCheck = null;
  let lastPhysRamPctCheck = null;
  let lastCpuPctCheck = null;
  let lastDiskPctCheck = null;
  let lastOrphanGitCheck = null;
  const anthropicProbeHistory = [];
  let wakeReaperNow = 0;
  let lastStuckDetectorTickAt = 0;
  let lastZombiePidDetectorTickAt = zombiePidDetectorInitialLastTickAt;
  let lastZombiePidDetectorTickResult = { scanned: 0, dead: 0, evicted: 0, dryRun: [] };
  let lastHandoverTickAt = 0;
  let lastHandoverTickResult = { detected: [], skipped: [] };
  let lastIdlePatrolTickAt = Date.now();
  let lastIdlePatrolTickResult = { detected: [], skipped: [{ reason: 'initial-wait' }] };
  let lastOrphanGitReaperTickAt = orphanGitReaperInitialLastTickAt;
  let lastOrphanGitReaperStatusAt = orphanGitReaperInitialLastStatusAt;
  let lastOrphanGitReaperTickResult = { reaped_count: 0, reaped_pids: [], skipped: [{ reason: 'initial-wait' }] };
  const contextUsageHandoverDetectors = new Map();
  const resolvedProbes = probes ?? createDefaultWatchdogProbes({
    ipcPort,
    harnessProbeConfig: {
      ...harnessProbeConfig,
      hubUrl: harnessProbeConfig.hubUrl ?? buildHubUrl(ipcPort),
      fetchImpl: harnessProbeConfig.fetchImpl ?? fetchImpl,
      now: harnessProbeConfig.now ?? now,
      sessionName: harnessProbeConfig.sessionName ?? harnessSessionName,
      authToken: harnessProbeConfig.authToken ?? hubAuthToken,
      wsDisconnectGraceMs: harnessProbeConfig.wsDisconnectGraceMs ?? 60 * 1000,
    },
  });
  const networkProbes = omitHarnessProbe(resolvedProbes);
  const harnessProbe = typeof resolvedProbes.harness === 'function'
    ? resolvedProbes.harness
    : null;
  const committedPctProbe = typeof resolvedProbes.committed_pct === 'function'
    ? resolvedProbes.committed_pct
    : null;
  const availableRamProbe = typeof resolvedProbes.available_ram_mb === 'function'
    ? resolvedProbes.available_ram_mb
    : null;
  const physRamPctProbe = typeof resolvedProbes.phys_ram_used_pct === 'function'
    ? resolvedProbes.phys_ram_used_pct
    : null;
  const cpuPctProbe = typeof resolvedProbes.cpu_used_pct === 'function'
    ? resolvedProbes.cpu_used_pct
    : null;
  const diskPctProbe = typeof resolvedProbes.disk_used_pct === 'function'
    ? resolvedProbes.disk_used_pct
    : null;
  const orphanGitProbe = typeof resolvedProbes.orphan_git === 'function'
    ? resolvedProbes.orphan_git
    : null;
  const canAutoHandover = typeof triggerHarnessSelfHandoverImpl === 'function'
    && lineage
    && typeof ipcSpawn === 'function'
    && handoverConfig
    && typeof handoverConfig === 'object';
  let resolvedHandoverIpcSend = handoverConfig?.ipcSend ?? null;

  function trackPending(promise) {
    pendingTransitions.add(promise);
    promise.finally(() => {
      pendingTransitions.delete(promise);
    });
    return promise;
  }

  function dispatchTransition(body) {
    return trackPending(postInternalNetworkEvent({
      body,
      ipcPort,
      internalToken,
      fetchImpl,
      stderr,
      wait,
    }));
  }

  const wakeCooldown = createWakeCooldown({ db: { getWakeRecord, upsertWakeRecord } });
  const wakeReaper = createWakeReaper({
    fetchHealth: async () => {
      const response = await fetchImpl(`${buildHubUrl(ipcPort)}/health`);
      if (!isSuccessfulResponse(response)) {
        return null;
      }
      return response.json();
    },
    recentAnthropicProbes: () => anthropicProbeHistory,
    postWakeSuspended: async (body) => fetchImpl(`${buildHubUrl(ipcPort)}/wake-suspended`, {
      method: 'POST',
      headers: buildAuthJsonHeaders(hubAuthToken),
      body: JSON.stringify(body),
    }),
    now: () => wakeReaperNow,
    tickIntervalMs: 60 * 1000,
    initialLastTickAt: 0,
    cooldown: wakeCooldown,
  });
  const stuckDetector = stuckDetectorEnabled
    ? createStuckSessionDetector({
      db: {
        listSuspendedSessions,
        suspendSession,
      },
      getSessions: async () => {
        const response = await fetchImpl(`${buildHubUrl(ipcPort)}/sessions`);
        if (!isSuccessfulResponse(response)) {
          return new Map();
        }
        const sessions = await response.json();
        return new Map((Array.isArray(sessions) ? sessions : []).map((session) => [
          session.name,
          {
            ...session,
            ws: { readyState: 1 },
          },
        ]));
      },
      getSessionState: getSessionStateImpl,
      readTranscriptTail,
      now,
    })
    : null;
  const zombiePidDetector = zombiePidDetectorEnabled
    ? createZombiePidDetector({
      getSessions: async () => {
        const response = await fetchImpl(`${buildHubUrl(ipcPort)}/sessions?include_anonymous=1`);
        if (!isSuccessfulResponse(response)) {
          return [];
        }
        const payload = await response.json();
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.sessions)) return payload.sessions;
        return [];
      },
      isPidAlive: zombiePidDetectorIsPidAlive,
      postReclaim: async (name) => {
        const response = await fetchImpl(`${buildHubUrl(ipcPort)}/reclaim-name`, {
          method: 'POST',
          headers: buildAuthJsonHeaders(hubAuthToken),
          body: JSON.stringify({ name }),
        });
        if (!isSuccessfulResponse(response)) {
          return { ok: false, reason: `http-${response?.status ?? 'unknown'}` };
        }
        return response.json();
      },
      dryRun: zombiePidDetectorDryRun,
      stderr,
    })
    : null;
  const handoverDetector = handoverEnabled && typeof ipcSpawn === 'function'
    ? {
      async tick() {
        const response = await fetchImpl(`${buildHubUrl(ipcPort)}/sessions`);
        if (!isSuccessfulResponse(response)) {
          return { detected: [], skipped: [{ reason: 'sessions-unavailable' }] };
        }
        const sessions = await response.json();
        const onlineSessions = Array.isArray(sessions) ? sessions : [];
        const onlineNames = new Set(onlineSessions.map((session) => session?.name).filter(Boolean));
        for (const name of contextUsageHandoverDetectors.keys()) {
          if (!onlineNames.has(name)) contextUsageHandoverDetectors.delete(name);
        }

        const detected = [];
        const skipped = [];
        const candidateSessions = [...onlineSessions].sort((a, b) => {
          const pctA = getSessionContextUsagePct(a) ?? 0;
          const pctB = getSessionContextUsagePct(b) ?? 0;
          return pctB - pctA;
        });
        let triggeredThisTick = false;
        for (const session of candidateSessions) {
          const sessionName = typeof session?.name === 'string' ? session.name.trim() : '';
          if (!sessionName) {
            skipped.push({ name: null, reason: 'missing-session-name' });
            continue;
          }
          if (sessionName === watchdogSessionName || sessionName.endsWith('-old')) {
            skipped.push({ name: sessionName, reason: 'watchdog-or-retired-session' });
            continue;
          }

          let entry = contextUsageHandoverDetectors.get(sessionName);
          if (!entry) {
            entry = { sessionRecord: session };
            const sessionCwd = () => getSessionCwd(entry.sessionRecord, handoverConfig?.handoverRepoPath ?? process.cwd());
            entry.detector = createContextUsageAutoHandover({
              threshold: handoverThreshold,
              estimateContextPct: async (sessionRecord = entry.sessionRecord) => {
                const pct = getSessionContextUsagePct(sessionRecord);
                if (pct === null) {
                  stderr(`[network-watchdog] estimateContextPct hub session=${sessionName} pid=${sessionRecord?.pid ?? 'unknown'} pct=unknown (null·skip handover)`);
                  return null;
                }
                stderr(`[network-watchdog] estimateContextPct hub session=${sessionName} pid=${sessionRecord?.pid ?? 'unknown'} pct=${pct}`);
                return pct;
              },
              isMinimalTaskUnitComplete: createMinimalTaskUnitCompleteChecker({
                getPendingOutgoingCount: () => getSessionPendingOutgoingCount(entry.sessionRecord),
                isGitTreeClean: () => isGitTreeClean(sessionCwd()),
                hasInFlightCodexTask: () => hasInFlightCodexTask(join(sessionCwd(), 'reports', 'codex-runs')),
              }),
              triggerHandover: createAtomicHandoverTrigger({
                name: sessionName,
                // ADR-010 mod 6 wiring v6 fix·cwd 取原 session 自身 cwd（Hub /sessions[].cwd）·不取 watchdog 自身 / handoverRepoPath / process.cwd·防新 spawn 进错仓
                cwd: sessionCwd(),
                handoverDir: handoverConfig?.handoverDir,
                dryRun: handoverDryRun,
                stderr,
                lineage,
                recordSessionSpawn,
                parentSessionId: typeof session.sessionId === 'string' ? session.sessionId : null,
                notifyPreSpawnReview: async (review) => {
                  const content = `[pre-spawn-review] ${JSON.stringify(review)}`;
                  await fetchImpl(`${buildHubUrl(ipcPort)}/send`, {
                    method: 'POST',
                    headers: buildAuthJsonHeaders(hubAuthToken),
                    body: JSON.stringify({
                      from: watchdogSessionName,
                      to: 'harness',
                      topic: 'pre-spawn-review',
                      content,
                    }),
                  });
                },
                now,
                notifyOldSessionQuit: async () => notifyOldSessionQuit({
                  name: sessionName,
                  fetchImpl,
                  hubAuthToken,
                  ipcPort,
                  watchdogSessionName,
                }),
                renameSession: async () => fetchImpl(`${buildHubUrl(ipcPort)}/prepare-rebind`, {
                  method: 'POST',
                  headers: {
                    ...buildAuthJsonHeaders(hubAuthToken),
                    'X-IPC-Session': sessionName,
                  },
                  body: JSON.stringify({ name: sessionName, ttl_seconds: 5 }),
                }).then(async (prepareResponse) => ({
                  ok: isSuccessfulResponse(prepareResponse),
                  status: prepareResponse.status,
                  ...(typeof prepareResponse.json === 'function' ? await prepareResponse.json() : {}),
                })),
                spawnSession: ipcSpawn,
                getRecentMessages: async ({ since, limit }) => {
                  const params = new URLSearchParams({ name: sessionName, since: String(since), limit: String(limit) });
                  const recentResponse = await fetchImpl(`${buildHubUrl(ipcPort)}/recent-messages?${params.toString()}`);
                  if (!isSuccessfulResponse(recentResponse)) return [];
                  const body = await recentResponse.json();
                  return Array.isArray(body?.messages) ? body.messages : [];
                },
              }),
            });
            contextUsageHandoverDetectors.set(sessionName, entry);
          }
          entry.sessionRecord = session;

          const result = await entry.detector.tick(session);
          if (result?.skipped === 'pct-unknown') {
            try {
              mkdirSync(dirname(FALLBACK_STORM_LOG), { recursive: true });
              appendFileSync(FALLBACK_STORM_LOG, `${new Date(now()).toISOString()} session=${sessionName} pct=unknown\n`);
            } catch {}
          }
          if (result?.triggered) {
            detected.push({ name: sessionName, ...result });
            stderr(`[network-watchdog] context usage handover triggered: ${sessionName} pct=${result.pct}`);
            triggeredThisTick = true;
          } else if (triggeredThisTick) {
            skipped.push({ name: sessionName, skipped: 'pacing-deferred-next-tick' });
          } else {
            skipped.push({ name: sessionName, ...(result && typeof result === 'object' ? result : { skipped: result }) });
          }
          if (triggeredThisTick) {
            for (const rest of candidateSessions.slice(candidateSessions.indexOf(session) + 1)) {
              const restName = typeof rest?.name === 'string' ? rest.name.trim() : '';
              if (restName && restName !== watchdogSessionName && !restName.endsWith('-old')) {
                skipped.push({ name: restName, skipped: 'pacing-deferred-next-tick' });
              }
            }
            break;
          }
        }
        return { detected, skipped };
      },
    }
    : null;

  const networkStateMachine = createStateMachineImpl({
    probes: networkProbes,
    now,
    onTransition: (transition) => {
      const eventTs = Number.isFinite(transition.ts) ? transition.ts : now();

      if (transition.to !== 'OK' && unhealthySince == null) {
        unhealthySince = eventTs;
      }

      if (transition.to === 'down') {
        if (unhealthySince == null) {
          unhealthySince = eventTs;
        }
        downSince = eventTs;
        void dispatchTransition({
          event: 'network-down',
          failing: transition.failing,
          since: unhealthySince,
          triggeredBy: 'watchdog',
          ts: eventTs,
        });
        return;
      }

      if (transition.from === 'down' && transition.to === 'OK') {
        const recoveredAfter = downSince == null ? 0 : Math.max(0, eventTs - downSince);
        unhealthySince = null;
        downSince = null;
        void dispatchTransition({
          event: 'network-up',
          recoveredAfter,
          triggeredBy: 'watchdog',
          ts: eventTs,
        });
        return;
      }

      if (transition.to === 'OK') {
        unhealthySince = null;
      }
    },
  });

  function buildHarnessSnapshot() {
    const snapshot = harnessStateMachine.getSnapshot();
    return {
      state: snapshot.state,
      contextWarnPct: snapshot.contextPct,
      nextAction: snapshot.nextAction,
      warnCount: snapshot.warnCount,
      lastTransition: snapshot.lastTransition,
      lastReason: snapshot.lastReason,
      lastProbe: lastHarnessProbe,
    };
  }

  const harnessStateMachine = createHarnessStateMachineImpl({
    now,
    coldStartGraceMs,
    onTransition: (transition) => {
      if (
        canAutoHandover
        && transition.to === 'down'
        && !isHeldByColdStartGrace(transition.reason)
        && pendingHarnessHandover == null
      ) {
        const promise = Promise.resolve()
          .then(() => triggerHarnessSelfHandoverImpl({
            ...handoverConfig,
            ipcSend: resolvedHandoverIpcSend,
            lineage,
            ipcSpawn,
            reason: mapHarnessTransitionToHandoverReason(transition.reason),
          }))
          .then((result) => {
            lastHandoverResult = result;
            return result;
          })
          .catch((error) => {
            lastHandoverResult = {
              triggered: false,
              error: toErrorMessage(error),
            };
            stderr(`[network-watchdog] harness handover failed: ${toErrorMessage(error)}`);
            return lastHandoverResult;
          })
          .finally(() => {
            pendingHarnessHandover = null;
          });
        pendingHarnessHandover = trackPending(promise);
      }

      if (
        typeof onHarnessStateChange === 'function'
        && transition.to === 'down'
      ) {
        onHarnessStateChange({
          state: transition.to,
          reason: transition.reason,
          context: {
            pct: transition.contextPct,
            nextAction: transition.nextAction,
          },
          snapshot: buildHarnessSnapshot(),
        });
      }
    },
  });

  const watchdogIpcClient = createWatchdogIpcClientImpl({
    ipcPort,
    sessionName: watchdogSessionName,
    harnessSessionName,
    hubAuthToken,
    fetchImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
    stderr,
    onHarnessHeartbeat: (heartbeat) => {
      harnessStateMachine.ingestHeartbeat(heartbeat);
    },
  });
  if (resolvedHandoverIpcSend == null && typeof watchdogIpcClient.sendMessage === 'function') {
    resolvedHandoverIpcSend = (message) => watchdogIpcClient.sendMessage(message);
  }
  const idlePatrol = createIdlePatrol({
    ipcPort,
    hubAuthToken,
    fetchImpl,
    now,
    watchdogSessionName,
    harnessSessionName,
    stateDir: join(PROJECT_ROOT, 'data', 'watchdog', 'idle-patrol'),
    ...idlePatrolConfig,
  });

  function buildCompositeState() {
    const snapshot = networkStateMachine.getState();
    const lastChecks = {
      ...snapshot.lastChecks,
      ...(lastCommittedPctCheck ? { committed_pct: lastCommittedPctCheck } : {}),
      ...(lastAvailableRamCheck ? { available_ram_mb: lastAvailableRamCheck } : {}),
      ...(lastPhysRamPctCheck ? { phys_ram_used_pct: lastPhysRamPctCheck } : {}),
      ...(lastCpuPctCheck ? { cpu_used_pct: lastCpuPctCheck } : {}),
      ...(lastDiskPctCheck ? { disk_used_pct: lastDiskPctCheck } : {}),
      ...(lastOrphanGitCheck ? { orphan_git: lastOrphanGitCheck } : {}),
    };
    return {
      ...snapshot,
      lastChecks,
      harness: buildHarnessSnapshot(),
    };
  }

  async function runCommittedPctTick() {
    if (!committedPctProbe) {
      return null;
    }

    let result;
    try {
      result = await committedPctProbe();
    } catch (error) {
      result = { ok: false, pct: null, error: toErrorMessage(error) };
    }

    const check = {
      ...result,
      ts: now(),
    };
    lastCommittedPctCheck = check;
    handleCommittedPct(result, {
      ipcSend: resolvedHandoverIpcSend,
      spawnImpl,
      now,
      stderr,
      lastCommitAction,
    });
    return check;
  }

  async function runAvailableRamTick() {
    if (!availableRamProbe) {
      return null;
    }

    let result;
    try {
      result = await availableRamProbe();
    } catch (error) {
      result = { ok: false, availableMb: null, error: toErrorMessage(error) };
    }

    const check = {
      ...result,
      ts: now(),
    };
    lastAvailableRamCheck = check;
    handleAvailableRamMb(result, {
      ipcSend: resolvedHandoverIpcSend,
      now,
      stderr,
      lastAvailableRamAction,
      spawnImpl,
      lastPhysRamTreeKillAction,
    });
    return check;
  }

  async function runPhysRamPctTick() {
    if (!physRamPctProbe) {
      return null;
    }

    let result;
    try {
      result = await physRamPctProbe();
    } catch (error) {
      result = { ok: false, pct: null, error: toErrorMessage(error) };
    }

    const check = {
      ...result,
      ts: now(),
    };
    lastPhysRamPctCheck = check;
    handleAvailableRamPct(result, {
      ipcSend: resolvedHandoverIpcSend,
      now,
      stderr,
      lastPhysRamAction,
      spawnImpl,
      lastPhysRamTreeKillAction,
    });
    return check;
  }

  async function runCpuPctTick() {
    if (!cpuPctProbe) {
      return null;
    }

    let result;
    try {
      result = await cpuPctProbe();
    } catch (error) {
      result = { ok: false, pct: null, error: toErrorMessage(error) };
    }

    const check = {
      ...result,
      ts: result?.ts ?? now(),
    };
    lastCpuPctCheck = check;
    handleCpuUsedPct(check, {
      ipcSend: resolvedHandoverIpcSend,
      now,
      stderr,
      lastCpuAction,
    });
    return check;
  }

  async function runDiskPctTick() {
    if (!diskPctProbe) {
      return null;
    }

    let result;
    try {
      result = await diskPctProbe();
    } catch (error) {
      result = { ok: false, drives: [], maxUsedPct: null, error: toErrorMessage(error) };
    }

    const check = {
      ...result,
      ts: result?.ts ?? now(),
    };
    lastDiskPctCheck = check;
    handleDiskUsedPct(check, {
      ipcSend: resolvedHandoverIpcSend,
      now,
      stderr,
      lastDiskAction,
    });
    return check;
  }

  async function runOrphanGitTick() {
    if (!orphanGitProbe) {
      return null;
    }

    let result;
    try {
      result = await orphanGitProbe();
    } catch (error) {
      result = { ok: false, total: 0, orphans: [], maxAgeMs: 0, error: toErrorMessage(error) };
    }

    const check = {
      ...result,
      ts: result?.ts ?? now(),
    };
    lastOrphanGitCheck = check;
    handleOrphanGitProcesses(check, {
      ipcSend: resolvedHandoverIpcSend,
      now,
      stderr,
      lastOrphanGitAction,
    });
    return check;
  }

  async function runRateLimitTick() {
    if (!rateLimitCritiqueEnabled || typeof resolvedHandoverIpcSend !== 'function') {
      return [];
    }

    try {
      const response = await fetchImpl(`${buildHubUrl(ipcPort)}/sessions`);
      if (!isSuccessfulResponse(response)) {
        return [];
      }
      const sessions = await response.json();
      return checkRateLimits(Array.isArray(sessions) ? sessions : [], {
        ipcSend: resolvedHandoverIpcSend,
        now,
        stderr,
        lastRateLimitCritiqueAt,
      });
    } catch (error) {
      stderr(`[network-watchdog] rate_limits check failed: ${toErrorMessage(error)}`);
      return [];
    }
  }

  async function runHarnessTick() {
    if (!harnessProbe) {
      return buildHarnessSnapshot();
    }

    let result;
    try {
      result = await harnessProbe();
    } catch (error) {
      result = { ok: false, error: toErrorMessage(error) };
    }

    if (typeof harnessProbe.onProbeResult === 'function') {
      harnessProbe.onProbeResult(result);
    }

    if (result?.ok && result?.connected === true) {
      harnessStateMachine.markAliveSignal('probe-ok');
    }

    lastHarnessProbe = {
      ...result,
      ts: now(),
    };
    harnessStateMachine.ingestProbeResult(result);
    return lastHarnessProbe;
  }

  async function runWakeReaperTick(lastChecks) {
    if (lastChecks?.anthropic) {
      anthropicProbeHistory.push(lastChecks.anthropic);
      while (anthropicProbeHistory.length > 3) {
        anthropicProbeHistory.shift();
      }
    }
    wakeReaperNow = Number.isFinite(lastChecks?.anthropic?.ts) ? lastChecks.anthropic.ts : Date.now();
    return wakeReaper.tick();
  }

  async function runStuckDetectorTick() {
    if (!stuckDetector) {
      return { detected: [], skipped: [] };
    }
    const ts = now();
    if (ts - lastStuckDetectorTickAt < stuckDetectorTickIntervalMs) {
      return { detected: [], skipped: [{ reason: 'tick-interval' }] };
    }
    lastStuckDetectorTickAt = ts;
    try {
      return await stuckDetector.tick();
    } catch (error) {
      stderr(`[network-watchdog] stuck detector tick failed: ${error?.message ?? error}`);
      return { detected: [], skipped: [] };
    }
  }

  async function runZombiePidDetectorTick() {
    if (!zombiePidDetector) {
      return { scanned: 0, dead: 0, evicted: 0, dryRun: [] };
    }
    const ts = Date.now();
    if (ts - lastZombiePidDetectorTickAt < zombiePidDetectorTickIntervalMs) {
      return lastZombiePidDetectorTickResult;
    }
    lastZombiePidDetectorTickAt = ts;
    try {
      lastZombiePidDetectorTickResult = await zombiePidDetector.tick();
      if (lastZombiePidDetectorTickResult.dead > 0) {
        stderr(
          `[network-watchdog] zombie-pid tick: scanned=${lastZombiePidDetectorTickResult.scanned} dead=${lastZombiePidDetectorTickResult.dead} evicted=${lastZombiePidDetectorTickResult.evicted} dryRun=${lastZombiePidDetectorTickResult.dryRun.length}`,
        );
      }
      return lastZombiePidDetectorTickResult;
    } catch (error) {
      stderr(`[network-watchdog] zombie-pid tick failed: ${error?.message ?? error}`);
      lastZombiePidDetectorTickResult = { scanned: 0, dead: 0, evicted: 0, dryRun: [] };
      return lastZombiePidDetectorTickResult;
    }
  }

  async function runHandoverTick() {
    if (!handoverDetector) {
      return { detected: [], skipped: [] };
    }
    const ts = now();
    if (ts - lastHandoverTickAt < handoverTickIntervalMs) {
      lastHandoverTickResult = { detected: [], skipped: [{ reason: 'tick-interval' }] };
      return lastHandoverTickResult;
    }
    lastHandoverTickAt = ts;
    try {
      lastHandoverTickResult = await handoverDetector.tick();
      return lastHandoverTickResult;
    } catch (error) {
      stderr(`[network-watchdog] handover detector tick failed: ${error?.message ?? error}`);
      lastHandoverTickResult = { detected: [], skipped: [] };
      return lastHandoverTickResult;
    }
  }

  async function runIdlePatrolTick() {
    if (!idlePatrolEnabled) {
      lastIdlePatrolTickResult = { detected: [], skipped: [{ reason: 'disabled' }] };
      return lastIdlePatrolTickResult;
    }
    const ts = Date.now();
    if (ts - lastIdlePatrolTickAt < idlePatrolIntervalMs) {
      lastIdlePatrolTickResult = { detected: [], skipped: [{ reason: 'tick-interval' }] };
      return lastIdlePatrolTickResult;
    }
    lastIdlePatrolTickAt = ts;
    try {
      const results = await idlePatrol.tick();
      lastIdlePatrolTickResult = {
        detected: results.filter((result) => result.action === 'nudge'),
        skipped: results.filter((result) => result.action !== 'nudge'),
      };
      return lastIdlePatrolTickResult;
    } catch (error) {
      stderr(`[network-watchdog] idle patrol tick failed: ${error?.message ?? error}`);
      lastIdlePatrolTickResult = { detected: [], skipped: [] };
      return lastIdlePatrolTickResult;
    }
  }

  async function runOrphanGitReaperTick() {
    if (!orphanGitReaperEnabled) {
      lastOrphanGitReaperTickResult = { reaped_count: 0, reaped_pids: [], skipped: [{ reason: 'disabled' }] };
      return lastOrphanGitReaperTickResult;
    }
    const ts = orphanGitReaperNow();
    if (ts - lastOrphanGitReaperTickAt < orphanGitReaperIntervalMs) {
      return lastOrphanGitReaperTickResult;
    }
    lastOrphanGitReaperTickAt = ts;
    try {
      lastOrphanGitReaperTickResult = await orphanGitReaperImpl({ stderr });
    } catch (error) {
      stderr(`[network-watchdog] orphan-git-reaper tick failed: ${error?.message ?? error}`);
      lastOrphanGitReaperTickResult = { reaped_count: 0, reaped_pids: [], error: error?.message ?? String(error) };
    }

    if (ts - lastOrphanGitReaperStatusAt >= orphanGitReaperStatusIntervalMs) {
      lastOrphanGitReaperStatusAt = ts;
      const status = getOrphanGitReaperStatus();
      stderr(`[watchdog] reaper status: reaped_total=${status.reaped_total} · last_cycle_count=${status.last_cycle_count}`);
    }
    return lastOrphanGitReaperTickResult;
  }

  function ingestHarnessHeartbeat(heartbeat) {
    if (!heartbeat || typeof heartbeat !== 'object') {
      return false;
    }
    harnessStateMachine.ingestHeartbeat(heartbeat);
    return true;
  }

  function ingestHarnessHeartbeatContent(content) {
    const parsed = parseHarnessHeartbeatContent(content);
    if (!parsed) {
      return false;
    }
    return ingestHarnessHeartbeat(parsed);
  }

  function scheduleNextTick() {
    if (stopped) {
      return;
    }

    timer = setTimeoutImpl(() => {
      void runTick({ scheduleNext: true });
    }, intervalMs);
  }

  async function runTick({ scheduleNext = false } = {}) {
    try {
      const [networkState, committedPctCheck, availableRamCheck, physRamPctCheck, cpuPctCheck, diskPctCheck, orphanGitCheck] = await Promise.all([
        networkStateMachine.tick(),
        runCommittedPctTick(),
        runAvailableRamTick(),
        runPhysRamPctTick(),
        runCpuPctTick(),
        runDiskPctTick(),
        runOrphanGitTick(),
        runHarnessTick(),
      ]);
      const lastChecks = {
        ...networkState.lastChecks,
        ...(committedPctCheck ? { committed_pct: committedPctCheck } : {}),
        ...(availableRamCheck ? { available_ram_mb: availableRamCheck } : {}),
        ...(physRamPctCheck ? { phys_ram_used_pct: physRamPctCheck } : {}),
        ...(cpuPctCheck ? { cpu_used_pct: cpuPctCheck } : {}),
        ...(diskPctCheck ? { disk_used_pct: diskPctCheck } : {}),
        ...(orphanGitCheck ? { orphan_git: orphanGitCheck } : {}),
      };
      await Promise.all([
        runWakeReaperTick(lastChecks),
        runStuckDetectorTick(),
        runZombiePidDetectorTick(),
        runHandoverTick(),
        runRateLimitTick(),
        runIdlePatrolTick(),
        runOrphanGitReaperTick(),
      ]);
      return {
        ...networkState,
        lastChecks,
        harness: buildHarnessSnapshot(),
      };
    } catch (error) {
      stderr(`[network-watchdog] tick failed: ${error?.message ?? error}`);
      return buildCompositeState();
    } finally {
      if (scheduleNext && !stopped) {
        scheduleNextTick();
      }
    }
  }

  async function waitForIdle() {
    if (pendingTransitions.size === 0) {
      return;
    }

    await Promise.allSettled([...pendingTransitions]);
  }

  async function start({ runImmediately = true } = {}) {
    if (started) {
      return controller;
    }

    started = true;
    stopped = false;
    startedAt = now();
    await watchdogIpcClient.start();

    if (!statusServer) {
      const statusHandler = createWatchdogStatusHandler({
        getSnapshot: buildCompositeState,
        getHarnessSnapshot: buildHarnessSnapshot,
        getUptime: () => (startedAt == null ? 0 : Math.max(0, now() - startedAt)),
      });
      statusServer = createServerImpl(statusHandler);
      await new Promise((resolveStart, rejectStart) => {
        const onError = (error) => {
          statusServer?.off('listening', onListening);
          rejectStart(error);
        };
        const onListening = () => {
          statusServer?.off('error', onError);
          const address = statusServer?.address();
          if (typeof address === 'object' && address) {
            currentWatchdogPort = address.port;
          }
          resolveStart();
        };

        statusServer.once('error', onError);
        statusServer.once('listening', onListening);
        statusServer.listen(watchdogPort, watchdogHost);
      });
    }

    if (runImmediately) {
      void runTick({ scheduleNext: true });
    }
    return controller;
  }

  async function stop() {
    if (!started) {
      return;
    }

    stopped = true;
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    await waitForIdle();
    await watchdogIpcClient.stop();
    if (statusServer) {
      const server = statusServer;
      statusServer = null;
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
    started = false;
  }

  const controller = {
    start,
    stop,
    runTick,
    waitForIdle,
    ingestHarnessHeartbeat,
    ingestHarnessHeartbeatContent,
    ingestHarnessHeartbeatMessage: ingestHarnessHeartbeatContent,
    getState: buildCompositeState,
    getHarnessState: buildHarnessSnapshot,
    getLastHandoverResult: () => lastHandoverResult,
    getLastHandoverTickResult: () => lastHandoverTickResult,
    getLastIdlePatrolTickResult: () => lastIdlePatrolTickResult,
    getLastOrphanGitReaperTickResult: () => lastOrphanGitReaperTickResult,
    getLastZombiePidDetectorTickResult: () => lastZombiePidDetectorTickResult,
    getConfig: () => ({
      ipcPort,
      watchdogPort: currentWatchdogPort,
      intervalMs,
      zombiePidDetectorEnabled,
      zombiePidDetectorDryRun,
      idlePatrolEnabled,
      idlePatrolIntervalMs,
      orphanGitReaperEnabled,
      orphanGitReaperIntervalMs,
    }),
  };

  return controller;
}

export function formatWatchdogHelp() {
  return [
    'Usage: node bin/network-watchdog.mjs',
    '',
    'Environment:',
    `  IPC_PORT=${DEFAULT_IPC_PORT}                 Hub HTTP port`,
    `  IPC_WATCHDOG_PORT=${DEFAULT_WATCHDOG_PORT}      Watchdog status port`,
    `  IPC_WATCHDOG_INTERVAL_MS=${DEFAULT_WATCHDOG_INTERVAL_MS}  Probe interval in milliseconds`,
    `  WATCHDOG_COLD_START_GRACE_MS=${DEFAULT_WATCHDOG_COLD_START_GRACE_MS}  Suppress harness self-handover until first alive signal`,
    '  WATCHDOG_K_D_DRY_RUN=true          Zombie pid cleanup dry-run; set false to evict',
    `  WATCHDOG_HANDOVER_THRESHOLD=${DEFAULT_HANDOVER_THRESHOLD}     Context usage pct required before atomic handoff`,
    '  IPC_INTERNAL_TOKEN=<token>          Shared internal auth token',
  ].join('\n');
}

export async function startWatchdog(options = {}) {
  const ipcPort = parsePort(options.ipcPort ?? process.env.IPC_PORT, DEFAULT_IPC_PORT);
  const watchdogPort = parsePort(options.watchdogPort ?? process.env.IPC_WATCHDOG_PORT, DEFAULT_WATCHDOG_PORT);
  const intervalMs = parsePort(options.intervalMs ?? process.env.IPC_WATCHDOG_INTERVAL_MS, DEFAULT_WATCHDOG_INTERVAL_MS);
  const coldStartGraceMs = parseNonNegativeInt(
    options.coldStartGraceMs ?? process.env.WATCHDOG_COLD_START_GRACE_MS,
    DEFAULT_WATCHDOG_COLD_START_GRACE_MS,
  );
  const handoverThreshold = parsePercentThreshold(
    options.handoverThreshold ?? process.env.WATCHDOG_HANDOVER_THRESHOLD,
    DEFAULT_HANDOVER_THRESHOLD,
  );
  const internalToken = options.internalToken ?? await loadInternalToken({ rootDir: PROJECT_ROOT });
  const ipcSpawn = options.ipcSpawn ?? await loadDefaultIpcSpawn();
  const lineage = options.lineage ?? createLineageTracker({
    dbPath: process.env.IPC_DB_PATH || join(PROJECT_ROOT, 'data', 'messages.db'),
  });
  const baseHandoverConfig = options.handoverConfig ?? {};

  const watchdog = createNetworkWatchdog({
    ...options,
    ipcPort,
    watchdogPort,
    intervalMs,
    coldStartGraceMs,
    internalToken,
    ipcSpawn,
    lineage,
    triggerHarnessSelfHandoverImpl: options.triggerHarnessSelfHandoverImpl ?? triggerHarnessSelfHandover,
    stuckDetectorEnabled: options.stuckDetectorEnabled ?? true,
    zombiePidDetectorEnabled: options.zombiePidDetectorEnabled ?? true,
    zombiePidDetectorDryRun: options.zombiePidDetectorDryRun ?? (process.env.WATCHDOG_K_D_DRY_RUN !== 'false'),
    handoverEnabled: options.handoverEnabled ?? true,
    handoverThreshold,
    handoverDryRun: options.handoverDryRun ?? (process.env.WATCHDOG_HANDOVER_DRY_RUN === 'true'),
    handoverConfig: {
      checkpointPath: baseHandoverConfig.checkpointPath ?? DEFAULT_CHECKPOINT_PATH,
      lastBreathPath: baseHandoverConfig.lastBreathPath ?? DEFAULT_LAST_BREATH_PATH,
      statusPath: baseHandoverConfig.statusPath ?? DEFAULT_STATUS_PATH,
      handoverRepoPath: baseHandoverConfig.handoverRepoPath ?? DEFAULT_HANDOVER_REPO_PATH,
      ...baseHandoverConfig,
    },
  });

  await watchdog.start();
  return watchdog;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${formatWatchdogHelp()}\n`);
    return 0;
  }

  const watchdog = await startWatchdog();
  const shutdown = async (signal) => {
    process.stderr.write(`[network-watchdog] ${signal} received, shutting down\n`);
    await watchdog.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const exitCode = await main();
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (error) {
    process.stderr.write(`[network-watchdog] failed to start: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
