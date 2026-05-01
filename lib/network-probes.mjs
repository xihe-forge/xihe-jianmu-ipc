import { resolve as dnsResolve } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const CLI_PROXY_URL = 'http://127.0.0.1:8317/healthz';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function normalizeLatency(startedAt, now) {
  const elapsed = Number(now()) - Number(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return 0;
  }
  return elapsed;
}

function timeoutError(timeoutMs) {
  const error = new Error(`timeout after ${timeoutMs}ms`);
  error.code = 'ETIMEDOUT';
  return error;
}

function normalizeError(error) {
  if (!error) {
    return 'unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error.name === 'AbortError') {
    return 'timeout';
  }
  if (error.code === 'ETIMEDOUT') {
    return 'timeout';
  }
  if (error.code && error.message) {
    return `${error.code}: ${error.message}`;
  }
  if (error.code) {
    return String(error.code);
  }
  if (error.message) {
    return error.message;
  }
  return String(error);
}

async function runWithTimeout(runner, timeoutMs) {
  let timer = null;
  const controller = new AbortController();
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => runner(controller.signal)),
      timeoutPromise,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sampleWindowsCommittedPct() {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', [
      '-NoProfile',
      '-Command',
      "(Get-Counter '\\Memory\\% Committed Bytes In Use' -EA Stop).CounterSamples[0].CookedValue",
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
        reject(new Error(`Get-Counter exit ${code}: ${stderr.trim()}`));
        return;
      }
      const pct = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(pct)) {
        reject(new Error(`invalid committed_pct: ${stdout.trim()}`));
        return;
      }
      resolve(pct);
    });
    child.on('error', reject);
  });
}

async function sampleProcMeminfoCommittedPct() {
  const text = await readFile('/proc/meminfo', 'utf8');
  const values = Object.fromEntries(
    text.split('\n').map((line) => {
      const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/);
      return match ? [match[1], Number.parseInt(match[2], 10)] : null;
    }).filter(Boolean),
  );
  if (!Number.isFinite(values.MemTotal) || values.MemTotal <= 0 || !Number.isFinite(values.MemAvailable)) {
    throw new Error('not-supported');
  }
  return ((values.MemTotal - values.MemAvailable) / values.MemTotal) * 100;
}

function sampleWindowsAvailableRamMb() {
  return new Promise((resolveAvailableRam, rejectAvailableRam) => {
    const child = spawn('pwsh', [
      '-NoProfile',
      '-Command',
      "(Get-Counter '\\Memory\\Available MBytes' -EA Stop).CounterSamples[0].CookedValue",
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
        rejectAvailableRam(new Error(`Get-Counter exit ${code}: ${stderr.trim()}`));
        return;
      }
      const availableMb = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(availableMb)) {
        rejectAvailableRam(new Error(`invalid available_ram_mb: ${stdout.trim()}`));
        return;
      }
      resolveAvailableRam(availableMb);
    });
    child.on('error', rejectAvailableRam);
  });
}

function sampleWindowsCpuUsedPct({ spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  return new Promise((resolveCpu, rejectCpu) => {
    const child = spawnImpl('pwsh', [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
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
        rejectCpu(new Error(`cpu_used_pct sample exit ${code}: ${stderr.trim()}`));
        return;
      }
      const pct = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(pct)) {
        rejectCpu(new Error(`invalid cpu_used_pct sample: ${stdout.trim()}`));
        return;
      }
      resolveCpu(pct);
    });
    child.on('error', rejectCpu);
  });
}

function sampleWindowsDiskUsedPct({ spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  return new Promise((resolveDisk, rejectDisk) => {
    const child = spawnImpl('pwsh', [
      '-NoProfile',
      '-Command',
      "$ErrorActionPreference='Stop'; Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json -Compress",
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
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
        rejectDisk(new Error(`disk_used_pct sample exit ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim() || '[]');
        resolveDisk(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        rejectDisk(new Error(`invalid disk_used_pct sample: ${stdout.trim()}`));
      }
    });
    child.on('error', rejectDisk);
  });
}

function sampleWindowsOrphanGitProcesses({ spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  return new Promise((resolveGitProcesses, rejectGitProcesses) => {
    const child = spawnImpl('pwsh', [
      '-NoProfile',
      '-Command',
      [
        "$ErrorActionPreference='Stop'",
        "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object {",
        '  $ppid = [int]$_.ParentProcessId',
        '  $parentAlive = $false',
        '  if ($ppid -gt 0) { $parentAlive = [bool](Get-Process -Id $ppid -EA SilentlyContinue) }',
        '  [pscustomobject]@{ ProcessId=[int]$_.ProcessId; ParentProcessId=$ppid; CreationDate=$_.CreationDate; ParentAlive=$parentAlive }',
        '} | ConvertTo-Json -Compress',
      ].join('\n'),
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
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
        rejectGitProcesses(new Error(`orphan_git sample exit ${code}: ${stderr.trim()}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        resolveGitProcesses([]);
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolveGitProcesses(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        rejectGitProcesses(new Error(`invalid orphan_git sample: ${text}`));
      }
    });
    child.on('error', rejectGitProcesses);
  });
}

async function sampleProcMeminfoAvailableRamMb() {
  const text = await readFile('/proc/meminfo', 'utf8');
  const match = text.split('\n').find((line) => line.startsWith('MemAvailable:'))
    ?.match(/^MemAvailable:\s+(\d+)\s+kB$/);
  if (!match) {
    throw new Error('not-supported');
  }
  return Number.parseInt(match[1], 10) / 1024;
}

async function defaultSampleCommittedPct() {
  if (process.platform === 'win32') {
    return sampleWindowsCommittedPct();
  }
  if (process.platform === 'linux') {
    return sampleProcMeminfoCommittedPct();
  }
  return null;
}

async function defaultSampleAvailableRamMb() {
  if (process.platform === 'win32') {
    return sampleWindowsAvailableRamMb();
  }
  if (process.platform === 'linux') {
    return sampleProcMeminfoAvailableRamMb();
  }
  return null;
}

async function defaultSampleCpuUsedPct(options = {}) {
  if (process.platform === 'win32') {
    return sampleWindowsCpuUsedPct(options);
  }
  return null;
}

async function defaultSampleDiskUsedPct(options = {}) {
  if (process.platform === 'win32') {
    return sampleWindowsDiskUsedPct(options);
  }
  return null;
}

async function defaultSampleOrphanGitProcesses(options = {}) {
  if (process.platform === 'win32') {
    return sampleWindowsOrphanGitProcesses(options);
  }
  return null;
}

async function measureProbe({ timeoutMs, now = Date.now, runner, evaluate }) {
  const startedAt = now();

  try {
    const response = await runWithTimeout(runner, timeoutMs);
    const result = evaluate(response);
    return {
      ok: !!result.ok,
      latencyMs: normalizeLatency(startedAt, now),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: normalizeLatency(startedAt, now),
      error: normalizeError(error),
    };
  }
}

export async function probeCliProxy({
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return measureProbe({
    timeoutMs,
    now,
    runner: (signal) => fetchImpl(CLI_PROXY_URL, {
      method: 'GET',
      signal,
    }),
    evaluate: (response) => {
      if (response.status >= 500) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true };
    },
  });
}

export async function probeHub({
  port = 3179,
  timeoutMs = 2000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return measureProbe({
    timeoutMs,
    now,
    runner: (signal) => fetchImpl(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal,
    }),
    evaluate: (response) => {
      if (response.status !== 200) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true };
    },
  });
}

export async function probeAnthropic({
  timeoutMs = 10000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return measureProbe({
    timeoutMs,
    now,
    runner: (signal) => fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: 'GET',
      signal,
    }),
    evaluate: (response) => {
      if (response.status >= 500) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true };
    },
  });
}

export async function probeDns({
  host = 'github.com',
  timeoutMs = 3000,
  resolveImpl = dnsResolve,
  now = Date.now,
} = {}) {
  return measureProbe({
    timeoutMs,
    now,
    runner: () => resolveImpl(host),
    evaluate: () => ({ ok: true }),
  });
}

export async function probeCommittedPct({
  timeoutMs = 5000,
  now = Date.now,
  sample = defaultSampleCommittedPct,
} = {}) {
  const startedAt = now();

  try {
    const pct = await runWithTimeout(() => sample(), timeoutMs);
    if (pct == null) {
      return {
        ok: true,
        pct: null,
        latencyMs: normalizeLatency(startedAt, now),
      };
    }
    const parsedPct = Number(pct);
    if (!Number.isFinite(parsedPct)) {
      throw new Error(`invalid committed_pct: ${pct}`);
    }
    return {
      ok: true,
      pct: parsedPct,
      latencyMs: normalizeLatency(startedAt, now),
    };
  } catch (error) {
    return {
      ok: false,
      pct: null,
      latencyMs: normalizeLatency(startedAt, now),
      error: normalizeError(error),
    };
  }
}

export async function probeAvailableRamMb({
  timeoutMs = 5000,
  now = Date.now,
  sample = defaultSampleAvailableRamMb,
} = {}) {
  const startedAt = now();

  try {
    const availableMb = await runWithTimeout(() => sample(), timeoutMs);
    if (availableMb == null) {
      return {
        ok: true,
        availableMb: null,
        latencyMs: normalizeLatency(startedAt, now),
      };
    }
    const parsedAvailableMb = Number(availableMb);
    if (!Number.isFinite(parsedAvailableMb) || parsedAvailableMb < 0) {
      throw new Error(`invalid available_ram_mb: ${availableMb}`);
    }
    return {
      ok: true,
      availableMb: parsedAvailableMb,
      latencyMs: normalizeLatency(startedAt, now),
    };
  } catch (error) {
    return {
      ok: false,
      availableMb: null,
      latencyMs: normalizeLatency(startedAt, now),
      error: normalizeError(error),
    };
  }
}

export async function probeCpuUsedPct({
  timeoutMs = 5000,
  now = Date.now,
  sample = defaultSampleCpuUsedPct,
  spawnImpl = spawn,
} = {}) {
  const startedAt = now();

  try {
    const pct = await runWithTimeout(() => sample({ spawnImpl, timeoutMs }), timeoutMs);
    const ts = now();
    if (pct == null) {
      return {
        ok: true,
        pct: null,
        latencyMs: normalizeLatency(startedAt, now),
        ts,
      };
    }
    const parsedPct = Number(pct);
    if (!Number.isFinite(parsedPct) || parsedPct < 0) {
      throw new Error(`invalid cpu_used_pct: ${pct}`);
    }
    return {
      ok: true,
      pct: Math.min(100, parsedPct),
      latencyMs: normalizeLatency(startedAt, now),
      ts,
    };
  } catch (error) {
    return {
      ok: false,
      pct: null,
      latencyMs: normalizeLatency(startedAt, now),
      error: normalizeError(error),
      ts: now(),
    };
  }
}

export async function probeDiskUsedPct({
  timeoutMs = 5000,
  now = Date.now,
  sample = defaultSampleDiskUsedPct,
  spawnImpl = spawn,
} = {}) {
  const startedAt = now();

  try {
    const rawDrives = await runWithTimeout(() => sample({ spawnImpl, timeoutMs }), timeoutMs);
    const ts = now();
    if (rawDrives == null) {
      return {
        ok: true,
        drives: [],
        maxUsedPct: null,
        latencyMs: normalizeLatency(startedAt, now),
        ts,
      };
    }
    if (!Array.isArray(rawDrives)) {
      throw new Error('invalid disk_used_pct sample');
    }
    const drives = rawDrives.map((drive) => {
      const freeBytes = Number(drive.FreeSpace ?? drive.freeBytes);
      const sizeBytes = Number(drive.Size ?? drive.sizeBytes);
      const name = String(drive.DeviceID ?? drive.drive ?? '').trim();
      if (!name || !Number.isFinite(freeBytes) || !Number.isFinite(sizeBytes) || sizeBytes <= 0 || freeBytes < 0) {
        throw new Error('invalid disk_used_pct sample');
      }
      return {
        drive: name,
        usedPct: Math.round(((sizeBytes - freeBytes) / sizeBytes) * 1000) / 10,
        freeBytes,
        sizeBytes,
      };
    });
    const maxUsedPct = drives.length > 0 ? Math.max(...drives.map((drive) => drive.usedPct)) : null;
    return {
      ok: true,
      drives,
      maxUsedPct,
      latencyMs: normalizeLatency(startedAt, now),
      ts,
    };
  } catch (error) {
    return {
      ok: false,
      drives: [],
      maxUsedPct: null,
      latencyMs: normalizeLatency(startedAt, now),
      error: normalizeError(error),
      ts: now(),
    };
  }
}

function parseWindowsCimDate(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const text = value.trim();
  const dotNetMatch = text.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
  if (dotNetMatch) {
    const parsed = Number.parseInt(dotNetMatch[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const wmiMatch = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?([+-]\d{3})?$/);
  if (wmiMatch) {
    const [, year, month, day, hour, minute, second, fraction = '0', offset] = wmiMatch;
    const millis = Number.parseInt(fraction.slice(0, 3).padEnd(3, '0'), 10);
    const utc = Date.UTC(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
      millis,
    );
    if (!Number.isFinite(utc)) return null;
    if (!offset) return utc;
    const offsetMinutes = Number.parseInt(offset, 10);
    return Number.isFinite(offsetMinutes) ? utc - offsetMinutes * 60_000 : utc;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function probeOrphanGitProcesses({
  timeoutMs = 5000,
  now = Date.now,
  minAgeMs = 5 * 60 * 1000,
  sample = defaultSampleOrphanGitProcesses,
  spawnImpl = spawn,
} = {}) {
  const startedAt = now();

  try {
    const rawProcesses = await runWithTimeout(() => sample({ spawnImpl, timeoutMs }), timeoutMs);
    const ts = now();
    if (rawProcesses == null) {
      return {
        ok: true,
        total: 0,
        orphans: [],
        maxAgeMs: 0,
        latencyMs: normalizeLatency(startedAt, now),
        ts,
      };
    }
    if (!Array.isArray(rawProcesses)) {
      throw new Error('invalid orphan_git sample');
    }

    const processes = rawProcesses.map((processInfo) => {
      const pid = Number(processInfo.ProcessId ?? processInfo.pid);
      const ppid = Number(processInfo.ParentProcessId ?? processInfo.ppid);
      const createdAt = parseWindowsCimDate(processInfo.CreationDate ?? processInfo.createdAt);
      const ageMs = createdAt == null ? null : Math.max(0, ts - createdAt);
      return {
        pid,
        ppid,
        ageMs,
        parentAlive: processInfo.ParentAlive ?? processInfo.parentAlive,
      };
    }).filter((processInfo) => Number.isInteger(processInfo.pid) && Number.isInteger(processInfo.ppid));

    const orphans = processes
      .filter((processInfo) => processInfo.parentAlive === false
        && Number.isFinite(processInfo.ageMs)
        && processInfo.ageMs >= minAgeMs)
      .map(({ pid, ppid, ageMs }) => ({ pid, ppid, ageMs }));
    const maxAgeMs = orphans.length > 0 ? Math.max(...orphans.map((processInfo) => processInfo.ageMs)) : 0;
    return {
      ok: true,
      total: processes.length,
      orphans,
      maxAgeMs,
      latencyMs: normalizeLatency(startedAt, now),
      ts,
    };
  } catch (error) {
    return {
      ok: false,
      total: 0,
      orphans: [],
      maxAgeMs: 0,
      latencyMs: normalizeLatency(startedAt, now),
      error: normalizeError(error),
      ts: now(),
    };
  }
}
