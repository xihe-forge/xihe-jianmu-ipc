import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverPath = join(projectRoot, 'mcp-server.mjs');

function uniqueName(suffix) {
  return `lifecycle-${suffix}-${process.pid}-${Date.now()}`;
}

function spawnMcpServer(suffix) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      IPC_HUB_AUTOSTART: 'false',
      IPC_MCP_TRACE_DISABLE: '1',
      IPC_NAME: uniqueName(suffix),
      IPC_PORT: '49999',
      IPC_RUNTIME: 'claude',
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

async function withMcpServer(suffix, fn) {
  const proc = spawnMcpServer(suffix);
  try {
    await waitForStderr(proc.getOutput, /MCP server ready/);
    return await fn(proc);
  } finally {
    if (!proc.child.killed && proc.child.exitCode === null) {
      try {
        proc.child.kill('SIGKILL');
      } catch {}
    }
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

  for (const signalName of ['SIGTERM', 'SIGINT']) {
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
