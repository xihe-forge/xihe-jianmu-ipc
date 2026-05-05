#!/usr/bin/env node
import * as pty from '@lydell/node-pty';
import { watch } from 'node:fs';
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
let exited = false;
let ptyBridgeProcessing = false;
let ptyBridgeWatcher = null;

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

child.onData((data) => {
  process.stdout.write(rewriteTitle(data));
});

child.onExit(({ exitCode }) => {
  exitOnce(exitCode ?? 0);
});

if (ipcName) {
  process.stdout.write(titleSequence(ipcName));
}

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
    try {
      ptyBridgeWatcher?.close?.();
    } catch {}
    try {
      child.kill();
    } catch {}
  });
}
