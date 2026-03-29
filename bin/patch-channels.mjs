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

let content = readFileSync(cliPath, 'utf8');
let patched = false;

// Patch 1: Skip dev channels warning dialog
// Support multiple known patterns across Claude Code versions
const channelPatterns = [
  // v1.x (original)
  { target: 'if(!w()||!j()?.accessToken)gd', replacement: 'if(true)gd' },
  // v2.x+ (updated variable names)
  { target: 'if(!w()||!j()?.accessToken)cd', replacement: 'if(true)cd' },
];

const channelAlreadyPatched = channelPatterns.some(({ replacement }) => content.includes(replacement));
if (channelAlreadyPatched) {
  process.stderr.write('[patch] channels dialog: already patched\n');
} else {
  const matched = channelPatterns.find(({ target }) => content.includes(target));
  if (matched) {
    content = content.replace(matched.target, matched.replacement);
    patched = true;
    process.stderr.write('[patch] channels dialog: patched\n');
  } else {
    process.stderr.write('[patch] channels dialog: WARNING target not found\n');
  }
}

// Patch 2: Skip "trust this folder" dialog
// C2() = checkHasTrustDialogAccepted() — make it always return true
const trustPatterns = [
  { target: 'function C2(){return Kv7||=kP5()}', replacement: 'function C2(){return true}' },
  // fallback pattern if variable names changed
  { target: 'function C2(){return ', suffix: '||=kP5()}', replacement: 'function C2(){return true}' },
];

const trustAlreadyPatched = content.includes('function C2(){return true}');
if (trustAlreadyPatched) {
  process.stderr.write('[patch] trust dialog: already patched\n');
} else {
  const trustMatched = trustPatterns.find(({ target }) => content.includes(target));
  if (trustMatched) {
    content = content.replace(trustMatched.target, trustMatched.replacement);
    patched = true;
    process.stderr.write('[patch] trust dialog: patched\n');
  } else {
    process.stderr.write('[patch] trust dialog: WARNING target not found (may need manual skip)\n');
  }
}

if (patched) {
  writeFileSync(cliPath, content);
  process.stderr.write('[patch] written to cli.js\n');
}
