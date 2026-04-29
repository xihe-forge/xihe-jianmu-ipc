import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWtLaunchCommand,
  buildWtSpawnArgs,
  buildWtStartCommand,
} from '../mcp-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(__dirname, '..', 'mcp-server.mjs'), 'utf8');
const wrapperSource = readFileSync(
  join(__dirname, '..', 'bin', 'claude-stdin-auto-accept.mjs'),
  'utf8',
);
const DEV_CHANNEL_FLAG = '--dangerously-load-development-channels server:ipc';

function extractFunctionSource(name) {
  const start = serverSource.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const nextFunction = serverSource.indexOf('\nfunction ', start + 1);
  const nextExportFunction = serverSource.indexOf('\nexport function ', start + 1);
  const candidates = [nextFunction, nextExportFunction].filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : serverSource.length;
  return serverSource.slice(start, end);
}

function decodePowerShellCommand(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

function decodePowerShellCommandFromHint(commandHint) {
  const match = commandHint.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
  assert.ok(match, `missing -EncodedCommand: ${commandHint}`);
  return decodePowerShellCommand(match[1]);
}

describe('ADR-014 Phase 2 K.M spawn stdin auto-accept', () => {
  test('PowerShell spawn commands pipe 1 into Claude and keep the dev channel flag', () => {
    const interactiveCommandSource = extractFunctionSource('buildInteractiveCommand');
    const wslScriptSource = serverSource.slice(
      serverSource.indexOf('const ps1Content = ['),
      serverSource.indexOf('_wfs(tmpPs1Wsl, ps1Content,', serverSource.indexOf('const ps1Content = [')),
    );

    assert.match(interactiveCommandSource, /;\s*'1'\s*\|\s*claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc/);
    assert.match(interactiveCommandSource, new RegExp(DEV_CHANNEL_FLAG));
    assert.match(wslScriptSource, /`'1'\s*\|\s*& '\$\{claudeCmd\}' --dangerously-skip-permissions --dangerously-load-development-channels server:ipc/);
    assert.match(wslScriptSource, new RegExp(DEV_CHANNEL_FLAG));
  });

  test('Windows Terminal launchers use stdin auto-accept wrapper without changing launch args', () => {
    const launchCommand = buildWtLaunchCommand({ sessionName: 'kk-launch', model: undefined });
    const startCommand = buildWtStartCommand({
      sessionName: 'kk-start',
      model: 'opus',
      cwd: 'D:/workspace/test',
    });
    const spawnArgs = buildWtSpawnArgs({
      sessionName: 'kk-smoke',
      model: 'opus',
      cwd: 'D:/workspace/test',
    });
    const innerCmd = decodePowerShellCommand(spawnArgs[spawnArgs.indexOf('--') + 5]);
    const decodedStartCommand = decodePowerShellCommandFromHint(startCommand);

    for (const cmd of [launchCommand, decodedStartCommand, innerCmd]) {
      assert.match(cmd, /claude-stdin-auto-accept\.mjs' '.*claude\.exe' --dangerously-skip-permissions --dangerously-load-development-channels server:ipc/);
      assert.match(cmd, new RegExp(DEV_CHANNEL_FLAG));
    }
    assert.match(wrapperSource, /from '@lydell\/node-pty'|from 'node-pty-prebuilt-multiarch'/);
    assert.match(wrapperSource, /pty\.spawn\(claudeBin, claudeArgs/);
    assert.match(wrapperSource, /child\.onData\(\(data\) =>/);
    assert.match(wrapperSource, /const AUTO_ACCEPT_DATA = '\\r'/);
    assert.match(wrapperSource, /trySendAutoAccept\('fallback', \{ key: 'fallback', data: AUTO_ACCEPT_DATA \}\)/);
    assert.match(wrapperSource, /maybeConfirmPrompt\(data\)/);
    assert.match(wrapperSource, /process\.stdin\.on\('data'/);
    assert.doesNotMatch(wrapperSource, /from 'node:child_process'/);
    assert.doesNotMatch(wrapperSource, /stdio: \['pipe', 'pipe', 'pipe'\]/);
    assert.doesNotMatch(wrapperSource, /child\.stdin\.write\('1\\n'\)/);

    const launchArgsSource = extractFunctionSource('buildClaudeLaunchArgs');
    assert.doesNotMatch(launchArgsSource, /echo 1 \||'1'\s*\|/);
  });

  test('bash fallback commands pipe echo "1" into Claude and keep the dev channel flag', () => {
    const bashCommands = [
      ...serverSource.matchAll(/`IPC_NAME='\$\{sessionName\}' bash -c 'echo "1" \| claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc'`/g),
    ];

    assert.equal(bashCommands.length, 2, 'native terminal and fallback bash paths should both auto-accept');
    for (const [cmd] of bashCommands) {
      assert.match(cmd, /echo "1" \| claude/);
      assert.match(cmd, new RegExp(DEV_CHANNEL_FLAG));
    }
  });
});
