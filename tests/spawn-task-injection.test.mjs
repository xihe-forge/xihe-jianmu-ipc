import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWtSpawnArgs,
  spawnSession,
  writeSpawnTaskPromptFile,
} from '../mcp-server.mjs';

const originalPlatform = process.platform;

function withPlatform(platform, fn) {
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
}

function decodePowerShellCommand(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

function expectedFullPrompt(sessionName, task) {
  const ipcName = process.env.IPC_NAME || process.env.IPC_DEFAULT_NAME || `session-${process.pid}`;
  const ipcInstruction = `Your IPC session name is "${sessionName}". You are connected to the IPC hub. When you complete your task, report back using ipc_send(to="${ipcName}", content="your result"). You can also receive messages from other sessions.`;
  return `${ipcInstruction}\n\nTask: ${task}`;
}

test('spawn task injection: prompt file persists the exact full prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-task-injection-'));
  try {
    const prompt = 'IPC task injection sentinel\nline 2';
    const result = writeSpawnTaskPromptFile({
      sessionName: 'kt-file',
      prompt,
      dir,
      now: () => 1777500000000,
    });

    assert.match(result.path, /kt-file/);
    assert.equal(result.byteLength, Buffer.byteLength(prompt, 'utf8'));
    assert.equal(readFileSync(result.path, 'utf8'), prompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn task injection: wt command reads prompt file and passes it as Claude positional prompt', () => {
  const argv = buildWtSpawnArgs({
    sessionName: 'kt-cmd',
    model: 'opus',
    cwd: 'D:/workspace/test',
    taskPromptFile: 'C:/Temp/jianmu-ipc-spawn-kt-cmd.prompt.txt',
  });
  const decoded = decodePowerShellCommand(argv[argv.indexOf('--') + 5]);

  assert.match(
    decoded,
    /\$spawnTaskPrompt = Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\/Temp\/jianmu-ipc-spawn-kt-cmd\.prompt\.txt'/,
  );
  assert.match(decoded, /server:ipc --model opus \$spawnTaskPrompt$/);
  assert.doesNotMatch(decoded, /IPC task injection sentinel/);
});

test('spawn task injection: host=wt dryRun exposes prompt-file injection metadata', async () => {
  await withPlatform('win32', async () => {
    const task = 'KT dryRun sentinel task\n1. date\n2. ipc_whoami\n3. ipc_send caller report';
    const result = await spawnSession({
      name: 'kt-dryrun',
      task,
      host: 'wt',
      dryRun: true,
      cwd: 'D:/workspace/test',
    });
    const fullPrompt = expectedFullPrompt('kt-dryrun', task);

    assert.equal(result.host, 'wt');
    assert.equal(result.dryRun, true);
    assert.equal(result.task_injection.mechanism, 'claude-positional-prompt-file');
    assert.equal(result.task_injection.prompt_byte_length, Buffer.byteLength(fullPrompt, 'utf8'));
    assert.match(result.task_injection.prompt_file_hint, /kt-dryrun/);

    const match = result.command_hint.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
    assert.ok(match, `missing encoded PowerShell command: ${result.command_hint}`);
    const decoded = decodePowerShellCommand(match[1]);
    assert.match(decoded, /Get-Content -Raw -Encoding UTF8 -LiteralPath/);
    assert.match(decoded, /server:ipc \$spawnTaskPrompt$/);
  });
});
