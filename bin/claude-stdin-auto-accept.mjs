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

child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);

child.once('error', (error) => {
  process.stderr.write(`[claude-stdin-auto-accept] spawn failed: ${error?.message ?? error}\n`);
  process.exit(1);
});

child.stdin.end('1\n');

child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`[claude-stdin-auto-accept] claude exited by signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
