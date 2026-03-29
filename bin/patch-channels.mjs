#!/usr/bin/env node
/**
 * Patches Claude Code's cli.js to skip the dev channels warning dialog.
 * Run this right before starting claude with --dangerously-load-development-channels.
 *
 * Usage: node patch-channels.mjs && claude --dangerously-load-development-channels server:ipc
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

// Find claude's cli.js
const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
const cliPath = join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');

const content = readFileSync(cliPath, 'utf8');

// Support multiple known patterns across Claude Code versions
const patterns = [
  // v1.x (original)
  { target: 'if(!w()||!j()?.accessToken)gd', replacement: 'if(true)gd' },
  // v2.x+ (updated variable names)
  { target: 'if(!w()||!j()?.accessToken)cd', replacement: 'if(true)cd' },
];

const alreadyPatched = patterns.some(({ replacement }) => content.includes(replacement));
if (alreadyPatched) {
  process.stderr.write('[patch] already patched\n');
} else {
  const matched = patterns.find(({ target }) => content.includes(target));
  if (matched) {
    writeFileSync(cliPath, content.replace(matched.target, matched.replacement));
    process.stderr.write('[patch] patched successfully\n');
  } else {
    process.stderr.write('[patch] WARNING: target pattern not found, Claude Code may have updated\n');
  }
}
