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

    assert.equal(await resolveAccount({ claudeDir, fetchProfileIdentity: async () => null }), 'a');
  });
});

test('statusline fallback resolves missing marker by matching credentials to vault fingerprint', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');

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

test('statusline verifies marker user_id via profile API and survives rotated refresh token', async () => {
  await withAccountFixture(async ({ claudeDir }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'rotated-refresh-token', accessToken: 'access-b-live', subscriptionType: 'max' } }),
      'utf8',
    );
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', user_id: 'user-b', captured_at: '2026-05-05T10:00:00.000Z' }),
      'utf8',
    );

    let calls = 0;
    const which = await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => {
        calls += 1;
        return { user_id: 'user-b', email: 'b@example.test' };
      },
      now: () => 1_776_000_000_000,
    });

    assert.equal(which, 'b');
    assert.equal(calls, 1);
  });
});

test('statusline user_id cache avoids profile API until access token prefix changes', async () => {
  await withAccountFixture(async ({ claudeDir }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-cache-token-one', refreshToken: 'rotated-1', subscriptionType: 'max' } }),
      'utf8',
    );
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', user_id: 'user-b', captured_at: '2026-05-05T10:00:00.000Z' }),
      'utf8',
    );

    let calls = 0;
    const first = await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => {
        calls += 1;
        return { user_id: 'user-b', email: 'b@example.test' };
      },
      now: () => 1_776_000_000_000,
    });
    const second = await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => {
        calls += 1;
        return { user_id: 'user-b', email: 'b@example.test' };
      },
      now: () => 1_776_000_001_000,
    });

    assert.equal(first, 'b');
    assert.equal(second, 'b');
    assert.equal(calls, 1);

    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-token-two', refreshToken: 'rotated-2', subscriptionType: 'max' } }),
      'utf8',
    );
    const third = await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => {
        calls += 1;
        return { user_id: 'user-b', email: 'b@example.test' };
      },
      now: () => 1_776_000_002_000,
    });

    assert.equal(third, 'b');
    assert.equal(calls, 2);

    const cache = JSON.parse(await readFile(join(claudeDir, '.statusline-user-id-cache.json'), 'utf8'));
    assert.equal(cache.user_id, 'user-b');
    assert.equal(cache.access_token_prefix_16, 'sk-ant-oat01-tok');
  });
});

test('statusline resolves missing marker by profile API user_id matched to vault', async () => {
  await withAccountFixture(async ({ claudeDir }) => {
    await writeFile(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'rotated-refresh-token', accessToken: 'access-a-live', subscriptionType: 'max' } }),
      'utf8',
    );

    assert.equal(await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => ({ user_id: 'user-a', email: 'a@example.test' }),
      now: () => 1_776_000_000_000,
    }), 'a');
  });
});

test('statusline falls back gracefully when profile API is unavailable', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');
    await writeFile(
      join(claudeDir, '.current-account'),
      JSON.stringify({ which: 'b', user_id: 'user-b', captured_at: '2026-05-05T10:00:00.000Z' }),
      'utf8',
    );

    assert.equal(await resolveAccount({
      claudeDir,
      fetchProfileIdentity: async () => null,
      now: () => 1_776_000_000_000,
    }), 'b');
  });
});
