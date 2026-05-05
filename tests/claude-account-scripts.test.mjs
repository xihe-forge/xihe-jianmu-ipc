import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { TEMP_ROOT } from './helpers/temp-path.mjs';

const updateScript = new URL('../bin/update-claude-account-identity.ps1', import.meta.url).pathname.replace(/^\//, '');

function parseJsonFile(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withProfileServer(fn) {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer live-access');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      account: { uuid: 'user-b', email: 'b@example.test' },
      organization: { uuid: 'org-1' },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/profile`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('update-claude-account-identity syncs only OAuth fields and captures user_id', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell is required for account script behavior tests');
    return;
  }

  const root = join(TEMP_ROOT, `claude-account-scripts-${process.pid}-${Date.now()}`);
  const claudeDir = join(root, '.claude');
  await mkdir(claudeDir, { recursive: true });
  const vaultPath = join(claudeDir, 'account-b.json');
  const credentialsPath = join(claudeDir, '.credentials.json');
  const markerPath = join(claudeDir, '.current-account');

  await writeFile(vaultPath, JSON.stringify({
    claudeAiOauth: { accessToken: 'dead-access', refreshToken: 'old-refresh', subscriptionType: 'max' },
    keep_me: { nested: true },
  }), 'utf8');
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken: 'live-access', refreshToken: 'rotated-refresh', subscriptionType: 'max' },
    ignored_non_oauth: 'credentials-only',
  }), 'utf8');

  try {
    await withProfileServer(async (profileEndpoint) => {
      const result = await runPowerShell([
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        updateScript,
        '-Which',
        'b',
        '-VaultPath',
        vaultPath,
        '-CredentialsPath',
        credentialsPath,
        '-MarkerPath',
        markerPath,
        '-SyncOauthFromCredentials',
        '-ProfileEndpoint',
        profileEndpoint,
      ]);

      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    });

    const vault = parseJsonFile(await readFile(vaultPath, 'utf8'));
    assert.equal(vault.claudeAiOauth.accessToken, 'live-access');
    assert.equal(vault.claudeAiOauth.refreshToken, 'rotated-refresh');
    assert.deepEqual(vault.keep_me, { nested: true });
    assert.equal(vault.ignored_non_oauth, undefined);
    assert.equal(vault.xihe_identity.user_id, 'user-b');
    assert.equal(vault.xihe_identity.email, 'b@example.test');

    const marker = parseJsonFile(await readFile(markerPath, 'utf8'));
    assert.equal(marker.which, 'b');
    assert.equal(marker.user_id, 'user-b');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
