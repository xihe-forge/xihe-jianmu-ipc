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
const sourceWrapperPath = join(projectRoot, 'bin', 'claude-stdin-auto-accept.mjs');
const installPs1Path = join(projectRoot, 'bin', 'install.ps1');

let tempDir;
let wrapperPath;

const fakePtySource = String.raw`
import { appendFileSync } from 'node:fs';

const logPath = process.env.PTY_MOCK_LOG;

function record(event, fields = {}) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify({ event, t: Date.now(), ...fields }) + '\n', 'utf8');
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
    },
  });

  return {
    write(data) {
      record('write', { data: String(data) });
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
  tempDir = await mkdtemp(join(tmpdir(), 'claude-stdin-auto-accept-kq-'));
  wrapperPath = join(tempDir, 'claude-stdin-auto-accept.mjs');
  await writeFile(wrapperPath, await readFile(sourceWrapperPath, 'utf8'), 'utf8');
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

async function runWrapper({ env = {}, timeoutMs = 1500 }) {
  const logPath = join(tempDir, `${Math.random().toString(16).slice(2)}.jsonl`);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
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

describe('ADR-014 Phase 2 K.Q helper cwd, sanitizer, and raw PTY capture', () => {
  test('install.ps1 ipc launches from the xiheAi project root so project .mcp.json is visible', async () => {
    const installPs1 = await readFile(installPs1Path, 'utf8');

    assert.match(installPs1, /\$projectRoot = 'D:\\workspace\\ai\\research\\xiheAi'/);
    assert.match(installPs1, /Push-Location \$projectRoot/);
    assert.match(installPs1, /finally\s*\{\s*Pop-Location\s*\}/);
  });

  test('sanitizes row-column cursor blank fill used by VSCode pwsh xterm', async () => {
    const blankFill = `before\x1b[2;1H${' '.repeat(200)}\x1b[Kafter`;
    const result = await runWrapper({
      env: {
        PTY_MOCK_EXIT_MS: '20',
        PTY_MOCK_DATA_EVENTS: JSON.stringify([{ data: blankFill }]),
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'before\x1b[2J\x1b[Hafter');
  });

  test('sanitizes vertical-absolute cursor blank fill with CRLF and line clear', async () => {
    const blankFill = `before\x1b[5d${' '.repeat(150)}\r\n\x1b[Kafter`;
    const result = await runWrapper({
      env: {
        PTY_MOCK_EXIT_MS: '20',
        PTY_MOCK_DATA_EVENTS: JSON.stringify([{ data: blankFill }]),
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'before\x1b[2J\x1b[Hafter');
  });

  test('keeps K.P CSI-H blank-fill regression covered', async () => {
    const blankFill = `before\x1b[H${' '.repeat(2040)}\r\n\x1b[K\x1b[120Cafter`;
    const result = await runWrapper({
      env: {
        PTY_MOCK_EXIT_MS: '20',
        PTY_MOCK_DATA_EVENTS: JSON.stringify([{ data: blankFill }]),
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'before\x1b[2J\x1b[Hafter');
  });

  test('IPC_HELPER_RAW_LOG appends raw PTY data before output sanitization', async () => {
    const rawLogPath = join(tempDir, 'raw-pty.log');
    const rawData = `raw-start\x1b[2;1H${' '.repeat(200)}\x1b[Kraw-end`;
    const result = await runWrapper({
      env: {
        IPC_HELPER_RAW_LOG: rawLogPath,
        PTY_MOCK_EXIT_MS: '20',
        PTY_MOCK_DATA_EVENTS: JSON.stringify([{ data: rawData }]),
      },
    });

    assert.equal(result.code, 0);
    assert.equal(await readFile(rawLogPath, 'utf8'), rawData);
    assert.equal(result.stdout, 'raw-start\x1b[2J\x1b[Hraw-end');
    assert.match(result.stderr, /\[claude-stdin-auto-accept\] raw PTY log enabled:/);
  });
});
