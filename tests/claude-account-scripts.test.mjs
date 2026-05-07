import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { TEMP_ROOT } from './helpers/temp-path.mjs';

const updateScript = new URL('../bin/update-claude-account-identity.ps1', import.meta.url).pathname.replace(/^\//, '');
const syncScript = new URL('../bin/sync-claude-account-vault.ps1', import.meta.url).pathname.replace(/^\//, '');

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

function tokenFingerprint(token) {
  return createHash('sha256').update(String(token).slice(-16)).digest('hex').slice(0, 16);
}

test('update-claude-account-identity captures profile user_id into vault and marker', async (t) => {
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
    xihe_identity: { which: 'b', captured_at: '2026-05-04T00:00:00.000Z' },
    keep_me: { nested: true },
  }), 'utf8');
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken: 'live-access', refreshToken: 'rotated-refresh', subscriptionType: 'max' },
    ignored_non_oauth: 'credentials-only',
  }), 'utf8');

  try {
    const result = await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'function Invoke-RestMethod { param($Method,$Uri,$Headers,$TimeoutSec) [pscustomobject]@{ account = [pscustomobject]@{ uuid = "user-b"; email = "b@example.test" }; organization = [pscustomobject]@{ uuid = "org-b" } } };',
      '&',
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
    ]);

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

    const rawVault = await readFile(vaultPath, 'utf8');
    const rawMarker = await readFile(markerPath, 'utf8');
    assert.equal(rawVault.charCodeAt(0), 123);
    assert.equal(rawMarker.charCodeAt(0), 123);

    const vault = parseJsonFile(rawVault);
    assert.equal(vault.claudeAiOauth.accessToken, 'live-access');
    assert.equal(vault.claudeAiOauth.refreshToken, 'rotated-refresh');
    assert.deepEqual(vault.keep_me, { nested: true });
    assert.equal(vault.ignored_non_oauth, undefined);
    assert.equal(vault.xihe_identity.which, 'b');
    assert.equal(vault.xihe_identity.user_id, 'user-b');
    assert.equal(vault.xihe_identity.email, 'b@example.test');
    assert.equal(vault.xihe_identity.org_id, 'org-b');

    const marker = parseJsonFile(rawMarker);
    assert.equal(marker.which, 'b');
    assert.equal(marker.fingerprint, tokenFingerprint('rotated-refresh'));
    assert.equal(marker.user_id, 'user-b');
    assert.match(marker.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('update-claude-account-identity falls back to fingerprint when profile capture fails', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell is required for account script behavior tests');
    return;
  }

  const root = join(TEMP_ROOT, `claude-account-fallback-${process.pid}-${Date.now()}`);
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
    claudeAiOauth: { accessToken: 'expired-access', refreshToken: '', subscriptionType: 'max' },
  }), 'utf8');

  try {
    const result = await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'function Invoke-RestMethod { throw "401 Unauthorized" };',
      '&',
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
    ]);

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

    const vault = parseJsonFile(await readFile(vaultPath, 'utf8'));
    const marker = parseJsonFile(await readFile(markerPath, 'utf8'));
    assert.equal(vault.claudeAiOauth.accessToken, 'expired-access');
    assert.equal(vault.claudeAiOauth.refreshToken, 'old-refresh');
    assert.equal(vault.xihe_identity.which, 'b');
    assert.equal(vault.xihe_identity.user_id, undefined);
    assert.equal(marker.which, 'b');
    assert.equal(marker.fingerprint, tokenFingerprint('old-refresh'));
    assert.equal(marker.user_id, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sync-claude-account-vault once refreshes vault and preserves marker user_id after token rotation', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell is required for account script behavior tests');
    return;
  }

  const root = join(TEMP_ROOT, `claude-account-sync-${process.pid}-${Date.now()}`);
  const claudeDir = join(root, '.claude');
  await mkdir(claudeDir, { recursive: true });
  const vaultPath = join(claudeDir, 'account-b.json');
  const credentialsPath = join(claudeDir, '.credentials.json');
  const markerPath = join(claudeDir, '.current-account');

  await writeFile(vaultPath, JSON.stringify({
    claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh', subscriptionType: 'max' },
    xihe_identity: { user_id: 'user-b', email: 'b@example.test', captured_at: '2026-05-04T00:00:00.000Z' },
    keep_me: { nested: true },
  }), 'utf8');
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh-60s', subscriptionType: 'max' },
  }), 'utf8');

  try {
    const result = await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'function Invoke-RestMethod { throw "network identity lookup must not be called when vault identity already exists" };',
      '&',
      syncScript,
      '-Which',
      'b',
      '-VaultPath',
      vaultPath,
      '-CredentialsPath',
      credentialsPath,
      '-MarkerPath',
      markerPath,
      '-InitialDelaySeconds',
      '0',
      '-IntervalSeconds',
      '1',
      '-Once',
    ]);

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

    const vault = parseJsonFile(await readFile(vaultPath, 'utf8'));
    const marker = parseJsonFile(await readFile(markerPath, 'utf8'));
    assert.equal(vault.claudeAiOauth.accessToken, 'rotated-access');
    assert.equal(vault.claudeAiOauth.refreshToken, 'rotated-refresh-60s');
    assert.equal(vault.xihe_identity.user_id, 'user-b');
    assert.equal(marker.which, 'b');
    assert.equal(marker.fingerprint, tokenFingerprint('rotated-refresh-60s'));
    assert.equal(marker.user_id, 'user-b');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
