import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpTools } from '../lib/mcp-tools.mjs';
import * as mcpServer from '../mcp-server.mjs';

const harnessCodexUsagePath = 'D:/workspace/ai/research/xiheAi/xihe-tianshu-harness/domains/software/knowledge/codex-usage.md';

function getJson(result) {
  return JSON.parse(result.content[0].text);
}

function createHarness(impl = {}) {
  const calls = { spawnSession: [], httpGet: [] };
  const tools = createMcpTools({
    getSessionName: () => 'portfolio',
    setSessionName: () => {},
    getHubHost: () => '127.0.0.1',
    setHubHost: () => {},
    getHubPort: () => 8765,
    setHubPort: () => {},
    getWs: () => null,
    disconnectWs: () => {},
    reconnect: () => {},
    getPendingOutgoingCount: () => 0,
    wsSend: () => true,
    httpGet: async (url) => {
      calls.httpGet.push(url);
      return impl.httpGet ? impl.httpGet(url) : [];
    },
    httpPost: async () => ({ accepted: true }),
    httpPatch: async () => ({ ok: true }),
    spawnSession: async (params) => {
      calls.spawnSession.push(params);
      return impl.spawnSession ? impl.spawnSession(params) : { name: params.name, status: 'spawned' };
    },
    estimateContextPct: async () => 0,
    stderrLog: () => {},
  });
  return { tools, calls };
}

describe('ADR-012 ipc_spawn runtime=codex support', () => {
  test('AC-1 codex interactive wt command launches persistent codex session', async () => {
    const { tools, calls } = createHarness({
      spawnSession: async (params) => mcpServer.spawnSession({ ...params, dryRun: true }),
    });

    const result = await tools.handleToolCall('ipc_spawn', {
      name: 'codex-1',
      task: 'call ipc_whoami',
      runtime: 'codex',
      interactive: true,
      host: 'wt',
      cwd: 'D:/workspace/test',
    });
    const payload = getJson(result);

    assert.equal(calls.spawnSession[0].runtime, 'codex');
    assert.equal(payload.host, 'wt');
    assert.equal(payload.runtime, 'codex');
    assert.match(payload.command_hint, /^wt\.exe /);
    assert.match(payload.command_hint, /cmd \/k /);
    assert.match(payload.command_hint, /codex --dangerously-bypass-approvals-and-sandbox/);
    assert.match(payload.command_hint, /-c 'mcp_servers\.jianmu-ipc\.env\.IPC_NAME=\\"codex-1\\"'/);
  });

  test('AC-2 codex background uses codex exec one-shot command', async () => {
    const payload = await mcpServer.spawnSession({
      name: 'codex-bg',
      task: 'send result to harness',
      runtime: 'codex',
      interactive: false,
      cwd: 'D:/workspace/test',
      dryRun: true,
    });

    assert.equal(payload.runtime, 'codex');
    assert.equal(payload.mode, 'background');
    assert.match(payload.command_hint, /^codex exec /);
    assert.match(payload.command_hint, /--skip-git-repo-check/);
    assert.match(payload.command_hint, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(payload.command_hint, /send result to harness/);
  });

  test('AC-3 default runtime remains claude behavior', async () => {
    const { tools, calls } = createHarness();

    await tools.handleToolCall('ipc_spawn', {
      name: 'claude-default',
      task: 'run old path',
      interactive: true,
      model: 'claude-sonnet-4-6',
    });

    assert.deepEqual(calls.spawnSession, [{
      name: 'claude-default',
      task: 'run old path',
      interactive: true,
      model: 'claude-sonnet-4-6',
      cwd: undefined,
    }]);
  });

  test('AC-4 multiple codex commands keep distinct IPC_NAME overrides', () => {
    const first = mcpServer.buildCodexExecCommand({ sessionName: 'codex-1', prompt: 'task one' });
    const second = mcpServer.buildCodexExecCommand({ sessionName: 'codex-2', prompt: 'task two' });

    assert.match(first, /IPC_NAME="codex-1"/);
    assert.match(second, /IPC_NAME="codex-2"/);
    assert.notEqual(first, second);
  });

  test('AC-5 codex wt spawn cwd uses inner cmd cd /d handling', () => {
    const argv = mcpServer.buildCodexWtCommand({ sessionName: 'codex-cwd', cwd: 'D:/workspace/test' });
    const dashIdx = argv.indexOf('--');

    assert.equal(argv[dashIdx + 1], 'cmd');
    assert.equal(argv[dashIdx + 2], '/k');
    assert.match(argv[dashIdx + 3], /cd \/d "D:\\workspace\\test" && codex /);
  });

  test('AC-6 codex IPC_NAME comes from -c override, not parent env injection', () => {
    const launch = mcpServer.buildCodexLaunchArgs({ sessionName: 'codex-ipc' });

    assert.match(launch, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(launch, /-c 'mcp_servers\.jianmu-ipc\.env\.IPC_NAME="codex-ipc"'/);
    assert.doesNotMatch(launch, /set IPC_NAME=/);
    assert.doesNotMatch(launch, /\$env:IPC_NAME/);
  });

  test('AC-7 codex exec dryRun documents child exit cleanup path', async () => {
    const payload = await mcpServer.spawnSession({
      name: 'codex-cleanup',
      task: 'exit after reporting',
      runtime: 'codex',
      interactive: false,
      dryRun: true,
    });

    assert.equal(payload.mode, 'background');
    assert.equal(payload.exit_cleanup, 'hub session closes when codex exec exits');
  });

  test('AC-8 CLAUDE.md documents ipc_spawn runtime and codex modes', () => {
    const content = readFileSync('CLAUDE.md', 'utf8');

    assert.match(content, /runtime\?/);
    assert.match(content, /runtime=claude\|codex/);
    assert.match(content, /default(?:s)?\s+`?claude`?/i);
    assert.match(content, /runtime=codex[\s\S]*interactive=true[\s\S]*wt/i);
    assert.match(content, /runtime=codex[\s\S]*interactive=false[\s\S]*codex exec/i);
  });

  test('AC-9 codex rollout doc cites feedback memories for migration', () => {
    assert.equal(existsSync(harnessCodexUsagePath), true);
    const content = readFileSync(harnessCodexUsagePath, 'utf8');

    assert.match(content, /ipc_spawn\(runtime=codex\) 替代 bash run_in_background/);
    assert.match(content, /feedback_codex_dispatch/);
    assert.match(content, /feedback_codex_exit_code_truth/);
    assert.match(content, /feedback_codex_log_dir_mkdir/);
  });
});
