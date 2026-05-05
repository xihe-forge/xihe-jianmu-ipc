import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const sourceWrapperPath = join(projectRoot, 'bin', 'codex-title-wrapper.mjs');

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

function parseEvents() {
  if (!process.env.PTY_MOCK_DATA_EVENTS) return [];
  return JSON.parse(process.env.PTY_MOCK_DATA_EVENTS);
}

export function spawn(command, args, options) {
  const dataHandlers = [];
  const exitHandlers = [];
  let exited = false;

  function emitData(data) {
    for (const handler of dataHandlers) handler(data);
  }

  function emitExit(exitCode = 0) {
    if (exited) return;
    exited = true;
    for (const handler of exitHandlers) handler({ exitCode, signal: undefined });
  }

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
    },
    onData(handler) {
      dataHandlers.push(handler);
      record('onData');
      for (const event of parseEvents()) {
        setTimeout(() => emitData(event.data), event.delayMs ?? 0);
      }
      return { dispose() {} };
    },
    onExit(handler) {
      exitHandlers.push(handler);
      record('onExit');
      if (process.env.PTY_MOCK_EXIT_MS !== undefined) {
        const delayMs = Number.parseInt(process.env.PTY_MOCK_EXIT_MS, 10);
        const exitCode = Number.parseInt(process.env.PTY_MOCK_EXIT_CODE ?? '0', 10);
        setTimeout(() => emitExit(exitCode), delayMs);
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
  tempDir = await mkdtemp(join(tmpdir(), 'codex-title-wrapper-'));
  await mkdir(join(tempDir, 'bin'), { recursive: true });
  await mkdir(join(tempDir, 'lib'), { recursive: true });
  wrapperPath = join(tempDir, 'bin', 'codex-title-wrapper.mjs');
  await writeFile(wrapperPath, await readFile(sourceWrapperPath, 'utf8'), 'utf8');
  await writeFile(
    join(tempDir, 'lib', 'codex-pty-bridge.mjs'),
    await readFile(join(projectRoot, 'lib', 'codex-pty-bridge.mjs'), 'utf8'),
    'utf8',
  );
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

async function readEvents(logPath) {
  if (!existsSync(logPath)) return [];
  const content = await readFile(logPath, 'utf8');
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runWrapper({ env = {}, input = null, timeoutMs = 1500 }) {
  const logPath = join(tempDir, `${Math.random().toString(16).slice(2)}.jsonl`);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, 'codex.cmd', '--version'], {
      cwd: projectRoot,
      env: { ...process.env, IPC_NAME: '', PTY_MOCK_LOG: logPath, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

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

    if (input !== null) {
      setTimeout(() => {
        child.stdin.write(input);
      }, 10);
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
          events: await readEvents(logPath),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function writeEvents(result) {
  return result.events.filter((event) => event.event === 'write');
}

describe('Phase 2 K.S Codex title wrapper', () => {
  test('startup emits IPC_NAME as OSC 0 title once', async () => {
    const result = await runWrapper({
      env: {
        IPC_NAME: 'test-ks',
        PTY_MOCK_EXIT_MS: '20',
      },
    });

    assert.equal(result.code, 0);
    assert.equal(count(result.stdout, '\x1b]0;test-ks\x07'), 1);
  });

  test('Codex OSC 0/1/2 title updates are rewritten to IPC_NAME', async () => {
    const result = await runWrapper({
      env: {
        IPC_NAME: 'test-ks',
        PTY_MOCK_EXIT_MS: '20',
        PTY_MOCK_DATA_EVENTS: JSON.stringify([
          { data: '\x1b]0;xiheAi\x07body\x1b]2;Other Title\x1b\\\x1b]1;icon\x07' },
        ]),
      },
    });

    assert.equal(result.code, 0);
    assert.equal(count(result.stdout, '\x1b]0;test-ks\x07'), 4);
    assert.doesNotMatch(result.stdout, /xiheAi|Other Title|icon/);
  });

  test('empty IPC_NAME skips title injection and preserves Codex title output', async () => {
    const title = '\x1b]2;xiheAi\x1b\\';
    const result = await runWrapper({
      env: {
        IPC_NAME: '',
        PTY_MOCK_EXIT_MS: '20',
        PTY_MOCK_DATA_EVENTS: JSON.stringify([{ data: `${title}body` }]),
      },
    });

    assert.equal(result.code, 0);
    assert.equal(count(result.stdout, '\x1b]0;'), 0);
    assert.match(result.stdout, /\x1b\]2;xiheAi\x1b\\/);
  });

  test('stdin is forwarded without unsolicited auto-enter behavior', async () => {
    const result = await runWrapper({
      input: 'hello\r',
      env: {
        IPC_NAME: 'test-ks',
        PTY_MOCK_EXIT_MS: '50',
      },
    });

    assert.equal(result.code, 0);
    assert.deepEqual(writeEvents(result).map((event) => event.data), ['hello\r']);
  });

  test('Codex PTY bridge queue writes IPC prompts into the visible pty', async () => {
    const bridgeRoot = join(tempDir, 'bridge');
    const sessionName = `test-bridge-${Date.now()}`;
    const sessionDir = join(bridgeRoot, sessionName);
    const queueDir = join(sessionDir, 'queue');
    const ackDir = join(sessionDir, 'ack');
    const queueName = '001-msg-test.json';
    await mkdir(queueDir, { recursive: true });
    await mkdir(ackDir, { recursive: true });
    await writeFile(
      join(queueDir, queueName),
      `${JSON.stringify({ msgId: 'msg-test', prompt: '← ipc: test bridge prompt' })}\n`,
      'utf8',
    );

    const result = await runWrapper({
      env: {
        IPC_NAME: sessionName,
        IPC_CODEX_PTY_BRIDGE_DIR: bridgeRoot,
        IPC_CODEX_PTY_SUBMIT_DELAY_MS: '0',
        PTY_MOCK_EXIT_MS: '200',
      },
    });

    assert.equal(result.code, 0);
    assert.deepEqual(writeEvents(result).map((event) => event.data), [
      '← ipc: test bridge prompt',
      '\r',
    ]);
    const ack = JSON.parse(await readFile(join(ackDir, `${queueName}.ack.json`), 'utf8'));
    assert.equal(ack.ok, true);
    assert.equal(ack.msgId, 'msg-test');
    assert.equal(ack.submitDelayMs, 0);
    assert.equal(ack.writeCount, 2);
  });
});
