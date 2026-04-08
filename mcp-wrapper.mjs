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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, 'mcp-server.mjs');
const POLL_INTERVAL = 10_000; // 10s

let child = null;
let lastMtime = 0;
let stdinHandler = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMtime() {
  try {
    return statSync(SERVER_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

function log(msg) {
  process.stderr.write(`[mcp-wrapper] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Child lifecycle
// ---------------------------------------------------------------------------

function startChild() {
  child = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });

  // Manual data forwarding (not pipe) so we can rebind on restart
  stdinHandler = (data) => {
    if (child && child.stdin.writable) {
      child.stdin.write(data);
    }
  };
  process.stdin.on('data', stdinHandler);

  child.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  child.on('exit', (code, signal) => {
    log(`child exited (code=${code} signal=${signal})`);
    // Only restart on file change — not on every exit.
    // Accidental crash: next poll or manual file touch will trigger restart.
  });

  child.on('error', (err) => {
    log(`child error: ${err.message}`);
  });

  lastMtime = getMtime();
  log(`started mcp-server.mjs (pid=${child.pid})`);
}

function restartChild() {
  log('file changed, restarting mcp-server.mjs...');

  if (stdinHandler) {
    process.stdin.removeListener('data', stdinHandler);
    stdinHandler = null;
  }

  if (child) {
    child.kill('SIGTERM');
    child = null;
  }

  setTimeout(startChild, 500);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

startChild();

// ---------------------------------------------------------------------------
// File-change polling
// ---------------------------------------------------------------------------

setInterval(() => {
  const mtime = getMtime();
  if (lastMtime && mtime !== lastMtime) {
    lastMtime = mtime;
    restartChild();
  }
}, POLL_INTERVAL);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  if (stdinHandler) process.stdin.removeListener('data', stdinHandler);
  if (child) child.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
