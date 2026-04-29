import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const wrapperPath = join(projectRoot, 'bin', 'claude-stdin-auto-accept.mjs');

let tempDir;
let fixturePath;

const fixtureSource = String.raw`
const mode = process.argv[2];
let promptSent = false;
let promptSentAtFirstData = null;
let stdinEnded = false;
const chunks = [];

function emitReport(extra = {}) {
  process.stdout.write('@@REPORT@@' + JSON.stringify({
    data: chunks.join(''),
    promptSentAtFirstData,
    stdinEnded,
    ...extra,
  }) + '\n');
}

function maybeReportPromptCase() {
  if (!promptSent || chunks.join('') !== '1\n') return;
  setTimeout(() => {
    emitReport();
    process.exit(0);
  }, 10);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (promptSentAtFirstData === null) {
    promptSentAtFirstData = promptSent;
  }
  chunks.push(chunk);
  if (mode === 'stdout-prompt' || mode === 'stderr-prompt') {
    maybeReportPromptCase();
  }
  if (mode === 'timeout') {
    emitReport();
    process.exit(0);
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
});

if (mode === 'stdout-prompt') {
  setTimeout(() => {
    promptSent = true;
    process.stdout.write('I am using this for local development\n');
    maybeReportPromptCase();
  }, 80);
} else if (mode === 'stderr-prompt') {
  setTimeout(() => {
    promptSent = true;
    process.stderr.write('WARNING: Loading development channels\n');
    maybeReportPromptCase();
  }, 80);
} else if (mode === 'no-prompt') {
  process.stdout.write('ordinary child output\n');
  setTimeout(() => {
    emitReport();
    process.exit(0);
  }, 120);
} else if (mode === 'timeout') {
  setTimeout(() => {
    emitReport({ fallbackMissing: true });
    process.exit(1);
  }, 1000);
} else {
  process.stderr.write('unknown mode ' + mode + '\n');
  process.exit(2);
}
`;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claude-stdin-auto-accept-'));
  fixturePath = join(tempDir, 'mock-claude.mjs');
  await writeFile(fixturePath, fixtureSource, 'utf8');
});

after(async () => {
  if (tempDir) {
    await rm(tempDir, { force: true, recursive: true });
  }
});

function parseReport(stdout) {
  const lines = stdout.split(/\r?\n/);
  const line = lines.find((entry) => entry.startsWith('@@REPORT@@'));
  assert.ok(line, `missing fixture report in stdout:\n${stdout}`);
  return JSON.parse(line.slice('@@REPORT@@'.length));
}

async function runWrapper(mode, { env = {}, timeoutMs = 2500 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, process.execPath, fixturePath, mode], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`wrapper timeout for ${mode}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`wrapper exited by signal ${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr, report: parseReport(stdout) });
    });
  });
}

describe('ADR-014 Phase 2 K.K-1 stdin auto-accept expect behavior', () => {
  test('stdout prompt keyword writes 1 only after the prompt is observed', async () => {
    const result = await runWrapper('stdout-prompt');

    assert.equal(result.code, 0);
    assert.equal(result.report.data, '1\n');
    assert.equal(result.report.promptSentAtFirstData, true);
  });

  test('stderr warning keyword writes 1 only after the prompt is observed', async () => {
    const result = await runWrapper('stderr-prompt');

    assert.equal(result.code, 0);
    assert.equal(result.report.data, '1\n');
    assert.equal(result.report.promptSentAtFirstData, true);
  });

  test('stdout without prompt keywords does not write to child stdin', async () => {
    const result = await runWrapper('no-prompt');

    assert.equal(result.code, 0);
    assert.equal(result.report.data, '');
    assert.equal(result.report.promptSentAtFirstData, null);
  });

  test('timeout fallback force writes 1 and reports the 30s guardrail', async () => {
    const result = await runWrapper('timeout', {
      env: { CLAUDE_STDIN_AUTO_ACCEPT_TIMEOUT_MS: '50' },
    });

    assert.equal(result.code, 0);
    assert.equal(result.report.data, '1\n');
    assert.match(result.stderr, /timeout 30s no prompt detected/);
  });
});
