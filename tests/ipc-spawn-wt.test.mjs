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

describe('AC-IPC-SPAWN-WT-001 ipc_spawn host=wt 命令构造修复', () => {
  test('AC-IPC-SPAWN-WT-001-a: buildWtStartCommand 不含 "start """ wrapper', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test-spawn', model: undefined, cwd: 'D:/workspace/test' });
    assert.ok(!/^start\s+""/.test(cmd), `不应以 start "" 起头: ${cmd}`);
  });

  test('AC-IPC-SPAWN-WT-001-b: buildWtStartCommand 用 wt -- 分隔符（不嵌套 cmd /c）', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test-spawn', model: undefined, cwd: 'D:/workspace/test' });
    assert.match(cmd, /wt\.exe\s+new-tab.*\s--\s/, `应含 -- 分隔符: ${cmd}`);
  });

  test('AC-IPC-SPAWN-WT-001-c: buildWtStartCommand 含 IPC_NAME env injection', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test-spawn-name', model: 'claude-opus-4-7', cwd: 'D:/workspace/test' });
    assert.match(cmd, /set IPC_NAME=test-spawn-name/);
  });

  test('AC-IPC-SPAWN-WT-001-d: buildWtStartCommand 含正确 claude.exe absolute path', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test-spawn', model: undefined, cwd: 'D:/workspace/test' });
    // 默认 path C:/Users/jolen/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe
    assert.match(cmd, /claude-code\\bin\\claude\.exe|claude-code\/bin\/claude\.exe/);
  });

  test('AC-IPC-SPAWN-WT-001-e: model 选项注入 --model arg', () => {
    const cmd = buildWtStartCommand({ sessionName: 'test', model: 'claude-opus-4-7', cwd: 'D:/' });
    assert.match(cmd, /--model claude-opus-4-7/);
  });

  test('AC-IPC-SPAWN-WT-002-f: buildWtSpawnArgs 返回 args 数组形态正确', () => {
    const argv = buildWtSpawnArgs({ sessionName: 'test-f', model: undefined, cwd: 'D:/workspace/test' });
    assert.ok(Array.isArray(argv), `应返回数组: ${typeof argv}`);
    assert.equal(argv[0], 'new-tab');
    assert.ok(argv.includes('--title'));
    assert.ok(argv.includes('test-f'));
    assert.ok(argv.includes('--starting-directory'));
    assert.ok(argv.includes('D:\\workspace\\test'));  // wiring v4·cwd normalize forward → backslash for wt --starting-directory
    assert.ok(argv.includes('--'));

    const dashIdx = argv.indexOf('--');
    assert.equal(argv[dashIdx + 1], 'cmd');
    assert.equal(argv[dashIdx + 2], '/k');
    assert.match(argv[dashIdx + 3], /set IPC_NAME=test-f/);
    assert.match(argv[dashIdx + 3], /claude\.exe/);
  });

  test('AC-IPC-SPAWN-WT-002-g: buildWtSpawnArgs inner cmd 含 model arg', () => {
    const argv = buildWtSpawnArgs({ sessionName: 'test-g', model: 'claude-opus-4-7', cwd: 'D:/' });
    const dashIdx = argv.indexOf('--');
    assert.match(argv[dashIdx + 3], /--model claude-opus-4-7/);
  });
});
