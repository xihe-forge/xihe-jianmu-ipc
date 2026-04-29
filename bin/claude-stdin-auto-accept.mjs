#!/usr/bin/env node
import * as pty from '@lydell/node-pty';

const [, , claudeBin, ...claudeArgs] = process.argv;

if (!claudeBin) {
  process.stderr.write('usage: claude-stdin-auto-accept.mjs <claude-bin> [...args]\n');
  process.exit(2);
}

let child;
try {
  child = pty.spawn(claudeBin, claudeArgs, {
    name: 'xterm-256color',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env,
  });
} catch (error) {
  process.stderr.write(`[claude-stdin-auto-accept] pty spawn failed: ${error?.message ?? error}\n`);
  process.exit(1);
}

const ANSI_ESCAPE_PATTERN = /(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_])/g;
let terminalTextTail = '';
let promptConfirmScheduled = false;

function debug(message) {
  if (process.env.CLAUDE_STDIN_AUTO_ACCEPT_DEBUG !== '1') return;
  process.stderr.write(`[claude-stdin-auto-accept] ${message}\n`);
}

function normalizeTerminalText(data) {
  return String(data)
    .replace(ANSI_ESCAPE_PATTERN, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ');
}

function writeAutoAccept(data, delayMs = 0) {
  debug(`auto accept scheduled data=${JSON.stringify(data)} delay_ms=${delayMs}`);
  setTimeout(() => {
    debug(`auto accept write data=${JSON.stringify(data)}`);
    child.write(data);
  }, delayMs);
}

function writeEarlyAutoAccept() {
  if (promptConfirmScheduled) return;
  writeAutoAccept('1\r');
}

function schedulePromptConfirm() {
  if (promptConfirmScheduled) return;
  promptConfirmScheduled = true;
  writeAutoAccept('\r', 100);
}

function maybeConfirmDevelopmentChannelPrompt(data) {
  terminalTextTail = `${terminalTextTail}${normalizeTerminalText(data)}`.slice(-4096);
  const hasDevelopmentWarning =
    terminalTextTail.includes('WARNING: Loading development channels') ||
    terminalTextTail.includes('I am using this for local development') ||
    terminalTextTail.includes('Channels: server:ipc');
  const hasDefaultConfirm =
    terminalTextTail.includes('Enter to confirm') ||
    terminalTextTail.includes('I am using this for local development');

  if (hasDevelopmentWarning && hasDefaultConfirm) {
    debug('development-channel prompt detected');
    schedulePromptConfirm();
  }
}

child.onData((data) => {
  process.stdout.write(data);
  maybeConfirmDevelopmentChannelPrompt(data);
});

child.onExit(({ exitCode }) => {
  process.exit(exitCode ?? 0);
});

const earlyWriteMs = Number.parseInt(
  process.env.CLAUDE_STDIN_AUTO_ACCEPT_EARLY_MS ?? '1500',
  10,
);

setTimeout(() => {
  writeEarlyAutoAccept();
}, Number.isFinite(earlyWriteMs) && earlyWriteMs > 0 ? earlyWriteMs : 1500);

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  child.write(data);
});

process.stdout.on('resize', () => {
  child.resize(process.stdout.columns || 120, process.stdout.rows || 30);
});
