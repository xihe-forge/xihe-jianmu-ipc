#!/usr/bin/env node
/**
 * mcp-wrapper.mjs — Auto-restart wrapper for mcp-server.mjs
 *
 * Claude Code launches this wrapper as a long-lived MCP server process.
 * The wrapper forks mcp-server.mjs as a child process and monitors its
 * mtime every 10 seconds. When the file changes, the child is killed and
 * a new one is spawned — no manual /mcp reconnect needed.
 *
 * stdout: MCP protocol (piped through from child)
 * stderr: wrapper diagnostics + child stderr (inherited)
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, 'mcp-server.mjs');
const POLL_INTERVAL = 10_000; // 10s

export const RESTART_BACKOFF_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];
export const RESTART_BACKOFF_BASE_MS = RESTART_BACKOFF_DELAYS_MS[0];
export const RESTART_BACKOFF_MAX_MS = RESTART_BACKOFF_DELAYS_MS.at(-1);
export const RESTART_PRE_ANNOUNCE_TOPIC = 'feedback_portfolio_restart_pre_announce';
export const STABILITY_WINDOW_MS = 60_000;
export const WRAPPER_SHUTDOWN_TIMEOUT_MS = 4_500;
export const WRAPPER_STARTUP_RETRY_WINDOW_MS = 10_000;
export const WRAPPER_STARTUP_IMMEDIATE_RETRIES = 1;

function parseHubPort(value) {
  const port = Number.parseInt(value ?? '', 10);
  return Number.isFinite(port) && port > 0 ? port : 3179;
}

function resolveWrapperName(env) {
  return env.IPC_NAME || env.IPC_DEFAULT_NAME || 'mcp-wrapper';
}

export function buildChildEnv(env = process.env, wrapperPid = process.pid) {
  if (env.IPC_NAME || env.IPC_DEFAULT_NAME) {
    return env;
  }

  const numericPid = Number(wrapperPid);
  const stablePid = Number.isFinite(numericPid) && numericPid > 0
    ? Math.trunc(numericPid)
    : process.pid;
  return {
    ...env,
    IPC_DEFAULT_NAME: `mcp-wrapper-${stablePid}`,
    IPC_WRAPPER_ASSIGNED_DEFAULT_NAME: '1',
  };
}

function buildRestartPreAnnounceContent({
  reason,
  delayMs,
  childPid = null,
  code = null,
  signal = null,
  aliveMs = null,
  wrapperPid = process.pid,
}) {
  return [
    `[${RESTART_PRE_ANNOUNCE_TOPIC}] mcp-wrapper restart pre-announce`,
    `reason=${reason}`,
    `delay_ms=${delayMs}`,
    `wrapper_pid=${wrapperPid}`,
    `child_pid=${childPid ?? 'n/a'}`,
    `code=${code ?? 'n/a'}`,
    `signal=${signal ?? 'n/a'}`,
    `alive_ms=${aliveMs ?? 'n/a'}`,
  ].join(' ');
}

export async function sendRestartPreAnnounce({
  env = process.env,
  fetchFn = globalThis.fetch?.bind(globalThis),
  reason,
  delayMs,
  childPid = null,
  code = null,
  signal = null,
  aliveMs = null,
  wrapperPid = process.pid,
} = {}) {
  if (env.IPC_WRAPPER_RESTART_PRE_ANNOUNCE === '0') {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (typeof fetchFn !== 'function') {
    return { ok: false, skipped: true, reason: 'fetch-unavailable' };
  }

  const host = env.IPC_HUB_HOST || '127.0.0.1';
  const port = parseHubPort(env.IPC_PORT);
  const body = {
    from: resolveWrapperName(env),
    to: '*',
    topic: RESTART_PRE_ANNOUNCE_TOPIC,
    content: buildRestartPreAnnounceContent({
      reason,
      delayMs,
      childPid,
      code,
      signal,
      aliveMs,
      wrapperPid,
    }),
  };

  const response = await fetchFn(`http://${host}:${port}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response?.ok) {
    return { ok: false, status: response?.status ?? null };
  }
  try {
    return { ok: true, ...(await response.json()) };
  } catch {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Wrapper lifecycle
// ---------------------------------------------------------------------------

export function createMcpWrapper(options = {}) {
  const serverPath = options.serverPath ?? SERVER_PATH;
  const spawnFn = options.spawnFn ?? spawn;
  const statFn = options.statFn ?? statSync;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const nowFn = options.nowFn ?? Date.now;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const processLike = options.processLike ?? process;
  const childEnv = options.childEnv ?? buildChildEnv(env, processLike.pid ?? process.pid);
  const exitFn = options.exitFn ?? ((code) => process.exit(code));
  const announceRestartFn =
    options.announceRestartFn ??
    ((detail) => sendRestartPreAnnounce({ ...detail, env: childEnv }));
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? WRAPPER_SHUTDOWN_TIMEOUT_MS;
  const startupRetryWindowMs = options.startupRetryWindowMs ?? WRAPPER_STARTUP_RETRY_WINDOW_MS;
  const startupImmediateRetries =
    options.startupImmediateRetries ?? WRAPPER_STARTUP_IMMEDIATE_RETRIES;

  let child = null;
  let lastMtime = 0;
  let stdinHandler = null;
  let stdinEndHandler = null;
  let stdinCloseHandler = null;
  let pollInterval = null;
  let shutdownTimer = null;
  let restartBackoffIndex = 0;
  let childStartTs = 0;
  let intentionalRestart = false;
  let isShuttingDown = false;
  let didExit = false;
  let startupImmediateRetryCount = 0;
  const wrapperStartedAt = nowFn();
  const signalHandlers = new Map();

  function getRestartBackoffMs() {
    return RESTART_BACKOFF_DELAYS_MS[
      Math.min(restartBackoffIndex, RESTART_BACKOFF_DELAYS_MS.length - 1)
    ];
  }

  function advanceRestartBackoff() {
    restartBackoffIndex = Math.min(
      restartBackoffIndex + 1,
      RESTART_BACKOFF_DELAYS_MS.length - 1,
    );
  }

  function resetRestartBackoff() {
    restartBackoffIndex = 0;
  }

  function shouldUseStartupImmediateRetry() {
    return (
      startupImmediateRetryCount < startupImmediateRetries &&
      nowFn() - wrapperStartedAt < startupRetryWindowMs
    );
  }

  function getMtime() {
    try {
      return statFn(serverPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  function log(msg) {
    stderr.write(`[mcp-wrapper] ${msg}\n`);
  }

  function preAnnounceRestart(detail) {
    try {
      Promise.resolve(announceRestartFn(detail))
        .then((result) => {
          if (result?.ok === false) {
            log(
              `restart pre-announce skipped/failed: ${result.reason ?? result.status ?? 'unknown'}`,
            );
          }
        })
        .catch((err) => {
          log(`restart pre-announce failed: ${err.message}`);
        });
    } catch (err) {
      log(`restart pre-announce failed: ${err.message}`);
    }
  }

  function removeStdinHandler() {
    if (stdinHandler) {
      stdin.removeListener('data', stdinHandler);
      stdinHandler = null;
    }
  }

  function removeStdinLifecycleHandlers() {
    if (stdinEndHandler) {
      stdin.removeListener('end', stdinEndHandler);
      stdinEndHandler = null;
    }
    if (stdinCloseHandler) {
      stdin.removeListener('close', stdinCloseHandler);
      stdinCloseHandler = null;
    }
  }

  function installStdinLifecycleHandlers() {
    removeStdinLifecycleHandlers();
    stdinEndHandler = () => shutdown('stdin-end');
    stdinCloseHandler = () => shutdown('stdin-close');
    stdin.once('end', stdinEndHandler);
    stdin.once('close', stdinCloseHandler);
    stdin.resume?.();
  }

  function removeProcessSignalHandlers() {
    for (const [signal, handler] of signalHandlers) {
      processLike.removeListener(signal, handler);
    }
    signalHandlers.clear();
  }

  function installProcessSignalHandlers() {
    removeProcessSignalHandlers();
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const handler = () => shutdown(signal);
      signalHandlers.set(signal, handler);
      processLike.once(signal, handler);
    }
  }

  function closeChildStdin(target) {
    const targetStdin = target?.stdin;
    if (!targetStdin) return;

    try {
      if (typeof targetStdin.end === 'function' && targetStdin.writable !== false && !targetStdin.destroyed) {
        targetStdin.end();
        return;
      }
    } catch (err) {
      log(`child stdin end error: ${err.message}`);
    }

    try {
      targetStdin.destroy?.();
    } catch (err) {
      log(`child stdin destroy error: ${err.message}`);
    }
  }

  function finishShutdown(code = 0) {
    if (didExit) return;
    didExit = true;

    removeStdinHandler();
    removeStdinLifecycleHandlers();
    removeProcessSignalHandlers();

    if (pollInterval) {
      clearIntervalFn(pollInterval);
      pollInterval = null;
    }
    if (shutdownTimer) {
      clearTimeoutFn(shutdownTimer);
      shutdownTimer = null;
    }

    exitFn(code);
  }

  function scheduleStart(delayMs) {
    return setTimeoutFn(() => {
      if (isShuttingDown) return;
      if (!child || child.killed) startChild();
    }, delayMs);
  }

  function startChild() {
    if (isShuttingDown) return null;
    removeStdinHandler();

    child = spawnFn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: childEnv,
    });
    const startedChild = child;
    childStartTs = nowFn();

    stdinHandler = (data) => {
      if (child && child.stdin.writable) {
        try {
          child.stdin.write(data);
        } catch (err) {
          log(`child stdin write error: ${err.message}`);
        }
      }
    };
    stdin.on('data', stdinHandler);

    child.stdin?.on?.('error', (err) => {
      log(`child stdin error: ${err.message}`);
    });

    child.stdout.on('data', (data) => {
      stdout.write(data);
    });

    child.on('exit', (code, signal) => {
      const aliveMs = nowFn() - childStartTs;
      log(`child exited (code=${code} signal=${signal} aliveMs=${aliveMs})`);

      if (child === startedChild) {
        removeStdinHandler();
        child = null;
      }

      if (isShuttingDown) {
        finishShutdown(0);
        return;
      }

      if (aliveMs >= STABILITY_WINDOW_MS) {
        resetRestartBackoff();
      }

      if (intentionalRestart) {
        intentionalRestart = false;
        return;
      }

      const useStartupImmediateRetry = shouldUseStartupImmediateRetry();
      const delayMs = useStartupImmediateRetry ? 0 : getRestartBackoffMs();
      if (useStartupImmediateRetry) {
        startupImmediateRetryCount += 1;
      }
      preAnnounceRestart({
        reason: 'child-exit',
        delayMs,
        childPid: startedChild.pid,
        code,
        signal,
        aliveMs,
      });
      log(`scheduling restart in ${delayMs}ms`);
      scheduleStart(delayMs);
      if (!useStartupImmediateRetry) {
        advanceRestartBackoff();
      }
    });

    child.on('error', (err) => {
      log(`child error: ${err.message}`);
    });

    lastMtime = getMtime();
    log(`started mcp-server.mjs (pid=${child.pid})`);
    return child;
  }

  function restartChild() {
    log('file changed, restarting mcp-server.mjs...');

    removeStdinHandler();
    preAnnounceRestart({
      reason: 'source-mtime-change',
      delayMs: RESTART_BACKOFF_BASE_MS,
      childPid: child?.pid ?? null,
    });

    if (child) {
      intentionalRestart = true;
      closeChildStdin(child);
      child.kill('SIGTERM');
    }

    scheduleStart(RESTART_BACKOFF_BASE_MS);
  }

  function pollForChange() {
    const mtime = getMtime();
    if (lastMtime && mtime !== lastMtime) {
      lastMtime = mtime;
      restartChild();
    }
  }

  function shutdown(signal) {
    if (isShuttingDown) return false;
    isShuttingDown = true;

    log(`received ${signal}, shutting down`);
    removeStdinHandler();
    removeStdinLifecycleHandlers();
    removeProcessSignalHandlers();
    if (pollInterval) {
      clearIntervalFn(pollInterval);
      pollInterval = null;
    }

    if (!child) {
      finishShutdown(0);
      return true;
    }

    const childToStop = child;
    closeChildStdin(childToStop);
    childToStop.kill('SIGTERM');

    shutdownTimer = setTimeoutFn(() => {
      log(`child did not exit within ${shutdownTimeoutMs}ms, forcing wrapper exit`);
      try {
        childToStop.kill('SIGKILL');
      } catch (err) {
        log(`child SIGKILL error: ${err.message}`);
      }
      finishShutdown(0);
    }, shutdownTimeoutMs);
    shutdownTimer.unref?.();

    return true;
  }

  function start() {
    installProcessSignalHandlers();
    startChild();
    installStdinLifecycleHandlers();
    pollInterval = setIntervalFn(pollForChange, POLL_INTERVAL);
    pollInterval.unref?.();
  }

  return {
    start,
    startChild,
    restartChild,
    pollForChange,
    shutdown,
    getState: () => ({
      child,
      lastMtime,
      restartBackoffMs: getRestartBackoffMs(),
      restartBackoffIndex,
      childStartTs,
      startupImmediateRetryCount,
      wrapperStartedAt,
      intentionalRestart,
      isShuttingDown,
    }),
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createMcpWrapper().start();
}
