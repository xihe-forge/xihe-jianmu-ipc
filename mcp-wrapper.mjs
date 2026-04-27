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

// ---------------------------------------------------------------------------
// Wrapper lifecycle
// ---------------------------------------------------------------------------

export function createMcpWrapper(options = {}) {
  const serverPath = options.serverPath ?? SERVER_PATH;
  const spawnFn = options.spawnFn ?? spawn;
  const statFn = options.statFn ?? statSync;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const nowFn = options.nowFn ?? Date.now;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;

  let child = null;
  let lastMtime = 0;
  let stdinHandler = null;
  let restartBackoffMs = RESTART_BACKOFF_BASE_MS;
  let childStartTs = 0;
  let intentionalRestart = false;

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

  function scheduleStart(delayMs) {
    return setTimeoutFn(() => {
      if (!child || child.killed) startChild();
    }, delayMs);
  }

  function startChild() {
    removeStdinHandler();

    child = spawnFn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });
    const startedChild = child;
    childStartTs = nowFn();

    stdinHandler = (data) => {
      if (child && child.stdin.writable) {
        child.stdin.write(data);
      }
    };
    stdin.on('data', stdinHandler);

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
      child.kill('SIGTERM');
      child = null;
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
    log(`received ${signal}, shutting down`);
    removeStdinHandler();
    if (child) child.kill('SIGTERM');
    process.exit(0);
  }

  function start() {
    startChild();
    setIntervalFn(pollForChange, POLL_INTERVAL);
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
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
    }),
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createMcpWrapper().start();
}
