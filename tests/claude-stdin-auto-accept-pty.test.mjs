import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const sourceWrapperPath = join(projectRoot, 'bin', 'claude-stdin-auto-accept.mjs');

let tempDir;
let wrapperPath;

const fakePtySource = String.raw`
import { appendFileSync } from 'node:fs';

const logPath = process.env.PTY_MOCK_LOG;

function record(event, fields = {}) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify({ event, t: Date.now(), ...fields }) + '\n', 'utf8');
}

function normalizeData(data) {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data);
}

export function spawn(command, args, options) {
  const exitHandlers = [];

  record('spawn', {
    command,
    args,
    options: {
      name: options?.name,
      cols: options?.cols,
      rows: options?.rows,
      cwd: options?.cwd,
      hasEnv: Boolean(options?.env),
      ipcName: options?.env?.IPC_NAME ?? null,
    },
  });

  return {
    write(data) {
      record('write', { data: normalizeData(data) });
      if (process.env.PTY_MOCK_EXIT_ON_WRITE === '1') {
        setTimeout(() => {
          for (const handler of exitHandlers) {
            handler({ exitCode: 0, signal: undefined });
          }
        }, 0);
      }
    },
    onData(handler) {
      record('onData');
      if (process.env.PTY_MOCK_EMIT_DATA !== undefined) {
        const delayMs = Number.parseInt(process.env.PTY_MOCK_EMIT_DATA_MS ?? '0', 10);
        setTimeout(() => handler(process.env.PTY_MOCK_EMIT_DATA), delayMs);
      }
      return { dispose() {} };
    },
    onExit(handler) {
      exitHandlers.push(handler);
      record('onExit');
      if (process.env.PTY_MOCK_EXIT_MS !== undefined) {
        const delayMs = Number.parseInt(process.env.PTY_MOCK_EXIT_MS, 10);
        const exitCode = Number.parseInt(process.env.PTY_MOCK_EXIT_CODE ?? '0', 10);
        setTimeout(() => handler({ exitCode, signal: undefined }), delayMs);
      }
      return { dispose() {} };
    },
    resize(cols, rows) {
      record('resize', { cols, rows });
    },
  };
}
`;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claude-stdin-auto-accept-pty-'));
  wrapperPath = join(tempDir, 'claude-stdin-auto-accept.mjs');
  await writeFile(wrapperPath, await readFile(sourceWrapperPath, 'utf8'), 'utf8');
  await writeFakePtyPackage('node-pty-prebuilt-multiarch');
  await writeFakePtyPackage('@lydell/node-pty');
});

after(async () => {
  if (tempDir) {
    await rm(tempDir, { force: true, recursive: true });
  }
});

async function writeFakePtyPackage(packageName) {
  const packageDir = join(tempDir, 'node_modules', ...packageName.split('/'));
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, type: 'module', exports: './index.js' }),
    'utf8',
  );
  await writeFile(join(packageDir, 'index.js'), fakePtySource, 'utf8');
}

function readEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFile(logPath, 'utf8').then((content) => (
    content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  ));
}

async function runWrapper({ args, env = {}, stdin, stdinDelayMs = 50, timeoutMs = 2500 }) {
  const logPath = join(tempDir, `${Math.random().toString(16).slice(2)}.jsonl`);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, process.execPath, ...args], {
      cwd: projectRoot,
      env: { ...process.env, PTY_MOCK_LOG: logPath, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`wrapper timeout\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    if (stdin !== undefined) {
      setTimeout(() => child.stdin.write(stdin), stdinDelayMs);
    }

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once('exit', async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve({
          code,
          signal,
          stdout,
          stderr,
          startedAt,
          events: await readEvents(logPath),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('ADR-014 Phase 2 K.M stdin auto-accept real PTY behavior', () => {
  test('pty.spawn is called once with the Claude binary, args, cwd, env, and xterm geometry', async () => {
    const script = 'setTimeout(() => process.exit(0), 10);';
    const result = await runWrapper({
      args: ['-e', script, '--sentinel'],
      env: { PTY_MOCK_EXIT_MS: '10', IPC_NAME: 'km-unit' },
    });

    assert.equal(result.code, 0);
    const spawnEvents = result.events.filter((event) => event.event === 'spawn');
    assert.equal(spawnEvents.length, 1);
    assert.equal(spawnEvents[0].command, process.execPath);
    assert.deepEqual(spawnEvents[0].args, ['-e', script, '--sentinel']);
    assert.equal(spawnEvents[0].options.name, 'xterm-256color');
    assert.equal(spawnEvents[0].options.cols, 120);
    assert.equal(spawnEvents[0].options.rows, 30);
    assert.equal(spawnEvents[0].options.cwd, projectRoot);
    assert.equal(spawnEvents[0].options.hasEnv, true);
    assert.equal(spawnEvents[0].options.ipcName, 'km-unit');
  });

  test("default early accept writes '1\\r' to the PTY child after the 1.5s guard", async () => {
    const result = await runWrapper({
      args: ['-e', 'setTimeout(() => process.exit(0), 2000);'],
      env: { PTY_MOCK_EXIT_ON_WRITE: '1' },
      timeoutMs: 3000,
    });

    assert.equal(result.code, 0);
    const writeEvent = result.events.find((event) => event.event === 'write');
    assert.ok(writeEvent, `missing write event: ${JSON.stringify(result.events)}`);
    assert.equal(writeEvent.data, '1\r');
    assert.ok(writeEvent.t - result.startedAt >= 1000, `write happened too early: ${writeEvent.t - result.startedAt}ms`);
    assert.ok(writeEvent.t - result.startedAt < 2500, `write happened too late: ${writeEvent.t - result.startedAt}ms`);
  });

  test('child onData output is forwarded to process stdout', async () => {
    const result = await runWrapper({
      args: ['-e', 'setTimeout(() => process.exit(0), 50);'],
      env: { PTY_MOCK_EMIT_DATA: 'hello from pty', PTY_MOCK_EXIT_MS: '20' },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'hello from pty');
  });

  test('process stdin data is forwarded to child.write for interactive input', async () => {
    const result = await runWrapper({
      args: ['-e', 'setTimeout(() => process.exit(0), 1000);'],
      env: {
        CLAUDE_STDIN_AUTO_ACCEPT_EARLY_MS: '5000',
        PTY_MOCK_EXIT_ON_WRITE: '1',
      },
      stdin: 'test',
      timeoutMs: 1500,
    });

    assert.equal(result.code, 0);
    assert.ok(
      result.events.some((event) => event.event === 'write' && event.data === 'test'),
      `missing forwarded stdin write: ${JSON.stringify(result.events)}`,
    );
  });
});
