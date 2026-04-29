#!/usr/bin/env node
import { createWriteStream, readFileSync } from 'node:fs';
import * as pty from '@lydell/node-pty';

const [, , claudeBin, ...claudeArgs] = process.argv;

if (!claudeBin) {
  process.stderr.write('usage: claude-stdin-auto-accept.mjs <claude-bin> [...args]\n');
  process.exit(2);
}

const spawnTaskFile = process.env.IPC_SPAWN_TASK_FILE?.trim();
if (spawnTaskFile) {
  try {
    claudeArgs.push('--', readFileSync(spawnTaskFile, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `[claude-stdin-auto-accept] failed to read IPC_SPAWN_TASK_FILE: ${error?.message ?? error}\n`,
    );
    process.exit(1);
  }
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
const OSC_TITLE_PATTERN = /\x1B\][012];[^\x07\x1B]*(?:\x07|\x1B\\)/g;
const LARGE_BLANK_FILL_PATTERN = /\x1B\[(?:\d+(?:;\d+)?)?[HfdGA] {100,}\r?\n?(?:\x1B\[K)?(?:\x1B\[\d+C)?/g;
const AUTO_ACCEPT_DATA = '\r';
const READY_MARKER = 'listeningforchannelmessagesfrom:server:ipc';
const ipcName = (process.env.IPC_NAME ?? '').trim();
const rawLogPath = process.env.IPC_HELPER_RAW_LOG?.trim();
let rawLogStream;
const PROMPTS = [
  {
    key: 'workspaceTrust',
    markers: [
      'quicksafetycheck',
      'isthisaprojectyoucreated',
      'oneyoutrust',
      "claudecode'llbeabletoread",
      'executefileshere',
      'yes,itrustthisfolder',
      'entertoconfirm',
    ],
    minMatches: 2,
    send: AUTO_ACCEPT_DATA,
    delayMs: 100,
    seen: new Set(),
    accepted: false,
  },
  {
    key: 'devChannels',
    markers: [
      'warning:loadingdevelopmentchannels',
      'channels:server:ipc',
      'iamusingthisforlocaldevelopment',
      'entertoconfirm',
    ],
    minMatches: 4,
    send: AUTO_ACCEPT_DATA,
    delayMs: 100,
    seen: new Set(),
    accepted: false,
  },
];
let terminalCompactTextTail = '';
let earlyAutoAcceptTimer;
let fallbackAccepted = false;
let seenListeningReady = false;

if (rawLogPath) {
  rawLogStream = createWriteStream(rawLogPath, { flags: 'a' });
  rawLogStream.on('error', (error) => {
    process.stderr.write(`[claude-stdin-auto-accept] raw PTY log failed: ${error?.message ?? error}\n`);
    rawLogStream = undefined;
  });
  process.stderr.write(`[claude-stdin-auto-accept] raw PTY log enabled: ${rawLogPath}\n`);
}

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

function titleSequence(title) {
  return `\x1b]0;${title}\x07`;
}

function rewriteTitle(data) {
  if (!ipcName) return String(data);
  return String(data).replace(OSC_TITLE_PATTERN, titleSequence(ipcName));
}

function sanitizeTerminalOutput(data) {
  return rewriteTitle(data).replace(LARGE_BLANK_FILL_PATTERN, '\x1b[2J\x1b[H');
}

function clearEarlyAutoAcceptTimer() {
  if (!earlyAutoAcceptTimer) return;
  clearTimeout(earlyAutoAcceptTimer);
  earlyAutoAcceptTimer = undefined;
}

function trySendAutoAccept(reason, { key = 'fallback', data = AUTO_ACCEPT_DATA, delayMs = 0 } = {}) {
  if (seenListeningReady) {
    debug(`auto accept skipped reason=${reason} key=${key} ready_seen=true`);
    return false;
  }

  clearEarlyAutoAcceptTimer();
  debug(`auto accept scheduled reason=${reason} key=${key} data=${JSON.stringify(data)} delay_ms=${delayMs}`);
  setTimeout(() => {
    if (seenListeningReady) {
      debug(`auto accept write skipped reason=${reason} key=${key} ready_seen=true`);
      return;
    }
    debug(`auto accept write reason=${reason} key=${key} data=${JSON.stringify(data)}`);
    child.write(data);
  }, delayMs);

  return true;
}

function writeEarlyAutoAccept() {
  if (fallbackAccepted) return false;
  fallbackAccepted = true;
  return trySendAutoAccept('fallback', { key: 'fallback', data: AUTO_ACCEPT_DATA });
}

function schedulePromptConfirm(key, data, delayMs) {
  trySendAutoAccept('prompt-detected', { key, data, delayMs });
}

function markReadySeen() {
  clearEarlyAutoAcceptTimer();
  debug('claude channel listener ready before auto accept fallback');
}

function includesMarker(compact, marker) {
  return compact.includes(marker) || terminalCompactTextTail.includes(marker);
}

function maybeConfirmPrompt(data) {
  const compact = compactTerminalText(data);
  terminalCompactTextTail = `${terminalCompactTextTail}${compact}`.slice(-8192);

  if (!seenListeningReady && includesMarker(compact, READY_MARKER)) {
    seenListeningReady = true;
    markReadySeen();
    return;
  }

  if (seenListeningReady) return;

  for (const prompt of PROMPTS) {
    if (prompt.accepted) continue;

    for (const marker of prompt.markers) {
      if (!prompt.seen.has(marker) && includesMarker(compact, marker)) {
        prompt.seen.add(marker);
      }
    }

    if (prompt.seen.size >= prompt.minMatches) {
      prompt.accepted = true;
      debug(`prompt ${prompt.key} detected (${prompt.seen.size}/${prompt.markers.length} markers)`);
      schedulePromptConfirm(prompt.key, prompt.send, prompt.delayMs);
    }
  }
}

child.onData((data) => {
  rawLogStream?.write(data);
  process.stdout.write(sanitizeTerminalOutput(data));
  maybeConfirmPrompt(data);
});

child.onExit(({ exitCode }) => {
  if (rawLogStream) {
    rawLogStream.end(() => {
      process.exit(exitCode ?? 0);
    });
    return;
  }
  process.exit(exitCode ?? 0);
});

const earlyWriteMs = Number.parseInt(
  process.env.CLAUDE_STDIN_AUTO_ACCEPT_EARLY_MS ?? '7000',
  10,
);

earlyAutoAcceptTimer = setTimeout(() => {
  writeEarlyAutoAccept();
}, Number.isFinite(earlyWriteMs) && earlyWriteMs > 0 ? earlyWriteMs : 7000);

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
