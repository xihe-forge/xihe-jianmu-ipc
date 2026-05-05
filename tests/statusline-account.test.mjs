import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEMP_ROOT } from './helpers/temp-path.mjs';
import {
  accountFingerprint,
  resolveAccount,
} from '../bin/statusline-account.mjs';

async function withAccountFixture(fn) {
  const home = join(TEMP_ROOT, `statusline-account-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const claudeDir = join(home, '.claude');
  const vaultDir = join(claudeDir, '.creds-vault');
  await mkdir(vaultDir, { recursive: true });

  const accountA = {
    claudeAiOauth: { refreshToken: 'refresh-token-account-a', accessToken: 'access-a', subscriptionType: 'max' },
    xihe_identity: { user_id: 'user-a', email: 'a@example.test', account_label: 'a' },
  };
  const accountB = {
    claudeAiOauth: { refreshToken: 'refresh-token-account-b', accessToken: 'access-b', subscriptionType: 'max' },
    xihe_identity: { user_id: 'user-b', email: 'b@example.test', account_label: 'b' },
  };

  await writeFile(join(vaultDir, 'account-a.json'), JSON.stringify(accountA), 'utf8');
  await writeFile(join(vaultDir, 'account-b.json'), JSON.stringify(accountB), 'utf8');

  try {
    return await fn({ home, claudeDir, accountA, accountB });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('statusline trusts marker when refresh-token fingerprint matches current credentials', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', fingerprint: accountFingerprint(accountB) }),
      'utf8',
    );

    assert.equal(await resolveAccount({ claudeDir }), 'b');
  });
});

test('statusline ignores stale marker when fingerprint mismatches current credentials', async () => {
  await withAccountFixture(async ({ claudeDir, accountA, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountA), 'utf8');
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', fingerprint: accountFingerprint(accountB) }),
      'utf8',
    );

    assert.equal(await resolveAccount({ claudeDir }), 'a');
  });
});

test('statusline fallback resolves missing marker by matching credentials to vault fingerprint', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');

    assert.equal(await resolveAccount({ claudeDir }), 'b');
  });
});

test('statusline fallback resolves missing refresh token by matching access token to vault', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: accountB.claudeAiOauth.accessToken, subscriptionType: 'max' } }),
      'utf8',
    );

    assert.equal(await resolveAccount({ claudeDir }), 'b');
  });
});

test('statusline never calls network identity lookup and falls through stale marker user_id to subscription fallback', async () => {
  await withAccountFixture(async ({ claudeDir }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'unknown-refresh-token', accessToken: 'access-b-live', subscriptionType: 'pro' } }),
      'utf8',
    );
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', user_id: 'user-b', captured_at: '2026-05-05T10:00:00.000Z' }),
      'utf8',
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network identity lookup must not be called');
    };
    let which;
    try {
      which = await resolveAccount({ claudeDir });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(which, 'b');
  });
});

test('statusline returns null when marker, vault fingerprints, and subscription fallback all fail', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'unknown-refresh-token', accessToken: 'unknown-access', subscriptionType: 'team' } }),
      'utf8',
    );
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', fingerprint: accountFingerprint(accountB) }),
      'utf8',
    );

    assert.equal(await resolveAccount({ claudeDir }), null);
  });
});

test('statusline falls back gracefully from stale user_id marker', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', user_id: 'user-b', captured_at: '2026-05-05T10:00:00.000Z' }),
      'utf8',
    );

    assert.equal(await resolveAccount({ claudeDir }), 'b');
  });
});
