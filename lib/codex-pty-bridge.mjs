import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_CODEX_PTY_BRIDGE_DIR = join(PROJECT_DIR, 'data', 'codex-pty-bridge');
export const DEFAULT_CODEX_PTY_QUEUE_MAX_ENTRIES = 10;
export const DEFAULT_CODEX_PTY_QUEUE_TTL_MS = 60_000;
export const DEFAULT_CODEX_PTY_SUBMIT_AWAIT_TIMEOUT_MS = 5_000;
export const CODEX_PTY_SUBMIT_SEQUENCE = '\x1b[C\r';
export const CODEX_PTY_SUBMIT_SEQUENCE_NAME = 'right-arrow-cr';

export function safeCodexPtyBridgeName(name) {
  return String(name || 'unknown').replace(/[^\w.-]/g, '_');
}

export function getCodexPtyBridgeRoot(env = process.env) {
  return env.IPC_CODEX_PTY_BRIDGE_DIR || DEFAULT_CODEX_PTY_BRIDGE_DIR;
}

export function getCodexPtyBridgePaths(sessionName, { rootDir = getCodexPtyBridgeRoot() } = {}) {
  const sessionDir = join(rootDir, safeCodexPtyBridgeName(sessionName));
  return {
    rootDir,
    sessionDir,
    readyPath: join(sessionDir, 'ready.json'),
    queueDir: join(sessionDir, 'queue'),
    ackDir: join(sessionDir, 'ack'),
  };
}

function formatIpcTimestamp(ts) {
  const d = new Date(ts ?? Date.now());
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  const local = new Date(d.getTime() + offsetMin * 60000)
    .toISOString()
    .replace(/T/, ' ')
    .replace(/\.\d+Z$/, '');
  return `${local}${sign}${hh}:${mm}`;
}

function normalizeContent(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return text.replace(/\r?\n/g, '\\n');
}

export function formatCodexPtyPrompt(msg) {
  const from = msg?.from ?? 'unknown';
  const content = normalizeContent(msg?.content);
  const ipcLine = `← ipc: [${formatIpcTimestamp(msg?.ts)} from: ${from}] ${content}`;
  return [
    ipcLine,
    `请立即处理这条 IPC：第一行先完整原样回显上面的 IPC 行；如果消息要求 ACK 或 reply，必须调用 ipc_send(to="${from}", content="...") 回复发送方；然后继续当前任务。`,
  ].join(' | ');
}

function skipEscapeSequence(text, start) {
  const next = text[start + 1];
  if (next === '[') {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return index;
  }
  if (next === 'O') {
    return Math.min(text.length, start + 3);
  }
  return Math.min(text.length, start + 2);
}

function codePointToDraftText(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0x20 || codePoint === 0x7f) return '';
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
}

function isIncompleteEscapeSequence(text, start) {
  if (text[start] !== '\x1b') return false;
  if (start + 1 >= text.length) return true;
  const next = text[start + 1];
  if (next === '[') {
    for (let index = start + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return false;
    }
    return true;
  }
  if (next === 'O') return start + 2 >= text.length;
  return false;
}

function parseKeyboardProtocolSequence(text, start) {
  if (text[start] !== '\x1b' || text[start + 1] !== '[') return null;
  const end = text.indexOf('_', start + 2);
  if (end < 0) return null;
  const body = text.slice(start + 2, end);
  if (!/^\d+(?:;\d+)*$/.test(body)) return null;
  const values = body.split(';').map((value) => Number.parseInt(value, 10));
  const keyCode = values[0] ?? null;
  const unicode = values[2] ?? values[0] ?? null;
  return {
    nextIndex: end + 1,
    values,
    keyCode,
    unicode,
    text: codePointToDraftText(unicode),
  };
}

export function createCodexPtyUserInputTracker({
  now = Date.now,
  idleGraceMs = 1200,
  submitAwaitTimeoutMs = DEFAULT_CODEX_PTY_SUBMIT_AWAIT_TIMEOUT_MS,
} = {}) {
  const draftKinds = [];
  let awaitingPromptAfterSubmit = false;
  let awaitingPromptStartedAt = 0;
  let lastUserInputAt = 0;
  let pendingEscapeText = '';

  function markUserInput() {
    lastUserInputAt = now();
  }

  function appendDraftText(text) {
    for (let index = 0; index < text.length;) {
      const codePoint = text.codePointAt(index);
      const char = String.fromCodePoint(codePoint);
      draftKinds.push(/\s/u.test(char) ? 'space' : 'text');
      index += codePoint > 0xffff ? 2 : 1;
    }
  }

  function markSubmitted() {
    draftKinds.length = 0;
    awaitingPromptAfterSubmit = true;
    awaitingPromptStartedAt = now();
  }

  function clearSubmittedHold() {
    awaitingPromptAfterSubmit = false;
    awaitingPromptStartedAt = 0;
  }

  function deletePreviousWord() {
    while (draftKinds.length > 0 && draftKinds.at(-1) === 'space') {
      draftKinds.pop();
    }
    while (draftKinds.length > 0 && draftKinds.at(-1) !== 'space') {
      draftKinds.pop();
    }
  }

  function recordUserInput(data) {
    let text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
    if (!text) return getState();
    if (pendingEscapeText) {
      text = `${pendingEscapeText}${text}`;
      pendingEscapeText = '';
    }
    markUserInput();

    for (let index = 0; index < text.length;) {
      const code = text.charCodeAt(index);
      const char = text[index];

      if (char === '\x1b' && isIncompleteEscapeSequence(text, index)) {
        pendingEscapeText = text.slice(index);
        break;
      }

      const keyboard = parseKeyboardProtocolSequence(text, index);
      if (keyboard) {
        const keyCode = keyboard.unicode ?? keyboard.keyCode;
        if (keyCode === 13) {
          markSubmitted();
        } else if (keyCode === 3 || keyCode === 21) {
          draftKinds.length = 0;
          clearSubmittedHold();
        } else if (keyCode === 23) {
          deletePreviousWord();
        } else if (keyCode === 8 || keyCode === 127) {
          draftKinds.pop();
        } else if (keyboard.text) {
          appendDraftText(keyboard.text);
        }
        index = keyboard.nextIndex;
        continue;
      }
      if (char === '\x1b' && text[index + 1] === 'O' && text[index + 2] === 'M') {
        markSubmitted();
        index += 3;
        continue;
      }
      if (char === '\x1b') {
        index = skipEscapeSequence(text, index);
        continue;
      }
      if (char === '\r' || char === '\n') {
        markSubmitted();
        index += 1;
        continue;
      }
      if (char === '\x03' || char === '\x15') {
        draftKinds.length = 0;
        clearSubmittedHold();
        index += 1;
        continue;
      }
      if (char === '\x17') {
        deletePreviousWord();
        index += 1;
        continue;
      }
      if (char === '\b' || char === '\x7f') {
        draftKinds.pop();
        index += 1;
        continue;
      }
      if (char === '\t' || code < 0x20 || code === 0x7f) {
        index += 1;
        continue;
      }

      const codePoint = text.codePointAt(index);
      appendDraftText(String.fromCodePoint(codePoint));
      index += codePoint > 0xffff ? 2 : 1;
    }

    return getState();
  }

  function getState() {
    const currentNow = now();
    const msSinceLastUserInput = lastUserInputAt > 0 ? currentNow - lastUserInputAt : null;
    const msAwaitingPrompt =
      awaitingPromptAfterSubmit && awaitingPromptStartedAt > 0
        ? currentNow - awaitingPromptStartedAt
        : null;
    if (
      awaitingPromptAfterSubmit &&
      submitAwaitTimeoutMs >= 0 &&
      msAwaitingPrompt !== null &&
      msAwaitingPrompt >= submitAwaitTimeoutMs
    ) {
      clearSubmittedHold();
    }
    const recentUserInput =
      msSinceLastUserInput !== null && msSinceLastUserInput < idleGraceMs;
    const hasDraft = draftKinds.length > 0;
    const defer = hasDraft || awaitingPromptAfterSubmit || recentUserInput;
    return {
      defer,
      reason: hasDraft
        ? 'user-input-buffer'
        : awaitingPromptAfterSubmit
          ? 'user-turn-active'
          : recentUserInput
            ? 'recent-user-input'
            : null,
      draftChars: draftKinds.length,
      awaitingPromptAfterSubmit,
      idleGraceMs,
      submitAwaitTimeoutMs,
      lastUserInputAt: lastUserInputAt || null,
      msSinceLastUserInput,
      recentUserInput,
      awaitingPromptStartedAt: awaitingPromptStartedAt || null,
      msAwaitingPrompt,
      pendingEscapeBytes: pendingEscapeText.length,
    };
  }

  return {
    recordUserInput,
    getState,
    shouldDeferPtyBridgeWrite() {
      const state = getState();
      return state.defer ? state : null;
    },
    markCodexPromptReady() {
      clearSubmittedHold();
      return getState();
    },
    reset() {
      draftKinds.length = 0;
      clearSubmittedHold();
      lastUserInputAt = 0;
      pendingEscapeText = '';
    },
  };
}

function readJsonFileSync(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readCodexPtyBridgeReady(
  sessionName,
  { rootDir = getCodexPtyBridgeRoot(), maxAgeMs = 30_000, now = Date.now } = {},
) {
  const paths = getCodexPtyBridgePaths(sessionName, { rootDir });
  if (!existsSync(paths.readyPath)) {
    return { ready: false, reason: 'ready-missing', paths };
  }

  const ready = readJsonFileSync(paths.readyPath);
  if (!ready || ready.ipcName !== sessionName) {
    return { ready: false, reason: 'ready-invalid', paths, readyInfo: ready };
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(paths.readyPath).mtimeMs;
  } catch {
    return { ready: false, reason: 'ready-stat-failed', paths, readyInfo: ready };
  }

  if (maxAgeMs >= 0 && now() - mtimeMs > maxAgeMs) {
    return { ready: false, reason: 'ready-stale', paths, readyInfo: ready, ageMs: now() - mtimeMs };
  }

  if (!isPidAlive(ready.wrapperPid)) {
    return { ready: false, reason: 'wrapper-not-alive', paths, readyInfo: ready };
  }

  return { ready: true, reason: 'ready', paths, readyInfo: ready, ageMs: now() - mtimeMs };
}

async function waitForAck(ackPath, { timeoutMs = 2500, pollMs = 50 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return JSON.parse(await readFile(ackPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`timeout waiting for codex pty bridge ack: ${ackPath}`);
}

function parseQueueEntryCreatedAtMs(entry, payload = null) {
  const fromPayload = Date.parse(payload?.createdAt ?? '');
  if (Number.isFinite(fromPayload)) return fromPayload;
  const fromName = Number.parseInt(String(entry).split('-', 1)[0] ?? '', 10);
  return Number.isFinite(fromName) ? fromName : null;
}

async function readQueuePayload(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeBridgeAck(ackPath, ack) {
  await writeFile(ackPath, `${JSON.stringify(ack)}\n`, 'utf8');
  return ack;
}

async function readExistingAck(ackPath) {
  try {
    return JSON.parse(await readFile(ackPath, 'utf8'));
  } catch {
    return null;
  }
}

async function getQueueTtlBaseMs(paths, entry) {
  const ack = await readExistingAck(join(paths.ackDir, `${entry}.ack.json`));
  if (ack?.deferred !== true) return null;
  const deferredAtMs = Date.parse(ack.deferredAt ?? '');
  return Number.isFinite(deferredAtMs) ? deferredAtMs : null;
}

async function dropQueueEntry({
  sessionName,
  paths,
  entry,
  wrapperPid,
  now,
  reason,
  detail = {},
  onDrop = null,
}) {
  const queuePath = join(paths.queueDir, entry);
  const droppingPath = `${queuePath}.${wrapperPid}.dropping`;
  try {
    await rename(queuePath, droppingPath);
  } catch {
    return null;
  }

  const ackPath = join(paths.ackDir, `${entry}.ack.json`);
  const payload = await readQueuePayload(droppingPath);
  const createdAtMs = parseQueueEntryCreatedAtMs(entry, payload);
  const droppedAt = now();
  const ack = {
    version: 1,
    ok: false,
    queued: true,
    deferred: false,
    dispatched: false,
    dropped: true,
    reason,
    msgId: payload?.msgId ?? null,
    ipcName: sessionName,
    wrapperPid,
    queuedAt: createdAtMs !== null ? new Date(createdAtMs).toISOString() : null,
    droppedAt: new Date(droppedAt).toISOString(),
    ageMs: createdAtMs !== null ? droppedAt - createdAtMs : null,
    ...detail,
  };
  try {
    await writeBridgeAck(ackPath, ack);
  } finally {
    await rm(droppingPath, { force: true });
  }
  if (typeof onDrop === 'function') {
    onDrop({ ...ack, nextEntry: entry });
  }
  return ack;
}

async function enforceQueueLimits({
  sessionName,
  paths,
  entries,
  wrapperPid,
  now,
  queueMaxEntries,
  queueTtlMs,
  onDrop,
}) {
  let kept = [...entries];
  if (queueTtlMs > 0) {
    const nextKept = [];
    for (const entry of kept) {
      const ttlBaseMs = await getQueueTtlBaseMs(paths, entry);
      const ageMs = ttlBaseMs !== null ? now() - ttlBaseMs : null;
      if (ageMs !== null && ageMs > queueTtlMs) {
        await dropQueueEntry({
          sessionName,
          paths,
          entry,
          wrapperPid,
          now,
          reason: 'queue-ttl-expired',
          detail: { queueTtlMs, ttlAgeMs: ageMs },
          onDrop,
        });
      } else {
        nextKept.push(entry);
      }
    }
    kept = nextKept;
  }

  if (Number.isInteger(queueMaxEntries) && queueMaxEntries >= 0 && kept.length > queueMaxEntries) {
    const dropCount = kept.length - queueMaxEntries;
    const toDrop = kept.slice(0, dropCount);
    kept = kept.slice(dropCount);
    for (const entry of toDrop) {
      await dropQueueEntry({
        sessionName,
        paths,
        entry,
        wrapperPid,
        now,
        reason: 'queue-cap-exceeded',
        detail: { queueMaxEntries, droppedForCap: dropCount },
        onDrop,
      });
    }
  }

  return kept;
}

export async function enqueueCodexPtyPrompt(
  sessionName,
  msg,
  {
    rootDir = getCodexPtyBridgeRoot(),
    now = Date.now,
    waitForAckMs = 2500,
    readyMaxAgeMs = 30_000,
  } = {},
) {
  const readyState = readCodexPtyBridgeReady(sessionName, {
    rootDir,
    maxAgeMs: readyMaxAgeMs,
    now,
  });
  if (!readyState.ready) {
    const error = new Error(`codex pty bridge unavailable: ${readyState.reason}`);
    error.code = 'CODEX_PTY_BRIDGE_UNAVAILABLE';
    error.readyState = readyState;
    throw error;
  }

  const paths = readyState.paths;
  await mkdir(paths.queueDir, { recursive: true });
  await mkdir(paths.ackDir, { recursive: true });

  const msgId = String(msg?.id || `msg-${now()}`);
  const queueName = `${now()}-${msgId.replace(/[^\w.-]/g, '_')}.json`;
  const queuePath = join(paths.queueDir, queueName);
  const tmpPath = `${queuePath}.${process.pid}.tmp`;
  const ackPath = join(paths.ackDir, `${queueName}.ack.json`);
  const prompt = formatCodexPtyPrompt(msg);
  const payload = {
    version: 1,
    msgId,
    ipcName: sessionName,
    createdAt: new Date(now()).toISOString(),
    prompt,
  };

  await writeFile(tmpPath, `${JSON.stringify(payload)}\n`, 'utf8');
  await rename(tmpPath, queuePath);

  if (waitForAckMs <= 0) {
    return {
      version: 1,
      ok: true,
      queued: true,
      deferred: false,
      dispatched: false,
      msgId,
      ipcName: sessionName,
      wrapperPid: readyState.readyInfo?.wrapperPid ?? null,
      queuedAt: new Date(now()).toISOString(),
      queuePath,
      ackPath,
      promptChars: prompt.length,
      waitForAckMs,
    };
  }

  const ack = await waitForAck(ackPath, { timeoutMs: waitForAckMs });
  return { ...ack, queuePath, ackPath, promptChars: prompt.length };
}

export async function createCodexPtyBridgeReady(
  sessionName,
  { rootDir = getCodexPtyBridgeRoot(), wrapperPid = process.pid, now = Date.now } = {},
) {
  const paths = getCodexPtyBridgePaths(sessionName, { rootDir });
  await mkdir(paths.queueDir, { recursive: true });
  await mkdir(paths.ackDir, { recursive: true });
  const payload = {
    version: 1,
    ipcName: sessionName,
    wrapperPid,
    updatedAt: new Date(now()).toISOString(),
  };
  await writeFile(paths.readyPath, `${JSON.stringify(payload)}\n`, 'utf8');
  return { paths, payload };
}

export async function processCodexPtyBridgeQueue(
  sessionName,
  {
    rootDir = getCodexPtyBridgeRoot(),
    writePrompt,
    wrapperPid = process.pid,
    now = Date.now,
    submitDelayMs = 0,
    shouldDeferWrite = null,
    onDefer = null,
    onDrop = null,
    queueMaxEntries = DEFAULT_CODEX_PTY_QUEUE_MAX_ENTRIES,
    queueTtlMs = DEFAULT_CODEX_PTY_QUEUE_TTL_MS,
  } = {},
) {
  if (typeof writePrompt !== 'function') {
    throw new TypeError('processCodexPtyBridgeQueue requires writePrompt');
  }
  const paths = getCodexPtyBridgePaths(sessionName, { rootDir });
  await mkdir(paths.queueDir, { recursive: true });
  await mkdir(paths.ackDir, { recursive: true });

  let entries = (await readdir(paths.queueDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  entries = await enforceQueueLimits({
    sessionName,
    paths,
    entries,
    wrapperPid,
    now,
    queueMaxEntries,
    queueTtlMs,
    onDrop,
  });

  const processed = [];
  for (const entry of entries) {
    const queuePath = join(paths.queueDir, entry);
    const ackPath = join(paths.ackDir, `${entry}.ack.json`);
    let deferState = null;
    if (typeof shouldDeferWrite === 'function') {
      try {
        deferState = shouldDeferWrite();
      } catch {}
    }
    if (deferState) {
      const payload = await readQueuePayload(queuePath);
      const createdAtMs = parseQueueEntryCreatedAtMs(entry, payload);
      const deferredAt = now();
      const existingAck = await readExistingAck(ackPath);
      const existingDeferredAtMs = Date.parse(existingAck?.deferredAt ?? '');
      const firstDeferredAt =
        existingAck?.deferred === true && Number.isFinite(existingDeferredAtMs)
          ? existingAck.deferredAt
          : new Date(deferredAt).toISOString();
      await writeBridgeAck(ackPath, {
        version: 1,
        ok: true,
        queued: true,
        deferred: true,
        dispatched: false,
        msgId: payload?.msgId ?? null,
        ipcName: sessionName,
        wrapperPid,
        reason: deferState.reason ?? 'deferred',
        deferredAt: firstDeferredAt,
        lastDeferredAt: new Date(deferredAt).toISOString(),
        queuedAt: createdAtMs !== null ? new Date(createdAtMs).toISOString() : null,
        ageMs: createdAtMs !== null ? deferredAt - createdAtMs : null,
        pendingCount: entries.length - processed.length,
        nextEntry: entry,
        draftChars: deferState.draftChars ?? null,
        idleGraceMs: deferState.idleGraceMs ?? null,
        msSinceLastUserInput: deferState.msSinceLastUserInput ?? null,
        awaitingPromptAfterSubmit: deferState.awaitingPromptAfterSubmit ?? null,
        msAwaitingPrompt: deferState.msAwaitingPrompt ?? null,
      }).catch(() => {});
      if (typeof onDefer === 'function') {
        onDefer({
          ...deferState,
          pendingCount: entries.length - processed.length,
          nextEntry: entry,
        });
      }
      break;
    }

    const processingPath = `${queuePath}.${wrapperPid}.processing`;
    try {
      await rename(queuePath, processingPath);
    } catch {
      continue;
    }

    try {
      const payload = JSON.parse(await readFile(processingPath, 'utf8'));
      const promptText = String(payload.prompt ?? '');
      const dispatchedAt = now();
      if (promptText.length > 0) {
        await writePrompt(promptText);
        if (submitDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
        }
      }
      await writePrompt(CODEX_PTY_SUBMIT_SEQUENCE);
      const ack = {
        version: 1,
        ok: true,
        queued: true,
        deferred: false,
        dispatched: true,
        msgId: payload.msgId ?? null,
        ipcName: sessionName,
        wrapperPid,
        wroteAt: new Date(dispatchedAt).toISOString(),
        dispatchedAt: new Date(dispatchedAt).toISOString(),
        queuedAt: payload.createdAt ?? null,
        promptChars: promptText.length,
        submitDelayMs,
        writeCount: promptText.length > 0 ? 2 : 1,
        submitSequence: CODEX_PTY_SUBMIT_SEQUENCE_NAME,
        submitBytesHex: Buffer.from(CODEX_PTY_SUBMIT_SEQUENCE, 'utf8').toString('hex'),
      };
      await writeBridgeAck(ackPath, ack);
      processed.push(ack);
    } catch (error) {
      const ack = {
        version: 1,
        ok: false,
        queued: true,
        deferred: false,
        dispatched: false,
        ipcName: sessionName,
        wrapperPid,
        wroteAt: new Date(now()).toISOString(),
        error: error?.message ?? String(error),
      };
      await writeBridgeAck(ackPath, ack).catch(() => {});
    } finally {
      await rm(processingPath, { force: true });
    }
  }

  return processed;
}
