import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { startHub, stopHub, waitForHealth } from './helpers/hub-fixture.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverPath = join(projectRoot, 'mcp-server.mjs');

function uniqueName(suffix) {
  return `lifecycle-${suffix}-${process.pid}-${Date.now()}`;
}

function spawnMcpServer(suffix, env = {}, options = {}) {
  const ipcName = env.IPC_NAME ?? uniqueName(suffix);
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      IPC_HUB_AUTOSTART: 'false',
      IPC_MCP_TRACE_DISABLE: '1',
      IPC_NAME: ipcName,
      IPC_PORT: '49999',
      IPC_RUNTIME: 'claude',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    ipcName,
    getOutput: () => ({ stdout, stderr }),
  };
}

function waitForStderr(getOutput, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (pattern.test(getOutput().stderr)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for stderr ${pattern}\n${getOutput().stderr}`));
      }
    }, 25);
  });
}

function waitForExit(child, getOutput, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      const { stdout, stderr } = getOutput();
      reject(new Error(`mcp-server did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stopChild(child, getOutput) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exitPromise = waitForExit(child, getOutput, 2_000).catch(() => {});
  try {
    child.kill('SIGKILL');
  } catch {}
  await exitPromise;
}

async function withMcpServer(suffix, fn) {
  const proc = spawnMcpServer(suffix);
  try {
    await waitForStderr(proc.getOutput, /MCP server ready/);
    return await fn(proc);
  } finally {
    await stopChild(proc.child, proc.getOutput);
  }
}

function createFetchMockPreload(dir) {
  const preloadPath = join(dir, 'mock-fetch.mjs');
  writeFileSync(
    preloadPath,
    `import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url, options = {}) => {
  appendFileSync(
    process.env.IPC_TEST_FETCH_CALLS_PATH,
    JSON.stringify({ url: String(url), options }) + '\\n',
    'utf8',
  );
  if (process.env.IPC_TEST_FETCH_MODE === 'reject') {
    throw new Error('mock fetch reject');
  }
  return {
    ok: true,
    status: 200,
    async text() {
      return '';
    },
    async json() {
      return { ok: true };
    },
  };
};
`,
    'utf8',
  );
  return preloadPath;
}

function readFetchCalls(callsPath) {
  if (!existsSync(callsPath)) return [];
  const content = readFileSync(callsPath, 'utf8').trim();
  if (!content) return [];
  return content.split(/\r?\n/).map((line) => JSON.parse(line));
}

function startClosingHub({ closeCode = 4001, closeReason = 'name taken', terminate = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit('connection', webSocket, request);
      });
    });

    wss.on('connection', (socket) => {
      setImmediate(() => {
        if (terminate) {
          socket.terminate();
        } else {
          socket.close(closeCode, closeReason);
        }
      });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        async close() {
          await new Promise((resolveWss) => wss.close(resolveWss));
          await new Promise((resolveServer, rejectServer) => {
            server.close((error) => {
              if (error) rejectServer(error);
              else resolveServer();
            });
          });
        },
      });
    });
  });
}

async function withFetchMockedMcpClose(
  { suffix, closeCode = 4001, closeReason = 'name taken', terminate = false, fetchMode = 'ok' },
  fn,
) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-close-reclaim-'));
  const callsPath = join(dir, 'fetch-calls.jsonl');
  const preloadPath = createFetchMockPreload(dir);
  const hub = await startClosingHub({ closeCode, closeReason, terminate });
  const ipcName = uniqueName(suffix);
  const proc = spawnMcpServer(
    suffix,
    {
      IPC_HUB_HOST: '127.0.0.1',
      IPC_NAME: ipcName,
      IPC_PORT: String(hub.port),
      IPC_TEST_FETCH_CALLS_PATH: callsPath,
      IPC_TEST_FETCH_MODE: fetchMode,
    },
    { nodeArgs: ['--import', pathToFileURL(preloadPath).href] },
  );

  try {
    await waitForStderr(proc.getOutput, /MCP server ready/, 5_000);
    return await fn({ proc, ipcName, callsPath, port: hub.port });
  } finally {
    await stopChild(proc.child, proc.getOutput);
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Phase 2 K.Y mcp-server lifecycle shutdown', () => {
  test('stdin close exits gracefully within 2s', async () => {
    await withMcpServer('stdin', async ({ child, getOutput }) => {
      child.stdin.end();
      const result = await waitForExit(child, getOutput);
      const { stderr } = getOutput();

      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.match(stderr, /\[ipc\] mcp-server graceful shutdown: stdin-(end|close)/);
    });
  });

  test('registers stdio and process lifecycle handlers', () => {
    const source = readFileSync(serverPath, 'utf8');

    assert.match(source, /process\.stdin\.once\('end'/);
    assert.match(source, /process\.stdin\.once\('close'/);
    assert.match(source, /'SIGTERM'/);
    assert.match(source, /'SIGINT'/);
    assert.match(source, /'SIGHUP'/);
    assert.match(source, /gracefulShutdown\(signal\)/);
  });

  test('ws close 4001 calls mock fetch reclaim-name before reconnecting', { timeout: 10_000 }, async () => {
    await withFetchMockedMcpClose({ suffix: 'close-4001-ok' }, async ({
      proc,
      ipcName,
      callsPath,
      port,
    }) => {
      await waitForStderr(proc.getOutput, /disconnected from hub \(code=4001\)/, 5_000);
      await waitForStderr(proc.getOutput, /reclaimed name '.*' after 4001/, 5_000);
      await waitForStderr(proc.getOutput, /reconnecting in \d+ms/, 5_000);

      const calls = readFetchCalls(callsPath);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `http://127.0.0.1:${port}/reclaim-name`);
      assert.equal(calls[0].options.method, 'POST');
      assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(calls[0].options.body), { name: ipcName });
    });
  });

  test('ws close 4001 schedules reconnect when mock fetch rejects', { timeout: 10_000 }, async () => {
    await withFetchMockedMcpClose(
      { suffix: 'close-4001-reject', fetchMode: 'reject' },
      async ({ proc, callsPath }) => {
        await waitForStderr(proc.getOutput, /disconnected from hub \(code=4001\)/, 5_000);
        await waitForStderr(proc.getOutput, /reclaim-name failed: mock fetch reject/, 5_000);
        await waitForStderr(proc.getOutput, /reconnecting in \d+ms/, 5_000);

        assert.equal(readFetchCalls(callsPath).length, 1);
      },
    );
  });

  test('ws close 1006 skips reclaim-name and still reconnects', { timeout: 10_000 }, async () => {
    await withFetchMockedMcpClose(
      { suffix: 'close-1006', terminate: true },
      async ({ proc, callsPath }) => {
        await waitForStderr(proc.getOutput, /disconnected from hub \(code=1006\)/, 5_000);
        await waitForStderr(proc.getOutput, /reconnecting in \d+ms/, 5_000);

        assert.equal(readFetchCalls(callsPath).length, 0);
      },
    );
  });

  test('dummy e2e: stdin close removes registered hub session within 5s', { timeout: 15_000 }, async () => {
    const hub = await startHub({ prefix: 'mcp-lifecycle' });
    const ipcName = uniqueName('hub');
    const proc = spawnMcpServer('hub', {
      IPC_NAME: ipcName,
      IPC_PORT: String(hub.port),
    });

    try {
      await waitForStderr(proc.getOutput, /MCP server ready/);
      await waitForHealth(
        hub.port,
        (body) => body.sessions.some((session) => session.name === ipcName),
        5_000,
      );

      const startedAt = Date.now();
      proc.child.stdin.end();
      const result = await waitForExit(proc.child, proc.getOutput, 5_000);

      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.ok(Date.now() - startedAt <= 5_000);

      const health = await waitForHealth(
        hub.port,
        (body) => !body.sessions.some((session) => session.name === ipcName),
        5_000,
      );
      assert.ok(!health.sessions.some((session) => session.name === ipcName));
    } finally {
      await stopChild(proc.child, proc.getOutput);
      await stopHub(hub);
    }
  });

  const behavioralSignals = process.platform === 'win32' ? [] : ['SIGTERM', 'SIGINT'];
  for (const signalName of behavioralSignals) {
    test(`${signalName} exits gracefully within 2s`, async () => {
      await withMcpServer(signalName.toLowerCase(), async ({ child, getOutput }) => {
        child.kill(signalName);
        const result = await waitForExit(child, getOutput);
        const { stderr } = getOutput();

        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
        assert.match(stderr, new RegExp(`\\[ipc\\] mcp-server graceful shutdown: ${signalName}`));
      });
    });
  }
});
