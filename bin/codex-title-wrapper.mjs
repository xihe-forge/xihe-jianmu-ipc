#!/usr/bin/env node
import * as pty from '@lydell/node-pty';

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
let exited = false;

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

child.onData((data) => {
  process.stdout.write(rewriteTitle(data));
});

child.onExit(({ exitCode }) => {
  exitOnce(exitCode ?? 0);
});

if (ipcName) {
  process.stdout.write(titleSequence(ipcName));
}

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
      child.kill();
    } catch {}
  });
}
