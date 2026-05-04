import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_ORPHAN_GIT_REAPER_INTERVAL_MS = 60 * 1000;
export const DEFAULT_ORPHAN_GIT_REAPER_MIN_AGE_MS = 60 * 1000;
export const DEFAULT_ORPHAN_GIT_REAPER_TIMEOUT_MS = 5000;

const MUTATING_COMMAND_PATTERNS = [
  /\bgit(?:\.exe)?["']?\s+(push|pull|fetch|merge|rebase|commit|stash|checkout|reset|clean|am|cherry-pick|revert|gc|repack|pack-objects|fsck|prune|filter-branch|update-server-info|update-ref|tag|branch|notes|submodule|worktree|init|clone|add|rm|mv|apply|format-patch|send-email)\b/i,
];

let reapedTotal = 0;
let lastMetric = {
  reaped_count: 0,
  reaped_pids: [],
  cycle_ts: null,
};

function parseWindowsDate(value) {
  if (value == null || value === '') {
    return null;
  }
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  const text = String(value);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProcessRecord(record, nowMs) {
  const pid = Number(record?.pid ?? record?.ProcessId);
  const ppid = Number(record?.ppid ?? record?.ParentProcessId);
  const commandLine = String(record?.cmdline ?? record?.CommandLine ?? '');
  const startTs = Number.isFinite(Number(record?.startTimeMs))
    ? Number(record.startTimeMs)
    : parseWindowsDate(record?.start_time ?? record?.CreationDate);
  return {
    pid,
    ppid,
    cmdline: commandLine,
    startTimeMs: startTs,
    ageMs: Number.isFinite(startTs) ? Math.max(0, nowMs - startTs) : null,
    parentExists: record?.parentExists,
  };
}

function isPidValue(value) {
  return Number.isInteger(value) && value > 0;
}

export function isMutatingGitCommand(cmdline) {
  const text = String(cmdline ?? '');
  return MUTATING_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

export function isOrphanGitCandidate(processInfo, {
  nowMs = Date.now(),
  minAgeMs = DEFAULT_ORPHAN_GIT_REAPER_MIN_AGE_MS,
  parentExists = null,
} = {}) {
  const info = normalizeProcessRecord(processInfo, nowMs);
  if (!isPidValue(info.pid) || !isPidValue(info.ppid)) {
    return false;
  }
  if (!Number.isFinite(info.ageMs) || info.ageMs <= minAgeMs) {
    return false;
  }
  const resolvedParentExists = typeof parentExists === 'function'
    ? parentExists(info.ppid)
    : (typeof info.parentExists === 'boolean' ? info.parentExists : null);
  if (info.ppid !== 1 && resolvedParentExists !== false) {
    return false;
  }
  return !isMutatingGitCommand(info.cmdline);
}

export async function listGitProcesses({
  execFileImpl = execFileAsync,
  timeoutMs = DEFAULT_ORPHAN_GIT_REAPER_TIMEOUT_MS,
} = {}) {
  if (process.platform !== 'win32') {
    return [];
  }

  const script = [
    "$ErrorActionPreference='Stop'",
    "$all=Get-CimInstance Win32_Process | Select-Object -ExpandProperty ProcessId",
    "$pidSet=@{}",
    "foreach($p in $all){ $pidSet[[int]$p]=$true }",
    "$rows=Get-CimInstance Win32_Process -Filter \"Name = 'git.exe'\" | ForEach-Object {",
    "  $created=$_.CreationDate",
    "  $startTime=''",
    "  if($created -is [datetime]){",
    "    $startTime=$created.ToString('o')",
    "  } elseif($null -ne $created -and [string]$created -ne '') {",
    "    $startTime=([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created).ToString('o'))",
    "  }",
    "  [pscustomobject]@{",
    "    pid=[int]$_.ProcessId;",
    "    ppid=[int]$_.ParentProcessId;",
    "    cmdline=[string]$_.CommandLine;",
    "    start_time=$startTime;",
    "    parentExists=[bool]$pidSet.ContainsKey([int]$_.ParentProcessId)",
    "  }",
    "}",
    "$rows | ConvertTo-Json -Compress",
  ].join('\n');

  const { stdout } = await execFileImpl('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  const text = String(stdout ?? '').trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function killProcess(pid, {
  execFileImpl = execFileAsync,
  timeoutMs = DEFAULT_ORPHAN_GIT_REAPER_TIMEOUT_MS,
} = {}) {
  await execFileImpl('taskkill', ['/PID', String(pid), '/F'], {
    timeout: timeoutMs,
    windowsHide: true,
  });
}

export async function runOrphanGitReaper({
  listProcesses = listGitProcesses,
  killProcessImpl = killProcess,
  now = Date.now,
  minAgeMs = DEFAULT_ORPHAN_GIT_REAPER_MIN_AGE_MS,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
} = {}) {
  const nowMs = now();
  const processes = await listProcesses();
  const parentPidSet = new Set(
    processes
      .map((processInfo) => Number(processInfo?.pid ?? processInfo?.ProcessId))
      .filter(isPidValue),
  );
  const candidates = processes
    .map((processInfo) => normalizeProcessRecord(processInfo, nowMs))
    .filter((processInfo) => isOrphanGitCandidate(processInfo, {
      nowMs,
      minAgeMs,
      parentExists: (pid) => {
        if (typeof processInfo.parentExists === 'boolean') {
          return processInfo.parentExists;
        }
        return parentPidSet.has(pid);
      },
    }));

  const reaped = [];
  for (const candidate of candidates) {
    try {
      await killProcessImpl(candidate.pid);
      reaped.push(candidate);
      stderr(`[watchdog] reaped pid ${candidate.pid} cmdline ${candidate.cmdline}`);
    } catch (error) {
      stderr(`[watchdog] orphan-git-reaper kill failed pid=${candidate.pid}: ${error?.message ?? error}`);
    }
  }

  reapedTotal += reaped.length;
  lastMetric = {
    reaped_count: reaped.length,
    reaped_pids: reaped.map((processInfo) => processInfo.pid),
    cycle_ts: nowMs,
  };

  return {
    ok: true,
    scanned_count: processes.length,
    candidates_count: candidates.length,
    reaped_count: reaped.length,
    reaped_pids: lastMetric.reaped_pids,
    cycle_ts: nowMs,
    reaped_total: reapedTotal,
  };
}

export function getOrphanGitReaperStatus() {
  return {
    reaped_total: reapedTotal,
    last_cycle_count: lastMetric.reaped_count,
    last_cycle_ts: lastMetric.cycle_ts,
    last_reaped_pids: [...lastMetric.reaped_pids],
  };
}

export function resetOrphanGitReaperStatus() {
  reapedTotal = 0;
  lastMetric = {
    reaped_count: 0,
    reaped_pids: [],
    cycle_ts: null,
  };
}
