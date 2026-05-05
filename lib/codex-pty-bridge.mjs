import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_CODEX_PTY_BRIDGE_DIR = join(PROJECT_DIR, 'data', 'codex-pty-bridge');

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
  return new Date(ts ?? Date.now())
    .toISOString()
    .replace(/T/, ' ')
    .replace(/\.\d+Z$/, '+00:00');
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
    submitDelayMs = 1000,
  } = {},
) {
  if (typeof writePrompt !== 'function') {
    throw new TypeError('processCodexPtyBridgeQueue requires writePrompt');
  }
  const paths = getCodexPtyBridgePaths(sessionName, { rootDir });
  await mkdir(paths.queueDir, { recursive: true });
  await mkdir(paths.ackDir, { recursive: true });

  const entries = (await readdir(paths.queueDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  const processed = [];
  for (const entry of entries) {
    const queuePath = join(paths.queueDir, entry);
    const processingPath = `${queuePath}.${wrapperPid}.processing`;
    try {
      await rename(queuePath, processingPath);
    } catch {
      continue;
    }

    const ackPath = join(paths.ackDir, `${entry}.ack.json`);
    try {
      const payload = JSON.parse(await readFile(processingPath, 'utf8'));
      const promptText = String(payload.prompt ?? '');
      if (promptText.length > 0) {
        await writePrompt(promptText);
        if (submitDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
        }
      }
      await writePrompt('\r');
      const ack = {
        version: 1,
        ok: true,
        msgId: payload.msgId ?? null,
        ipcName: sessionName,
        wrapperPid,
        wroteAt: new Date(now()).toISOString(),
        promptChars: promptText.length,
        submitDelayMs,
        writeCount: promptText.length > 0 ? 2 : 1,
      };
      await writeFile(ackPath, `${JSON.stringify(ack)}\n`, 'utf8');
      processed.push(ack);
    } catch (error) {
      const ack = {
        version: 1,
        ok: false,
        ipcName: sessionName,
        wrapperPid,
        wroteAt: new Date(now()).toISOString(),
        error: error?.message ?? String(error),
      };
      await writeFile(ackPath, `${JSON.stringify(ack)}\n`, 'utf8').catch(() => {});
    } finally {
      await rm(processingPath, { force: true });
    }
  }

  return processed;
}
