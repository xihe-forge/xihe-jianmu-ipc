import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpTools } from '../../lib/mcp-tools.mjs';
import { spawnSession } from '../../mcp-server.mjs';

const originalPlatform = process.platform;

async function withPlatform(platform, fn) {
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
}

function expectedFullPrompt(sessionName, task) {
  const ipcName = process.env.IPC_NAME || process.env.IPC_DEFAULT_NAME || `session-${process.pid}`;
  const ipcInstruction = `Your IPC session name is "${sessionName}". You are connected to the IPC hub. When you complete your task, report back using ipc_send(to="${ipcName}", content="your result"). You can also receive messages from other sessions.`;
  return `${ipcInstruction}\n\nTask: ${task}`;
}

function createHarness() {
  const calls = {
    spawnSession: [],
  };

  const tools = createMcpTools({
    getSessionName: () => 'alpha',
    setSessionName: () => {},
    getHubHost: () => '127.0.0.1',
    setHubHost: () => {},
    getHubPort: () => 8765,
    setHubPort: () => {},
    getWs: () => ({ readyState: 1 }),
    disconnectWs: () => {},
    reconnect: () => {},
    getPendingOutgoingCount: () => 0,
    wsSend: () => true,
    httpGet: async () => [],
    httpPost: async () => ({ accepted: true }),
    httpPatch: async () => ({ ok: true }),
    spawnSession: async (params) => {
      calls.spawnSession.push(params);
      return { spawned: false, host: params.host ?? 'legacy' };
    },
    stderrLog: () => {},
  });

  return { tools, calls };
}

test('ipc_spawn host integration: æ˜¾å¼ host=external æ—¶ä¿ç•™ host å‚æ•°', async () => {
  const { tools, calls } = createHarness();

  await tools.handleToolCall('ipc_spawn', {
    name: 'harness',
    task: 'resume from handover',
    host: 'external',
  });

  assert.equal(calls.spawnSession.length, 1);
  assert.equal(calls.spawnSession[0].host, 'external');
});

test('ipc_spawn host integration: host=wt æ—¶é€ä¼ ç»™ spawnSession', async () => {
  const { tools, calls } = createHarness();

  await tools.handleToolCall('ipc_spawn', {
    name: 'harness',
    task: 'resume from handover',
    host: 'wt',
  });

  assert.equal(calls.spawnSession.length, 1);
  assert.equal(calls.spawnSession[0].host, 'wt');
});

test('ipc_spawn host integration: host=vscode-uri forwards spawnSession', async () => {
  const { tools, calls } = createHarness();

  await tools.handleToolCall('ipc_spawn', {
    name: 'harness',
    task: 'resume from handover',
    host: 'vscode-uri',
  });

  assert.equal(calls.spawnSession.length, 1);
  assert.equal(calls.spawnSession[0].host, 'vscode-uri');
});

test('ipc_spawn host=vscode-uri dryRun returns encoded URI and length', async () => {
  await withPlatform('win32', async () => {
    const task = 'resume from handover with ÖÐÎÄ and spaces';
    const result = await spawnSession({
      name: 'vscodeuri',
      task,
      host: 'vscode-uri',
      dryRun: true,
    });

    assert.equal(result.spawned, false);
    assert.equal(result.host, 'vscode-uri');
    assert.equal(result.dryRun, true);
    assert.match(result.command_hint, /^cmd\.exe \/c start "" "vscode:\/\/anthropic\.claude-code\/open\?prompt=/);
    assert.equal(typeof result.uri_byte_length, 'number');
    assert.ok(result.uri_byte_length > 0);

    const url = new URL(result.uri);
    assert.equal(url.protocol, 'vscode:');
    assert.equal(url.hostname, 'anthropic.claude-code');
    assert.equal(url.pathname, '/open');
    assert.equal(url.searchParams.has('prompt'), true);
    assert.equal(url.searchParams.get('prompt'), expectedFullPrompt('vscodeuri', task));
  });
});

test('ipc_spawn host=vscode-uri dryRun rejects brief over 5KB', async () => {
  await withPlatform('win32', async () => {
    const result = await spawnSession({
      name: 'vscodeuribig',
      task: 'x'.repeat(5 * 1024 + 1),
      host: 'vscode-uri',
      dryRun: true,
    });

    assert.equal(result.spawned, false);
    assert.equal(result.host, 'vscode-uri');
    assert.match(result.error, /exceeds 5KB limit/);
  });
});

test('ipc_spawn host=vscode-uri dryRun non-win32 falls back to external', async () => {
  await withPlatform('linux', async () => {
    const result = await spawnSession({
      name: 'vscodeurilinux',
      task: 'resume from handover',
      host: 'vscode-uri',
      dryRun: true,
    });

    assert.equal(result.spawned, false);
    assert.equal(result.host, 'external');
    assert.equal(result.fallbackIpcSent, false);
    assert.equal(result.dryRun, true);
    assert.match(result.warning, /Windows-only/);
  });
});

test('ipc_spawn host=vscode-uri dryRun URL prompt decodes to fullPrompt', async () => {
  await withPlatform('win32', async () => {
    const task = 'line1\nline2?x=1&y=ÖÐÎÄ';
    const result = await spawnSession({
      name: 'vscodeuriencode',
      task,
      host: 'vscode-uri',
      dryRun: true,
    });

    const decodedPrompt = new URL(result.uri).searchParams.get('prompt');
    assert.equal(decodedPrompt, expectedFullPrompt('vscodeuriencode', task));
  });
});
