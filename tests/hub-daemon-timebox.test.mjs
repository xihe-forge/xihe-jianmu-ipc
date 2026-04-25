import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const VBS_PATH = resolve(PROJECT_ROOT, 'bin/hub-daemon.vbs');
const LOG_PATH = resolve(PROJECT_ROOT, 'data/hub.log');

describe('AC-DAEMON-001 hub-daemon.vbs 时间盒', () => {
  test('AC-DAEMON-001-a: vbs 文件不含 Do / Loop 无限循环关键字', async () => {
    const content = await readFile(VBS_PATH, 'utf8');
    const lines = content.split(/\r?\n/);
    const violations = lines
      .map((line, idx) => ({ idx: idx + 1, line, trimmed: line.trim() }))
      .filter(({ trimmed }) => !trimmed.startsWith("'"))
      .filter(({ trimmed }) => /^Do\s*$/.test(trimmed) || /^Loop\s*$/.test(trimmed));

    assert.equal(
      violations.length,
      0,
      `vbs 仍含 Do/Loop 无限循环：${JSON.stringify(violations)}`,
    );
  });

  test('AC-DAEMON-001-b: cscript 跑 vbs 30s 内 exit code 0 自然退出', async () => {
    const result = await runVbsWithTimeout(30_000);
    assert.equal(result.exitCode, 0, `非 0 退出：stderr=${result.stderr}`);
    assert.ok(result.elapsedMs < 30_000, `跑超 30s：${result.elapsedMs}ms`);
  });

  test('AC-DAEMON-001-c: data/hub.log 末行含 "[housekeeping] <ISO-ts> OK" 格式', async () => {
    await runVbsWithTimeout(30_000);
    const log = await readFile(LOG_PATH, 'utf8');
    const lines = log.trim().split(/\r?\n/);
    const lastLine = lines[lines.length - 1];

    assert.match(lastLine, /\[housekeeping\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} OK/);
  });

  test('AC-DAEMON-001-d: vbs 严守 feedback_no_kill_node · 不含 taskkill node.exe', async () => {
    const content = await readFile(VBS_PATH, 'utf8');

    assert.ok(
      !/taskkill[^\n]*\/im\s+node\.exe/i.test(content),
      'vbs 含 taskkill /im node.exe 致命模式',
    );
  });
});

function runVbsWithTimeout(timeoutMs) {
  return new Promise(async (resolveRun) => {
    await mkdir(resolve(PROJECT_ROOT, 'data'), { recursive: true }).catch(() => {});
    const start = Date.now();
    const child = spawn('cscript.exe', ['//B', '//Nologo', VBS_PATH], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveRun({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n[TEST_TIMEOUT_KILL]`,
        elapsedMs: timeoutMs,
      });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code ?? -1, stdout, stderr, elapsedMs: Date.now() - start });
    });
  });
}
