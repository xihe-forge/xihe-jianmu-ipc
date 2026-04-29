import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wrapperSource = readFileSync(
  join(__dirname, '..', 'bin', 'claude-stdin-auto-accept.mjs'),
  'utf8',
);

describe('ADR-014 Phase 2 K.M stdin auto-accept legacy expect removal', () => {
  test('wrapper uses a node-pty implementation and spawns Claude inside a real PTY', () => {
    assert.match(wrapperSource, /from '@lydell\/node-pty'|from 'node-pty-prebuilt-multiarch'/);
    assert.match(wrapperSource, /pty\.spawn\(claudeBin, claudeArgs, \{/);
    assert.match(wrapperSource, /name: 'xterm-256color'/);
    assert.match(wrapperSource, /cols: process\.stdout\.columns \|\| 120/);
    assert.match(wrapperSource, /rows: process\.stdout\.rows \|\| 30/);
    assert.match(wrapperSource, /cwd: process\.cwd\(\)/);
    assert.match(wrapperSource, /env: process\.env/);
  });

  test("early accept writes '1\\r' through PTY input after the 1.5s default guard", () => {
    assert.match(wrapperSource, /CLAUDE_STDIN_AUTO_ACCEPT_EARLY_MS \?\? '1500'/);
    assert.match(wrapperSource, /setTimeout\(\(\) => \{\s*writeEarlyAutoAccept\(\);/s);
    assert.match(wrapperSource, /writeAutoAccept\('1\\r'\);/);
    assert.match(wrapperSource, /\? earlyWriteMs : 1500\)/);
  });

  test('PTY output, parent stdin, and terminal resize are forwarded', () => {
    assert.match(wrapperSource, /child\.onData\(\(data\) => \{\s*process\.stdout\.write\(data\);/s);
    assert.match(wrapperSource, /maybeConfirmDevelopmentChannelPrompt\(data\)/);
    assert.match(wrapperSource, /writeAutoAccept\('\\r', 100\)/);
    assert.match(wrapperSource, /process\.stdin\.setRawMode\?\.\(true\)/);
    assert.match(wrapperSource, /process\.stdin\.on\('data', \(data\) => \{\s*child\.write\(data\);/s);
    assert.match(wrapperSource, /process\.stdout\.on\('resize', \(\) => \{\s*child\.resize\(/s);
  });

  test('legacy fake tty expect and pipe-stdin paths stay removed', () => {
    assert.doesNotMatch(wrapperSource, /from 'node:child_process'/);
    assert.doesNotMatch(wrapperSource, /promptMarkers/);
    assert.doesNotMatch(wrapperSource, /tryAccept/);
    assert.doesNotMatch(wrapperSource, /sendAccept/);
    assert.doesNotMatch(wrapperSource, /CLAUDE_STDIN_AUTO_ACCEPT_TIMEOUT_MS/);
    assert.doesNotMatch(wrapperSource, /stdio: \['pipe', 'pipe', 'pipe'\]/);
    assert.doesNotMatch(wrapperSource, /child\.stdin\.write\('1\\n'\)/);
  });
});
