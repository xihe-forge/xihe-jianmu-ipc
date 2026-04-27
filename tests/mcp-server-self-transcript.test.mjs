import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { findSelfTranscriptPath } from '../mcp-server.mjs';

const windowsOnly = process.platform !== 'win32' ? 'requires Windows CreationTimeUtc control' : false;

function encodeClaudeProjectPath(cwd) {
  return cwd.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-');
}

function makeFixture() {
  const homeDir = mkdtempSync(join(tmpdir(), 'mcp-self-home-'));
  const cwd = join(homeDir, 'workspace', 'project');
  const projectDir = join(homeDir, '.claude', 'projects', encodeClaudeProjectPath(cwd));
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(homeDir, '.claude', 'sessions'), { recursive: true });
  const env = { USERPROFILE: homeDir, HOME: homeDir, IPC_NAME: 'jianmu-pm' };
  return { homeDir, cwd, projectDir, env };
}

function transcriptPath(projectDir, sessionId) {
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(filePath, `${JSON.stringify({ sessionId })}\n`);
  return filePath;
}

function setBirthtime(filePath, timestampMs) {
  const iso = new Date(timestampMs).toISOString();
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '& { param($Path, $Timestamp) $item = Get-Item -LiteralPath $Path; $item.CreationTimeUtc = [DateTime]::Parse($Timestamp).ToUniversalTime() }',
      filePath,
      iso,
    ],
    { stdio: 'ignore' },
  );
}

function cachePath(homeDir, ppid = process.ppid, ipcName = 'jianmu-pm') {
  return join(homeDir, '.claude', 'mcp-server-cache', `parent-${ppid}-${ipcName}.json`);
}

describe('AC-MCP-SELF-TRANSCRIPT-001 self transcript 识别 + 缓存', { skip: windowsOnly }, () => {
  test('AC-MCP-SELF-TRANSCRIPT-001-a: birthtime 60s 内识别为 self', () => {
    const fixture = makeFixture();
    try {
      const now = 1_777_275_600_000;
      const oldPath = transcriptPath(fixture.projectDir, 'old-session');
      const selfPath = transcriptPath(fixture.projectDir, 'self-session');
      setBirthtime(oldPath, now - 60 * 60 * 1000);
      setBirthtime(selfPath, now - 5_000);
      utimesSync(oldPath, new Date(now + 10_000), new Date(now + 10_000));
      utimesSync(selfPath, new Date(now), new Date(now));

      const found = findSelfTranscriptPath({ cwd: fixture.cwd, homeDir: fixture.homeDir, env: fixture.env, now: () => now });

      assert.equal(found, selfPath);
    } finally {
      rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  test('AC-MCP-SELF-TRANSCRIPT-001-b: 多个候选取 birthtime 最近的', () => {
    const fixture = makeFixture();
    try {
      const now = 1_777_275_600_000;
      const olderPath = transcriptPath(fixture.projectDir, 'candidate-30s');
      const oldestPath = transcriptPath(fixture.projectDir, 'candidate-50s');
      const newestPath = transcriptPath(fixture.projectDir, 'candidate-10s');
      setBirthtime(olderPath, now - 30_000);
      setBirthtime(oldestPath, now - 50_000);
      setBirthtime(newestPath, now - 10_000);
      utimesSync(olderPath, new Date(now + 10_000), new Date(now + 10_000));
      utimesSync(oldestPath, new Date(now), new Date(now));
      utimesSync(newestPath, new Date(now - 10_000), new Date(now - 10_000));

      const found = findSelfTranscriptPath({ cwd: fixture.cwd, homeDir: fixture.homeDir, env: fixture.env, now: () => now });

      assert.equal(found, newestPath);
    } finally {
      rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  test('AC-MCP-SELF-TRANSCRIPT-001-c: birthtime > 60s 全部老旧 → 返 null', () => {
    const fixture = makeFixture();
    try {
      const now = 1_777_275_600_000;
      const stalePath = transcriptPath(fixture.projectDir, 'stale-session');
      setBirthtime(stalePath, now - 60 * 60 * 1000);

      const found = findSelfTranscriptPath({ cwd: fixture.cwd, homeDir: fixture.homeDir, env: fixture.env, now: () => now });

      assert.equal(found, null);
    } finally {
      rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  test('AC-MCP-SELF-TRANSCRIPT-001-d: cache 持久化 + 跨 respawn 复用', () => {
    const fixture = makeFixture();
    try {
      const now = 1_777_275_600_000;
      const selfPath = transcriptPath(fixture.projectDir, 'self-session');
      setBirthtime(selfPath, now - 5_000);

      const first = findSelfTranscriptPath({ cwd: fixture.cwd, homeDir: fixture.homeDir, env: fixture.env, now: () => now });
      assert.equal(first, selfPath);
      assert.ok(existsSync(cachePath(fixture.homeDir)));

      rmSync(fixture.projectDir, { recursive: true, force: true });
      const cached = JSON.parse(readFileSync(cachePath(fixture.homeDir), 'utf8'));
      mkdirSync(fixture.projectDir, { recursive: true });
      writeFileSync(cached.transcriptPath, 'cached still exists\n');
      const second = findSelfTranscriptPath({ cwd: fixture.cwd, homeDir: fixture.homeDir, env: fixture.env, now: () => now + 60 * 60 * 1000 });

      assert.equal(second, selfPath);
    } finally {
      rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  test('AC-MCP-SELF-TRANSCRIPT-001-e: cache file invalid 时回退 detect', () => {
    const fixture = makeFixture();
    try {
      const now = 1_777_275_600_000;
      mkdirSync(join(fixture.homeDir, '.claude', 'mcp-server-cache'), { recursive: true });
      writeFileSync(cachePath(fixture.homeDir), JSON.stringify({ transcriptPath: join(fixture.projectDir, 'missing.jsonl') }));
      const selfPath = transcriptPath(fixture.projectDir, 'self-session');
      setBirthtime(selfPath, now - 5_000);

      const found = findSelfTranscriptPath({ cwd: fixture.cwd, homeDir: fixture.homeDir, env: fixture.env, now: () => now });

      assert.equal(found, selfPath);
      assert.equal(JSON.parse(readFileSync(cachePath(fixture.homeDir), 'utf8')).sessionId, basename(selfPath, '.jsonl'));
    } finally {
      rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });
});
