import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { stopHub, startHub, httpRequest, TEST_TIMEOUT } from '../helpers/hub-fixture.mjs';
import { getSessionsRegistryPath } from '../../lib/claude-paths.mjs';

let hub = null;
let homeDir = null;

beforeEach(async () => {
  homeDir = mkdtempSync(join(os.tmpdir(), 'ipc-registry-api-'));
  hub = await startHub({
    prefix: 'registry-api',
    env: {
      USERPROFILE: homeDir,
      HOME: homeDir,
    },
  });
});

afterEach(async () => {
  await stopHub(hub);
  hub = null;
  if (homeDir) {
    rmSync(homeDir, { recursive: true, force: true });
    homeDir = null;
  }
});

function readRegistryFile() {
  const registryPath = getSessionsRegistryPath({ homeDir });
  return existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : null;
}

test(
  'POST /registry/register: 创建 registry entry 并刷新 _last_updated_by',
  { timeout: TEST_TIMEOUT },
  async () => {
    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/registry/register',
      json: {
        name: 'test-session',
        role: 'worker',
        projects: ['alpha'],
        access_scope: 'primary',
        requested_by: 'jianmu-pm',
      },
    });

    const registry = readRegistryFile();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      name: 'test-session',
      registered: true,
      action: 'created',
    });
    assert.equal(registry._last_updated_by, 'jianmu-pm');
    assert.deepEqual(registry.sessions['test-session'], {
      role: 'worker',
      projects: ['alpha'],
      access_scope: 'primary',
    });
  },
);

test(
  'POST /registry/update: 仅替换 projects，未知 session 返回 404',
  { timeout: TEST_TIMEOUT },
  async () => {
    await httpRequest(hub.port, {
      method: 'POST',
      path: '/registry/register',
      json: {
        name: 'test-session',
        role: 'worker',
        projects: ['alpha'],
        note: 'keep me',
        requested_by: 'seed',
      },
    });

    const updateResponse = await httpRequest(hub.port, {
      method: 'POST',
      path: '/registry/update',
      json: {
        name: 'test-session',
        projects: ['beta', '_portfolio'],
        requested_by: 'jianmu-pm',
      },
    });
    const missingResponse = await httpRequest(hub.port, {
      method: 'POST',
      path: '/registry/update',
      json: {
        name: 'missing-session',
        projects: ['alpha'],
        requested_by: 'jianmu-pm',
      },
    });
    const registry = readRegistryFile();

    assert.equal(updateResponse.statusCode, 200);
    assert.deepEqual(updateResponse.body, {
      ok: true,
      name: 'test-session',
      projects: ['beta', '_portfolio'],
      updated: true,
    });
    assert.deepEqual(registry.sessions['test-session'], {
      role: 'worker',
      projects: ['beta', '_portfolio'],
      note: 'keep me',
    });
    assert.equal(missingResponse.statusCode, 404);
    assert.deepEqual(missingResponse.body, {
      ok: false,
      error: 'session not found',
      name: 'missing-session',
    });
  },
);
