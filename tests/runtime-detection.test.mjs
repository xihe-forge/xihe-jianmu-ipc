import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntime } from '../mcp-server.mjs';

test('resolveRuntime detects claude through wrapper ancestor command line', () => {
  const runtime = resolveRuntime({
    env: {},
    ancestorCommandLines: [
      'node D:\\workspace\\ai\\research\\xiheAi\\xihe-jianmu-ipc\\mcp-wrapper.mjs',
      'C:\\Users\\jolen\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe --dangerously-load-development-channels server:ipc',
    ],
    clientInfo: { name: 'unknown-client' },
  });

  assert.equal(runtime, 'claude');
});

test('resolveRuntime keeps env override ahead of process ancestors', () => {
  const runtime = resolveRuntime({
    env: { IPC_RUNTIME: 'codex' },
    ancestorCommandLines: ['claude.exe server:ipc'],
    clientInfo: { name: 'claude-code' },
  });

  assert.equal(runtime, 'codex');
});

test('resolveRuntime falls back to MCP clientInfo after unknown ancestors', () => {
  const runtime = resolveRuntime({
    env: {},
    ancestorCommandLines: ['node mcp-wrapper.mjs', 'powershell.exe'],
    clientInfo: { name: 'codex-cli' },
  });

  assert.equal(runtime, 'codex');
});
