import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

    assert.equal(await resolveAccount({ claudeDir, fetchProfileIdentity: async () => null }), 'b');
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

    assert.equal(await resolveAccount({ claudeDir, fetchProfileIdentity: async () => null }), 'a');
  });
});

test('statusline fallback resolves missing marker by matching credentials to vault fingerprint', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');

    assert.equal(await resolveAccount({ claudeDir, fetchProfileIdentity: async () => null }), 'b');
  });
});

test('statusline parses BOM-prefixed vault JSON for local fallback', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');
    await writeFile(join(claudeDir, '.creds-vault', 'account-b.json'), `\uFEFF${JSON.stringify(accountB)}`, 'utf8');

    assert.equal(await resolveAccount({ claudeDir, fetchProfileIdentity: async () => null }), 'b');
  });
});

test('statusline fallback resolves missing refresh token by matching access token to vault', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: accountB.claudeAiOauth.accessToken, subscriptionType: 'max' } }),
      'utf8',
    );

    assert.equal(await resolveAccount({ claudeDir, fetchProfileIdentity: async () => null }), 'b');
  });
});

test('statusline trusts marker user_id when profile identity matches', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          refreshToken: 'rotated-refresh-token-b',
          accessToken: 'rotated-access-b',
          subscriptionType: 'max',
        },
      }),
      'utf8',
    );
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', user_id: 'user-b', fingerprint: accountFingerprint(accountB) }),
      'utf8',
    );

    const which = await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => ({ user_id: 'user-b', email: 'b@example.test' }),
    });

    assert.equal(which, 'b');
  });
});

test('statusline captures user_id into legacy marker before fingerprint fallback', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          refreshToken: 'rotated-refresh-token-b',
          accessToken: 'rotated-access-b',
          subscriptionType: 'max',
        },
      }),
      'utf8',
    );
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', fingerprint: accountFingerprint(accountB), captured_at: '2026-05-05T10:00:00.000Z' }),
      'utf8',
    );

    const which = await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => ({ user_id: 'user-b', email: 'b@example.test' }),
      now: () => Date.parse('2026-05-07T08:30:00.000Z'),
    });

    const marker = JSON.parse(await readFile(join(claudeDir, '.current-account'), 'utf8'));
    assert.equal(which, 'b');
    assert.equal(marker.which, 'b');
    assert.equal(marker.user_id, 'user-b');
    assert.equal(marker.fingerprint, accountFingerprint(accountB));
  });
});

test('statusline falls through null profile identity to local fallbacks', async () => {
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

    const which = await resolveAccount({ claudeDir, fetchProfileIdentity: async () => null });
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

    assert.equal(await resolveAccount({ claudeDir, fetchProfileIdentity: async () => null }), null);
  });
});

test('statusline follows current profile identity when marker user_id is stale', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', user_id: 'user-b', captured_at: '2026-05-05T10:00:00.000Z' }),
      'utf8',
    );

    assert.equal(await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => ({ user_id: 'user-a', email: 'a@example.test' }),
    }), 'a');
  });
});
