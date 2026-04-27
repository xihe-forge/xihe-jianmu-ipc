import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATUSLINE_SCRIPT = 'C:\\Users\\jolen\\.claude\\statusline-account.mjs';

function runStatusline({ stdin, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STATUSLINE_SCRIPT], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(stdin ?? {}));
  });
}

function withMockHub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.writeHead(204);
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        resolve(await handler(requests, `http://127.0.0.1:${port}/session/context`));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

function makeEnv(homeDir, name = 'harness', contextPushUrl = undefined) {
  return {
    IPC_NAME: name,
    AI_AGENT: 'claude-code/test/harness',
    CLAUDE_PROJECT_DIR: 'D:/workspace/ai/research/xiheAi',
    ...(contextPushUrl ? { STATUSLINE_CONTEXT_PUSH_URL: contextPushUrl } : {}),
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
}

const stdin = {
  session_id: 'session-123',
  transcript_path: 'D:/tmp/transcript.jsonl',
  model: { id: 'claude-opus-4-1' },
  cost: { total_cost_usd: 1.23 },
  context_window: { used_percentage: 42 },
  rate_limits: {
    five_hour: { used_percentage: 71, resets_at: 1777300000 },
    seven_day: { used_percentage: 81, resets_at: 1777900000 },
  },
};

test('statusline-account: fire-and-forget pushes context truth with IPC_NAME and bonus fields', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'statusline-push-'));
  try {
    await withMockHub(async (requests, contextPushUrl) => {
      const result = await runStatusline({ stdin, env: makeEnv(homeDir, 'harness', contextPushUrl) });
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(result.code, 0);
      assert.match(result.stdout, /\x1b\[/);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].url, '/session/context');
      assert.deepEqual(requests[0].body, {
        name: 'harness',
        session_id: stdin.session_id,
        transcript_path: stdin.transcript_path,
        model: stdin.model,
        cost: stdin.cost,
        context_window: stdin.context_window,
        rate_limits: stdin.rate_limits,
        ai_agent: 'claude-code/test/harness',
        claude_project_dir: 'D:/workspace/ai/research/xiheAi',
        ts: requests[0].body.ts,
      });
      assert.equal(typeof requests[0].body.ts, 'number');
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('statusline-account: 5s cooldown persists across processes without blocking stdout', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'statusline-cooldown-'));
  try {
    await withMockHub(async (requests, contextPushUrl) => {
      const env = makeEnv(homeDir, 'auditor-portfolio', contextPushUrl);
      const first = await runStatusline({ stdin, env });
      const second = await runStatusline({ stdin, env });
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(first.code, 0);
      assert.equal(second.code, 0);
      assert.notEqual(first.stdout, '');
      assert.notEqual(second.stdout, '');
      assert.equal(requests.length, 1);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('statusline-account: missing Hub never throws and preserves rendered output', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'statusline-nohub-'));
  try {
    const result = await runStatusline({ stdin, env: makeEnv(homeDir, 'no-hub') });
    assert.equal(result.code, 0);
    assert.notEqual(result.stdout, '');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
