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
const AUTO_ACCEPT_DATA = '\r';
let terminalCompactTextTail = '';
let autoAcceptScheduled = false;
let earlyAutoAcceptTimer;
let seenDevelopmentWarning = false;
let seenDevelopmentChannel = false;
let seenDefaultConfirm = false;
let seenEnterConfirm = false;
let seenListeningReady = false;

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

function compactTerminalText(data) {
  return normalizeTerminalText(data).replace(/\s+/g, '').toLowerCase();
}

function clearEarlyAutoAcceptTimer() {
  if (!earlyAutoAcceptTimer) return;
  clearTimeout(earlyAutoAcceptTimer);
  earlyAutoAcceptTimer = undefined;
}

function trySendAutoAccept(reason, delayMs = 0) {
  if (autoAcceptScheduled) {
    debug(`auto accept skipped reason=${reason}`);
    return false;
  }

  autoAcceptScheduled = true;
  clearEarlyAutoAcceptTimer();
  debug(`auto accept scheduled reason=${reason} data=${JSON.stringify(AUTO_ACCEPT_DATA)} delay_ms=${delayMs}`);
  setTimeout(() => {
    debug(`auto accept write reason=${reason} data=${JSON.stringify(AUTO_ACCEPT_DATA)}`);
    child.write(AUTO_ACCEPT_DATA);
  }, delayMs);

  return true;
}

function writeEarlyAutoAccept() {
  trySendAutoAccept('fallback');
}

function schedulePromptConfirm() {
  trySendAutoAccept('prompt-detected', 100);
}

function markReadySeen() {
  if (autoAcceptScheduled) return;
  autoAcceptScheduled = true;
  clearEarlyAutoAcceptTimer();
  debug('claude channel listener ready before auto accept fallback');
}

function maybeConfirmDevelopmentChannelPrompt(data) {
  const compact = compactTerminalText(data);
  terminalCompactTextTail = `${terminalCompactTextTail}${compact}`.slice(-8192);

  if (!seenListeningReady && terminalCompactTextTail.includes('listeningforchannelmessagesfrom:server:ipc')) {
    seenListeningReady = true;
    markReadySeen();
    return;
  }

  if (!seenDevelopmentWarning && compact.includes('warning:loadingdevelopmentchannels')) {
    seenDevelopmentWarning = true;
  }
  if (!seenDevelopmentChannel && compact.includes('channels:server:ipc')) {
    seenDevelopmentChannel = true;
  }
  if (!seenDefaultConfirm && compact.includes('iamusingthisforlocaldevelopment')) {
    seenDefaultConfirm = true;
  }
  if (!seenEnterConfirm && compact.includes('entertoconfirm')) {
    seenEnterConfirm = true;
  }

  if (seenDevelopmentWarning && seenDevelopmentChannel && seenDefaultConfirm && seenEnterConfirm) {
    debug('development-channel prompt detected (persistent flags)');
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
  process.env.CLAUDE_STDIN_AUTO_ACCEPT_EARLY_MS ?? '7000',
  10,
);

earlyAutoAcceptTimer = setTimeout(() => {
  writeEarlyAutoAccept();
}, Number.isFinite(earlyWriteMs) && earlyWriteMs > 0 ? earlyWriteMs : 7000);

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  child.write(data);
});

process.stdout.on('resize', () => {
  child.resize(process.stdout.columns || 120, process.stdout.rows || 30);
});
