import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  createRegistryMaintainer,
  listRegistryTempFiles,
  loadSessionsRegistry,
  registerSessionEntry,
  updateSessionProjects,
} from '../lib/session-registry.mjs';

function createTempRegistryPath() {
  const dir = mkdtempSync(join(os.tmpdir(), 'ipc-registry-maintenance-'));
  return {
    dir,
    registryPath: join(dir, 'sessions-registry.json'),
  };
}

test('registerSessionEntry: 首次写入创建 registry 并原子落盘', () => {
  const { dir, registryPath } = createTempRegistryPath();

  try {
    const result = registerSessionEntry(
      {
        name: 'yuheng_builder',
        role: 'brand-director',
        projects: ['xihe-yuheng-brandbook', 'lumidrive-site'],
        access_scope: 'primary',
        cold_start_strategy: 'single-db-50',
        note: 'brand session',
      },
      {
        registryPath,
        updatedBy: 'jianmu-pm',
        nowIso: '2026-04-20T01:00:00+08:00',
      },
    );

    const registry = loadSessionsRegistry({ registryPath });

    assert.deepEqual(result, {
      ok: true,
      name: 'yuheng_builder',
      registered: true,
      action: 'created',
    });
    assert.equal(registry._last_updated, '2026-04-20T01:00:00+08:00');
    assert.equal(registry._last_updated_by, 'jianmu-pm');
    assert.deepEqual(registry.sessions.yuheng_builder, {
      role: 'brand-director',
      projects: ['xihe-yuheng-brandbook', 'lumidrive-site'],
      access_scope: 'primary',
      cold_start_strategy: 'single-db-50',
      note: 'brand session',
    });
    assert.deepEqual(listRegistryTempFiles({ registryPath }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerSessionEntry: 已存在 name 时按 merge 语义更新并保留未传字段', () => {
  const { dir, registryPath } = createTempRegistryPath();

  try {
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
          _schema_version: '1.0',
          _spec: 'spec',
          _last_updated: 'old',
          _last_updated_by: 'old-writer',
          _note: 'note',
          sessions: {
            'tech-worker': {
              role: 'diagnostician',
              projects: ['xihe-tianshu-harness'],
              access_scope: 'dynamic',
              cold_start_strategy: 'registered',
              note: 'old note',
            },
          },
          _project_slug_reference: {
            'xihe-tianshu-harness': 'Harness repo',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = registerSessionEntry(
      {
        name: 'tech-worker',
        projects: ['xihe-tianshu-harness', '_portfolio'],
        note: 'new note',
      },
      {
        registryPath,
        updatedBy: 'harness',
        nowIso: '2026-04-20T01:05:00+08:00',
      },
    );

    const registry = loadSessionsRegistry({ registryPath });

    assert.equal(result.action, 'updated');
    assert.deepEqual(registry.sessions['tech-worker'], {
      role: 'diagnostician',
      projects: ['xihe-tianshu-harness', '_portfolio'],
      access_scope: 'dynamic',
      cold_start_strategy: 'registered',
      note: 'new note',
    });
    assert.deepEqual(registry._project_slug_reference, {
      'xihe-tianshu-harness': 'Harness repo',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateSessionProjects: 只更新 projects，其他字段保留', () => {
  const { dir, registryPath } = createTempRegistryPath();

  try {
    registerSessionEntry(
      {
        name: 'tech-worker',
        role: 'diagnostician',
        projects: ['xihe-tianshu-harness'],
        access_scope: 'dynamic',
        cold_start_strategy: 'registered',
        note: 'keep me',
      },
      {
        registryPath,
        updatedBy: 'seed',
      },
    );

    const result = updateSessionProjects(
      {
        name: 'tech-worker',
        projects: ['_portfolio', 'xihe-jianmu-ipc'],
      },
      {
        registryPath,
        updatedBy: 'jianmu-pm',
        nowIso: '2026-04-20T01:10:00+08:00',
      },
    );

    const registry = loadSessionsRegistry({ registryPath });

    assert.deepEqual(result, {
      ok: true,
      name: 'tech-worker',
      projects: ['_portfolio', 'xihe-jianmu-ipc'],
      updated: true,
    });
    assert.deepEqual(registry.sessions['tech-worker'], {
      role: 'diagnostician',
      projects: ['_portfolio', 'xihe-jianmu-ipc'],
      access_scope: 'dynamic',
      cold_start_strategy: 'registered',
      note: 'keep me',
    });
    assert.equal(registry._last_updated_by, 'jianmu-pm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createRegistryMaintainer: Promise chain 序列化 register + update', async () => {
  const { dir, registryPath } = createTempRegistryPath();

  try {
    const maintainer = createRegistryMaintainer({ registryPath });

    const registerPromise = maintainer.registerSession(
      {
        name: 'test-session',
        role: 'worker',
        projects: ['alpha'],
        requested_by: 'jianmu-pm',
      },
      { nowIso: '2026-04-20T01:15:00+08:00' },
    );
    const updatePromise = maintainer.updateSessionProjects(
      {
        name: 'test-session',
        projects: ['beta'],
        requested_by: 'jianmu-pm',
      },
      { nowIso: '2026-04-20T01:16:00+08:00' },
    );

    const [registerResult, updateResult] = await Promise.all([registerPromise, updatePromise]);
    const registry = loadSessionsRegistry({ registryPath });

    assert.equal(registerResult.ok, true);
    assert.deepEqual(updateResult, {
      ok: true,
      name: 'test-session',
      projects: ['beta'],
      updated: true,
    });
    assert.deepEqual(registry.sessions['test-session'], {
      role: 'worker',
      projects: ['beta'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
