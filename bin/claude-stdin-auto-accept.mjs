#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [, , claudeBin, ...claudeArgs] = process.argv;

if (!claudeBin) {
  process.stderr.write('usage: claude-stdin-auto-accept.mjs <claude-bin> [...args]\n');
  process.exit(2);
}

const child = spawn(claudeBin, claudeArgs, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const promptMarkers = [
  'I am using this for local development',
  'WARNING: Loading development channels',
  'Channels: server:ipc',
];

const timeoutMs = Number.parseInt(
  process.env.CLAUDE_STDIN_AUTO_ACCEPT_TIMEOUT_MS ?? '30000',
  10,
);

let acceptSent = false;

function forwardProcessStdin() {
  process.stdin.pipe(child.stdin);
}

function sendAccept() {
  if (acceptSent) return;
  acceptSent = true;
  child.stdin.write('1\n');
  forwardProcessStdin();
}

function tryAccept(chunk) {
  if (acceptSent) return;
  const text = chunk.toString();
  if (promptMarkers.some((marker) => text.includes(marker))) {
    sendAccept();
  }
}

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  tryAccept(chunk);
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  tryAccept(chunk);
});

child.once('error', (error) => {
  process.stderr.write(`[claude-stdin-auto-accept] spawn failed: ${error?.message ?? error}\n`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`[claude-stdin-auto-accept] claude exited by signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

// K.K-2: CC inquirer prompt 走 raw tty 不写 stdout·expect-style match 不到·timeout 30s 太久 user 看到 warning hang
// 改 1500ms 无条件 write '1\n' 不依赖 prompt 检测（feedback_evidence_before_assumption 实证 raw tty 模式）
const earlyWriteMs = Number.parseInt(
  process.env.CLAUDE_STDIN_AUTO_ACCEPT_EARLY_MS ?? '1500',
  10,
);
setTimeout(() => {
  if (!acceptSent && !child.killed) {
    process.stderr.write(
      `[claude-stdin-auto-accept] early write 1 at ${Number.isFinite(earlyWriteMs) ? earlyWriteMs : 1500}ms (no prompt match yet)\n`,
    );
    sendAccept();
  }
}, Number.isFinite(earlyWriteMs) && earlyWriteMs > 0 ? earlyWriteMs : 1500);

// 30s timeout 仍保留兜底·防 1500ms 太早 CC 还没起来读 stdin
setTimeout(() => {
  if (!acceptSent && !child.killed) {
    process.stderr.write('[claude-stdin-auto-accept] timeout 30s no prompt detected - force write 1\n');
    sendAccept();
  }
}, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000);
