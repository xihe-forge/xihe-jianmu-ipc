import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodexPtyBridgeReady,
  enqueueCodexPtyPrompt,
  formatCodexPtyPrompt,
  getCodexPtyBridgePaths,
  processCodexPtyBridgeQueue,
  readCodexPtyBridgeReady,
} from '../lib/codex-pty-bridge.mjs';

test('formatCodexPtyPrompt carries visible ipc line and reply instruction', () => {
  const prompt = formatCodexPtyPrompt({
    from: 'jianmu-pm',
    ts: '2026-05-05T18:46:47.000Z',
    content: 'dogfood\nack',
  });

  assert.match(prompt, /^← ipc: \[2026-05-05 18:46:47\+00:00 from: jianmu-pm\] dogfood\\nack/);
  assert.doesNotMatch(prompt, /IPC-INBOUND/);
  assert.match(prompt, /完整原样回显/);
  assert.match(prompt, /ipc_send\(to="jianmu-pm"/);
});

test('enqueueCodexPtyPrompt requires a fresh live wrapper ready marker', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-pty-bridge-'));
  try {
    await assert.rejects(
      () =>
        enqueueCodexPtyPrompt('missing-session', { id: 'msg-1', from: 'sender', content: 'hi' }, {
          rootDir,
          waitForAckMs: 10,
        }),
      /codex pty bridge unavailable: ready-missing/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('queue processor writes prompt to pty and produces ack consumed by enqueue', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-pty-bridge-'));
  const sessionName = 'codex-bridge-unit';
  const writes = [];
  try {
    await createCodexPtyBridgeReady(sessionName, { rootDir, wrapperPid: process.pid });
    const paths = getCodexPtyBridgePaths(sessionName, { rootDir });
    assert.equal(readCodexPtyBridgeReady(sessionName, { rootDir }).ready, true);

    const enqueued = enqueueCodexPtyPrompt(
      sessionName,
      { id: 'msg-bridge', from: 'jianmu-pm', content: 'ack me' },
      { rootDir, waitForAckMs: 1000 },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const processed = await processCodexPtyBridgeQueue(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      writePrompt: async (prompt) => writes.push(prompt),
      submitDelayMs: 0,
    });
    const ack = await enqueued;

    assert.equal(processed.length, 1);
    assert.equal(ack.ok, true);
    assert.equal(ack.msgId, 'msg-bridge');
    assert.equal(writes.length, 2);
    assert.match(writes[0], /^← ipc: /);
    assert.equal(writes[1], '\r');
    assert.equal(ack.writeCount, 2);
    assert.equal(ack.submitDelayMs, 0);

    const ackFiles = await readdir(paths.ackDir);
    assert.equal(ackFiles.length, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
