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
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

function maybeCreateCodexSession(options) {
  const transcriptPath = process.env.PTY_MOCK_CODEX_SESSION_PATH;
  const sessionId = process.env.PTY_MOCK_CODEX_SESSION_ID;
  if (!transcriptPath || !sessionId) return;

  const delayMs = Number.parseInt(process.env.PTY_MOCK_CODEX_SESSION_DELAY_MS ?? '0', 10);
  setTimeout(() => {
    const timestamp = new Date().toISOString();
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        timestamp,
        type: 'session_meta',
        payload: {
          id: sessionId,
          timestamp,
          cwd: options?.cwd,
          source: 'cli',
          originator: 'codex-tui',
        },
      }) + '\n',
      'utf8',
    );
  }, Number.isFinite(delayMs) ? delayMs : 0);
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
  maybeCreateCodexSession(options);

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
        PTY_MOCK_EXIT_MS: '120',
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
      '\x1b[C\r',
    ]);
    const ack = JSON.parse(await readFile(join(ackDir, `${queueName}.ack.json`), 'utf8'));
    assert.equal(ack.ok, true);
    assert.equal(ack.msgId, 'msg-test');
    assert.equal(ack.submitDelayMs, 0);
    assert.equal(ack.writeCount, 2);
    assert.equal(ack.submitSequence, 'right-arrow-cr');
    assert.equal(ack.submitBytesHex, '1b5b430d');
  });

  test('records IPC_NAME to a local Codex session map for resume lookup', async () => {
    const codexHome = join(tempDir, `codex-home-${Date.now()}`);
    const sessionDir = join(codexHome, 'sessions', '2026', '05', '06');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const transcriptPath = join(
      sessionDir,
      `rollout-2026-05-06T07-00-00-${sessionId}.jsonl`,
    );

    const result = await runWrapper({
      env: {
        IPC_NAME: 'test-map',
        CODEX_HOME: codexHome,
        IPC_CODEX_SESSION_MAP_POLL_MS: '10',
        IPC_CODEX_SESSION_MAP_TIMEOUT_MS: '500',
        IPC_CODEX_SESSION_MAP_POST_HUB: '0',
        PTY_MOCK_CODEX_SESSION_ID: sessionId,
        PTY_MOCK_CODEX_SESSION_PATH: transcriptPath,
        PTY_MOCK_CODEX_SESSION_DELAY_MS: '25',
        PTY_MOCK_EXIT_MS: '120',
      },
    });

    assert.equal(result.code, 0);
    const mapContent = await readFile(
      join(codexHome, 'ipcx-session-map', 'test-map.jsonl'),
      'utf8',
    );
    const records = mapContent.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'test-map');
    assert.equal(records[0].runtime, 'codex');
    assert.equal(records[0].sessionId, sessionId);
    assert.equal(records[0].transcriptPath, transcriptPath);
  });

  test('does not map the previous fresh Codex session while waiting for the new transcript', async () => {
    const codexHome = join(tempDir, `codex-home-stale-${Date.now()}`);
    const sessionDir = join(codexHome, 'sessions', '2026', '05', '06');
    const oldSessionId = '22222222-2222-4222-8222-222222222222';
    const newSessionId = '33333333-3333-4333-8333-333333333333';
    const oldTranscriptPath = join(
      sessionDir,
      `rollout-2026-05-06T07-00-00-${oldSessionId}.jsonl`,
    );
    const newTranscriptPath = join(
      sessionDir,
      `rollout-2026-05-06T07-00-05-${newSessionId}.jsonl`,
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      oldTranscriptPath,
      `${JSON.stringify({
        timestamp: '2026-05-05T23:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: oldSessionId,
          timestamp: '2026-05-05T23:00:00.000Z',
          cwd: projectRoot,
          source: 'cli',
          originator: 'codex-tui',
        },
      })}\n`,
      'utf8',
    );

    const result = await runWrapper({
      env: {
        IPC_NAME: 'test-map-stale',
        CODEX_HOME: codexHome,
        IPC_CODEX_SESSION_MAP_POLL_MS: '10',
        IPC_CODEX_SESSION_MAP_TIMEOUT_MS: '500',
        IPC_CODEX_SESSION_MAP_POST_HUB: '0',
        PTY_MOCK_CODEX_SESSION_ID: newSessionId,
        PTY_MOCK_CODEX_SESSION_PATH: newTranscriptPath,
        PTY_MOCK_CODEX_SESSION_DELAY_MS: '45',
        PTY_MOCK_EXIT_MS: '160',
      },
    });

    assert.equal(result.code, 0);
    const mapContent = await readFile(
      join(codexHome, 'ipcx-session-map', 'test-map-stale.jsonl'),
      'utf8',
    );
    const records = mapContent.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].sessionId, newSessionId);
    assert.equal(records[0].transcriptPath, newTranscriptPath);
  });
});
