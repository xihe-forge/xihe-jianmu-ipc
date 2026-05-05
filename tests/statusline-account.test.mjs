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

  const accountA = { claudeAiOauth: { refreshToken: 'refresh-token-account-a', accessToken: 'access-a', subscriptionType: 'max' } };
  const accountB = { claudeAiOauth: { refreshToken: 'refresh-token-account-b', accessToken: 'access-b', subscriptionType: 'max' } };

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

    assert.equal(resolveAccount({ claudeDir }), 'b');
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

    assert.equal(resolveAccount({ claudeDir }), 'a');
  });
});

test('statusline fallback resolves missing marker by matching credentials to vault fingerprint', async () => {
  await withAccountFixture(async ({ claudeDir, accountB }) => {
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify(accountB), 'utf8');

    assert.equal(resolveAccount({ claudeDir }), 'b');
  });
});
