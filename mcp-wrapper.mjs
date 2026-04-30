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

export const RESTART_BACKOFF_BASE_MS = 500;
export const RESTART_BACKOFF_MAX_MS = 16_000;
export const STABILITY_WINDOW_MS = 60_000;
export const WRAPPER_SHUTDOWN_TIMEOUT_MS = 4_500;

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
  const exitFn = options.exitFn ?? ((code) => process.exit(code));
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? WRAPPER_SHUTDOWN_TIMEOUT_MS;

  let child = null;
  let lastMtime = 0;
  let stdinHandler = null;
  let stdinEndHandler = null;
  let stdinCloseHandler = null;
  let pollInterval = null;
  let shutdownTimer = null;
  let restartBackoffMs = RESTART_BACKOFF_BASE_MS;
  let childStartTs = 0;
  let intentionalRestart = false;
  let isShuttingDown = false;
  let didExit = false;
  const signalHandlers = new Map();

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

    child = spawnFn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
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
        restartBackoffMs = RESTART_BACKOFF_BASE_MS;
      }

      if (intentionalRestart) {
        intentionalRestart = false;
        return;
      }

      const delayMs = restartBackoffMs;
      log(`scheduling restart in ${delayMs}ms`);
      scheduleStart(delayMs);
      restartBackoffMs = Math.min(restartBackoffMs * 2, RESTART_BACKOFF_MAX_MS);
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
      restartBackoffMs,
      childStartTs,
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
