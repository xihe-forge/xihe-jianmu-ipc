import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getInternalTokenPath, loadInternalToken } from '../lib/internal-auth.mjs';

function createTempRoot() {
  return mkdtempSync(join(tmpdir(), 'ipc-internal-auth-'));
}

test('loadInternalToken: env 优先于文件', async () => {
  const rootDir = createTempRoot();

  try {
    const tokenPath = getInternalTokenPath({ rootDir });
    writeFileSync(tokenPath, 'token-from-file', 'utf8');

    const token = await loadInternalToken({
      rootDir,
      env: { IPC_INTERNAL_TOKEN: 'token-from-env' },
    });

    assert.equal(token, 'token-from-env');
    assert.equal(readFileSync(tokenPath, 'utf8'), 'token-from-file');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('loadInternalToken: env 缺失时读取 .ipc-internal-token', async () => {
  const rootDir = createTempRoot();

  try {
    const tokenPath = getInternalTokenPath({ rootDir });
    writeFileSync(tokenPath, 'persisted-token', 'utf8');

    const token = await loadInternalToken({
      rootDir,
      env: {},
    });

    assert.equal(token, 'persisted-token');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('loadInternalToken: env 和文件都缺失时生成 token 并写盘', async () => {
  const rootDir = createTempRoot();

  try {
    const token = await loadInternalToken({
      rootDir,
      env: {},
      randomUUIDImpl: () => 'generated-token',
    });
    const tokenPath = getInternalTokenPath({ rootDir });

    assert.equal(token, 'generated-token');
    assert.equal(readFileSync(tokenPath, 'utf8'), 'generated-token');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
