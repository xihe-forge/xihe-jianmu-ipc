import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWtStartCommand, buildWtLaunchCommand } from '../mcp-server.mjs';
import * as mcpServer from '../mcp-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildWtSpawnArgs = mcpServer.buildWtSpawnArgs;

function decodePowerShellCommand(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

function decodePowerShellCommandFromHint(commandHint) {
  const match = commandHint.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
  assert.ok(match, `missing -EncodedCommand: ${commandHint}`);
  return decodePowerShellCommand(match[1]);
}

describe('AC-IPC-SPAWN-WT-001 ipc_spawn host=wt 命令构造修复', () => {
  test('AC-IPC-SPAWN-WT-001-a: buildWtStartCommand 不含 "start """ wrapper', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test-spawn', model: undefined, cwd: 'D:/workspace/test' });
    assert.ok(!/^start\s+""/.test(cmd), `不应以 start "" 起头: ${cmd}`);
  });

  test('AC-IPC-SPAWN-WT-001-b: buildWtStartCommand 用 wt -- 分隔符（不嵌套 cmd /c）', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test-spawn', model: undefined, cwd: 'D:/workspace/test' });
    assert.match(cmd, /wt\.exe\s+--window\s+last\s+new-tab.*\s--\s/, `should include --window last and -- separator: ${cmd}`);
    assert.match(cmd, /--\s+powershell\.exe\s+-NoExit\s+-NoProfile\s+-EncodedCommand/);
  });

  test('AC-IPC-SPAWN-WT-001-c: buildWtStartCommand 含 IPC_NAME env injection', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test-spawn-name', model: 'claude-opus-4-7', cwd: 'D:/workspace/test' });
    const psCommand = decodePowerShellCommandFromHint(cmd);
    assert.match(psCommand, /\$env:IPC_NAME='test-spawn-name'/);
    assert.doesNotMatch(cmd, /set IPC_NAME=test-spawn-name\s+&&/);
  });

  test('AC-IPC-SPAWN-WT-001-d: buildWtStartCommand 含正确 claude.exe absolute path', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test-spawn', model: undefined, cwd: 'D:/workspace/test' });
    const psCommand = decodePowerShellCommandFromHint(cmd);
    // 默认 path C:/Users/jolen/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe
    assert.match(psCommand, /claude-code\\bin\\claude\.exe|claude-code\/bin\/claude\.exe/);
  });

  test('AC-IPC-SPAWN-WT-001-e: model 选项注入 --model arg', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test', model: 'claude-opus-4-7', cwd: 'D:/' });
    const psCommand = decodePowerShellCommandFromHint(cmd);
    assert.match(psCommand, /--model claude-opus-4-7/);
  });

  test('AC-IPC-SPAWN-WT-002-f: buildWtSpawnArgs 返回 args 数组形态正确', () => {
    const argv = buildWtSpawnArgs({ sessionName: 'test-f', model: undefined, cwd: 'D:/workspace/test' });
    assert.ok(Array.isArray(argv), `应返回数组: ${typeof argv}`);
    assert.ok(argv.includes('new-tab'));
    assert.ok(argv.includes('--title'));
    assert.ok(argv.includes('test-f'));
    assert.ok(argv.includes('--'));  // wiring v5·removed --starting-directory·cwd 嵌入 command 内，避开 wt parser 0x80070005 BUG

    const dashIdx = argv.indexOf('--');
    assert.equal(argv[dashIdx + 1], 'powershell.exe');
    assert.equal(argv[dashIdx + 2], '-NoExit');
    assert.equal(argv[dashIdx + 3], '-NoProfile');
    assert.equal(argv[dashIdx + 4], '-EncodedCommand');
    const psCommand = decodePowerShellCommand(argv[dashIdx + 5]);
    assert.match(psCommand, /Set-Location -LiteralPath 'D:\\workspace\\test'/);
    assert.match(psCommand, /\$env:IPC_NAME='test-f'/);
    assert.match(psCommand, /claude-stdin-auto-accept\.mjs' '.*claude\.exe'/);
  });

  test('AC-IPC-SPAWN-WT-002-g: buildWtSpawnArgs inner cmd 含 model arg', () => {
    const argv = buildWtSpawnArgs({ sessionName: 'test-g', model: 'claude-opus-4-7', cwd: 'D:/' });
    const dashIdx = argv.indexOf('--');
    const psCommand = decodePowerShellCommand(argv[dashIdx + 5]);
    assert.match(psCommand, /--model claude-opus-4-7/);
  });

  test('AC-IPC-SPAWN-WT-002-h: buildWtSpawnArgs includes --window last', () => {
    const argv = buildWtSpawnArgs({ sessionName: 'test-h', model: undefined, cwd: 'D:/workspace/test' });
    const windowIdx = argv.indexOf('--window');
    assert.notEqual(windowIdx, -1, `should include --window: ${JSON.stringify(argv)}`);
    assert.equal(argv[windowIdx + 1], 'last', `--window value should be last: ${argv[windowIdx + 1]}`);
    const newTabIdx = argv.indexOf('new-tab');
    assert.ok(windowIdx < newTabIdx, `--window must appear before new-tab: windowIdx=${windowIdx} newTabIdx=${newTabIdx}`);
  });

  test('AC-IPC-SPAWN-WT-003-a: buildWtLaunchCommand uses PowerShell env assignment without cmd set', () => {
    const cmd = buildWtLaunchCommand({ sessionName: 'test-launch', model: undefined });
    assert.match(cmd, /^\$env:IPC_NAME='test-launch'; & '.*node(\.exe)?' '.*claude-stdin-auto-accept\.mjs' '.*claude\.exe'/);
    assert.doesNotMatch(cmd, /set IPC_NAME=test-launch\s+&&/);
  });

  test('AC-IPC-SPAWN-WT-003-b: buildWtSpawnArgs uses PowerShell stdin pipe', () => {
    const argv = buildWtSpawnArgs({ sessionName: 'test-trim', model: undefined, cwd: 'D:/workspace/test' });
    const innerCmd = decodePowerShellCommand(argv[argv.indexOf('--') + 5]);
    assert.match(innerCmd, /\$env:IPC_NAME='test-trim'; & '.*node(\.exe)?' '.*claude-stdin-auto-accept\.mjs' '.*claude\.exe'/);
    assert.doesNotMatch(innerCmd, /set IPC_NAME=test-trim\s+&&/);
  });

});

