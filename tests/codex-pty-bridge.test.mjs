import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodexPtyUserInputTracker,
  CODEX_PTY_SUBMIT_SEQUENCE,
  CODEX_PTY_SUBMIT_SEQUENCE_NAME,
  createCodexPtyBridgeReady,
  enqueueCodexPtyPrompt,
  formatCodexPtyPrompt,
  getCodexPtyBridgePaths,
  processCodexPtyBridgeQueue,
  readCodexPtyBridgeReady,
} from '../lib/codex-pty-bridge.mjs';

test('formatCodexPtyPrompt carries visible ipc line and reply instruction', () => {
  const inputTs = '2026-05-05T18:46:47.000Z';
  const prompt = formatCodexPtyPrompt({
    from: 'jianmu-pm',
    ts: inputTs,
    content: 'dogfood\nack',
  });

  const d = new Date(inputTs);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  const local = new Date(d.getTime() + offsetMin * 60000)
    .toISOString()
    .replace(/T/, ' ')
    .replace(/\.\d+Z$/, '');
  const expectedTs = `${local}${sign}${hh}:${mm}`;

  assert.ok(
    prompt.startsWith(`← ipc: [${expectedTs} from: jianmu-pm] dogfood\\nack`),
    `expected local-timezone ipc line, got: ${prompt}`,
  );
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

test('enqueueCodexPtyPrompt can ack after durable queue accept without waiting for pty write', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-pty-bridge-'));
  const sessionName = 'codex-bridge-queued';
  try {
    await createCodexPtyBridgeReady(sessionName, { rootDir, wrapperPid: process.pid });
    const paths = getCodexPtyBridgePaths(sessionName, { rootDir });

    const accepted = await enqueueCodexPtyPrompt(
      sessionName,
      { id: 'msg-queued', from: 'jianmu-pm', content: 'queue me' },
      { rootDir, waitForAckMs: 0 },
    );

    assert.equal(accepted.ok, true);
    assert.equal(accepted.queued, true);
    assert.equal(accepted.msgId, 'msg-queued');
    assert.equal(accepted.wrapperPid, process.pid);
    assert.equal((await readdir(paths.queueDir)).length, 1);
    assert.equal((await readdir(paths.ackDir)).length, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('user input tracker keeps PTY bridge queued while a Codex draft is present', async () => {
  let nowMs = 1000;
  const tracker = createCodexPtyUserInputTracker({
    now: () => nowMs,
    idleGraceMs: 1000,
  });

  assert.equal(tracker.getState().defer, false);
  tracker.recordUserInput('boss draft');
  assert.equal(tracker.getState().defer, true);
  assert.equal(tracker.getState().reason, 'user-input-buffer');
  assert.equal(tracker.getState().draftChars, 10);

  nowMs += 5000;
  assert.equal(tracker.getState().defer, true);
  assert.equal(tracker.getState().reason, 'user-input-buffer');

  tracker.recordUserInput('\b');
  assert.equal(tracker.getState().draftChars, 9);

  tracker.recordUserInput('\r');
  assert.equal(tracker.getState().draftChars, 0);
  assert.equal(tracker.getState().reason, 'user-turn-active');

  nowMs += 1000;
  assert.equal(tracker.getState().defer, true);
  assert.equal(tracker.getState().reason, 'user-turn-active');

  tracker.markCodexPromptReady();
  assert.equal(tracker.getState().defer, false);
});

test('user input tracker treats keypad Enter escape sequence as submit', () => {
  let nowMs = 1000;
  const tracker = createCodexPtyUserInputTracker({
    now: () => nowMs,
    idleGraceMs: 1000,
  });

  tracker.recordUserInput('draft');
  assert.equal(tracker.getState().reason, 'user-input-buffer');

  tracker.recordUserInput('\x1bOM');
  nowMs += 1000;
  assert.equal(tracker.getState().reason, 'user-turn-active');

  tracker.markCodexPromptReady();
  assert.equal(tracker.getState().defer, false);
});

test('user input tracker treats bridge right-arrow CR sequence as submit', () => {
  let nowMs = 1000;
  const tracker = createCodexPtyUserInputTracker({
    now: () => nowMs,
    idleGraceMs: 1000,
  });

  tracker.recordUserInput('draft');
  assert.equal(tracker.getState().reason, 'user-input-buffer');

  tracker.recordUserInput(CODEX_PTY_SUBMIT_SEQUENCE);
  nowMs += 1000;
  assert.equal(tracker.getState().reason, 'user-turn-active');
  assert.equal(tracker.getState().draftChars, 0);

  tracker.markCodexPromptReady();
  assert.equal(tracker.getState().defer, false);
});

test('user input tracker releases zero-draft escape holds after idle grace', () => {
  let nowMs = 1000;
  const tracker = createCodexPtyUserInputTracker({
    now: () => nowMs,
    idleGraceMs: 1000,
  });

  tracker.recordUserInput('\x1b[A');
  assert.equal(tracker.getState().defer, true);
  assert.equal(tracker.getState().reason, 'recent-user-input');
  assert.equal(tracker.getState().draftChars, 0);

  nowMs += 1001;
  assert.equal(tracker.getState().defer, false);
  assert.equal(tracker.shouldDeferPtyBridgeWrite(), null);
});

test('user input tracker times out submit hold if prompt scrape never fires', () => {
  let nowMs = 1000;
  const tracker = createCodexPtyUserInputTracker({
    now: () => nowMs,
    idleGraceMs: 1000,
    submitAwaitTimeoutMs: 5000,
  });

  tracker.recordUserInput('draft\r');
  nowMs += 4999;
  assert.equal(tracker.getState().reason, 'user-turn-active');

  nowMs += 1;
  assert.equal(tracker.getState().defer, false);
  assert.equal(tracker.getState().awaitingPromptAfterSubmit, false);
});

test('user input tracker treats kitty keyboard Enter sequence as submit', () => {
  let nowMs = 1000;
  const tracker = createCodexPtyUserInputTracker({
    now: () => nowMs,
    idleGraceMs: 1000,
  });

  tracker.recordUserInput('\x1b[65;30;97;1;0;1_');
  assert.equal(tracker.getState().reason, 'user-input-buffer');
  assert.equal(tracker.getState().draftChars, 1);

  tracker.recordUserInput('\x1b[13;28;13;1;0;1_');
  nowMs += 1000;
  assert.equal(tracker.getState().reason, 'user-turn-active');

  tracker.markCodexPromptReady();
  assert.equal(tracker.getState().defer, false);
});

test('user input tracker counts split kitty keyboard printable sequence once', () => {
  let nowMs = 1000;
  const tracker = createCodexPtyUserInputTracker({
    now: () => nowMs,
    idleGraceMs: 1000,
  });

  tracker.recordUserInput('\x1b[65;30');
  assert.equal(tracker.getState().draftChars, 0);
  assert.equal(tracker.getState().pendingEscapeBytes > 0, true);

  tracker.recordUserInput(';97;1;0;1_');
  assert.equal(tracker.getState().reason, 'user-input-buffer');
  assert.equal(tracker.getState().draftChars, 1);
});

test('queue processor leaves IPC queued while user draft exists and flushes after submit grace', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-pty-bridge-'));
  const sessionName = 'codex-bridge-user-typing';
  const writes = [];
  let nowMs = 2000;
  const tracker = createCodexPtyUserInputTracker({
    now: () => nowMs,
    idleGraceMs: 1000,
  });

  try {
    await createCodexPtyBridgeReady(sessionName, { rootDir, wrapperPid: process.pid });
    const paths = getCodexPtyBridgePaths(sessionName, { rootDir });
    await enqueueCodexPtyPrompt(
      sessionName,
      { id: 'msg-typing', from: 'jianmu-pm', content: 'wait until user submits' },
      { rootDir, waitForAckMs: 0 },
    );

    tracker.recordUserInput('boss draft');
    let deferred = null;
    const processedWhileTyping = await processCodexPtyBridgeQueue(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      writePrompt: async (prompt) => writes.push(prompt),
      submitDelayMs: 0,
      shouldDeferWrite: () => tracker.shouldDeferPtyBridgeWrite(),
      onDefer: (state) => {
        deferred = state;
      },
    });

    assert.deepEqual(processedWhileTyping, []);
    assert.equal(writes.length, 0);
    assert.equal(deferred.reason, 'user-input-buffer');
    assert.equal((await readdir(paths.queueDir)).length, 1);
    let ackFiles = await readdir(paths.ackDir);
    assert.equal(ackFiles.length, 1);
    let deferredAck = JSON.parse(await readFile(join(paths.ackDir, ackFiles[0]), 'utf8'));
    assert.equal(deferredAck.deferred, true);
    assert.equal(deferredAck.dispatched, false);
    assert.equal(deferredAck.reason, 'user-input-buffer');

    nowMs += 100;
    tracker.recordUserInput('\r');
    nowMs += 1200;
    const processedDuringUserTurn = await processCodexPtyBridgeQueue(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      writePrompt: async (prompt) => writes.push(prompt),
      submitDelayMs: 0,
      shouldDeferWrite: () => tracker.shouldDeferPtyBridgeWrite(),
    });
    assert.deepEqual(processedDuringUserTurn, []);
    assert.equal(writes.length, 0);
    ackFiles = await readdir(paths.ackDir);
    deferredAck = JSON.parse(await readFile(join(paths.ackDir, ackFiles[0]), 'utf8'));
    assert.equal(deferredAck.reason, 'user-turn-active');

    tracker.markCodexPromptReady();
    const processedAfterGrace = await processCodexPtyBridgeQueue(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      writePrompt: async (prompt) => writes.push(prompt),
      submitDelayMs: 0,
      shouldDeferWrite: () => tracker.shouldDeferPtyBridgeWrite(),
    });

    assert.equal(processedAfterGrace.length, 1);
    assert.match(writes[0], /^← ipc: /);
    assert.equal(writes[1], CODEX_PTY_SUBMIT_SEQUENCE);
    assert.equal((await readdir(paths.queueDir)).length, 0);
    ackFiles = await readdir(paths.ackDir);
    assert.equal(ackFiles.length, 1);
    const dispatchAck = JSON.parse(await readFile(join(paths.ackDir, ackFiles[0]), 'utf8'));
    assert.equal(dispatchAck.deferred, false);
    assert.equal(dispatchAck.dispatched, true);
    assert.match(dispatchAck.dispatchedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('queue processor keeps 30s idle pending IPC and drops only after TTL', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-pty-bridge-'));
  const sessionName = 'codex-bridge-ttl';
  const writes = [];
  let nowMs = 10_000;

  try {
    await createCodexPtyBridgeReady(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      now: () => nowMs,
    });
    const paths = getCodexPtyBridgePaths(sessionName, { rootDir });
    await enqueueCodexPtyPrompt(
      sessionName,
      { id: 'msg-ttl', from: 'jianmu-pm', content: 'do not drop at 30s' },
      { rootDir, waitForAckMs: 0, readyMaxAgeMs: -1, now: () => nowMs },
    );

    nowMs += 30_000;
    let processed = await processCodexPtyBridgeQueue(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      now: () => nowMs,
      writePrompt: async (prompt) => writes.push(prompt),
      shouldDeferWrite: () => ({ reason: 'recent-user-input', draftChars: 0 }),
    });
    assert.deepEqual(processed, []);
    assert.equal((await readdir(paths.queueDir)).length, 1);

    nowMs += 59_000;
    processed = await processCodexPtyBridgeQueue(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      now: () => nowMs,
      writePrompt: async (prompt) => writes.push(prompt),
      shouldDeferWrite: () => ({ reason: 'recent-user-input', draftChars: 0 }),
    });
    assert.deepEqual(processed, []);
    assert.equal((await readdir(paths.queueDir)).length, 1);

    nowMs += 2_000;
    const dropped = [];
    processed = await processCodexPtyBridgeQueue(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      now: () => nowMs,
      writePrompt: async (prompt) => writes.push(prompt),
      shouldDeferWrite: () => ({ reason: 'recent-user-input', draftChars: 0 }),
      onDrop: (entry) => dropped.push(entry),
    });
    assert.deepEqual(processed, []);
    assert.equal((await readdir(paths.queueDir)).length, 0);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'queue-ttl-expired');
    const ackFiles = await readdir(paths.ackDir);
    const ttlAck = JSON.parse(await readFile(join(paths.ackDir, ackFiles[0]), 'utf8'));
    assert.equal(ttlAck.dropped, true);
    assert.equal(ttlAck.reason, 'queue-ttl-expired');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('queue processor enforces queue cap and audits dropped oldest messages', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-pty-bridge-'));
  const sessionName = 'codex-bridge-cap';
  const writes = [];
  let nowMs = 20_000;

  try {
    await createCodexPtyBridgeReady(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      now: () => nowMs,
    });
    const paths = getCodexPtyBridgePaths(sessionName, { rootDir });
    for (let index = 0; index < 12; index += 1) {
      nowMs += 1;
      await enqueueCodexPtyPrompt(
        sessionName,
        { id: `msg-cap-${index}`, from: 'jianmu-pm', content: `cap ${index}` },
        { rootDir, waitForAckMs: 0, readyMaxAgeMs: -1, now: () => nowMs },
      );
    }

    const dropped = [];
    const processed = await processCodexPtyBridgeQueue(sessionName, {
      rootDir,
      wrapperPid: process.pid,
      now: () => nowMs,
      queueMaxEntries: 10,
      queueTtlMs: 0,
      writePrompt: async (prompt) => writes.push(prompt),
      onDrop: (entry) => dropped.push(entry),
    });

    assert.equal(processed.length, 10);
    assert.equal(dropped.length, 2);
    assert.deepEqual(dropped.map((entry) => entry.msgId), ['msg-cap-0', 'msg-cap-1']);
    assert.equal((await readdir(paths.queueDir)).length, 0);
    assert.equal((await readdir(paths.ackDir)).length, 12);
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
    assert.equal(ack.deferred, false);
    assert.equal(ack.dispatched, true);
    assert.match(ack.dispatchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(writes.length, 2);
    assert.match(writes[0], /^← ipc: /);
    assert.equal(writes[1], CODEX_PTY_SUBMIT_SEQUENCE);
    assert.equal(ack.writeCount, 2);
    assert.equal(ack.submitDelayMs, 0);
    assert.equal(ack.submitSequence, CODEX_PTY_SUBMIT_SEQUENCE_NAME);
    assert.equal(ack.submitBytesHex, '1b5b430d');

    const ackFiles = await readdir(paths.ackDir);
    assert.equal(ackFiles.length, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
