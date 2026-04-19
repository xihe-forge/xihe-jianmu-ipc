import { basename, dirname, join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { getSessionsRegistryPath } from './claude-paths.mjs';

const DEFAULT_SCHEMA_VERSION = '1.0';
const DEFAULT_SPEC = 'xihe-tianshu-harness/docs/adr/005-project-centric-observation-storage.md';
const DEFAULT_NOTE = '员工登记表 · session name → role + projects 映射';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) {
    return [];
  }

  return [
    ...new Set(
      projects
        .filter((project) => typeof project === 'string')
        .map((project) => project.trim())
        .filter(Boolean),
    ),
  ];
}

function resolveNowIso(nowIso = null) {
  if (typeof nowIso === 'function') {
    return resolveNowIso(nowIso());
  }
  if (typeof nowIso === 'string' && nowIso.trim() !== '') {
    return nowIso.trim();
  }
  return new Date().toISOString();
}

function getDefaultRegistry() {
  return {
    _schema_version: DEFAULT_SCHEMA_VERSION,
    _spec: DEFAULT_SPEC,
    _last_updated: null,
    _last_updated_by: null,
    _note: DEFAULT_NOTE,
    sessions: {},
  };
}

function normalizeRegistryPayload(payload) {
  const registry =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload }
      : getDefaultRegistry();

  registry._schema_version = normalizeString(registry._schema_version) || DEFAULT_SCHEMA_VERSION;
  registry._spec = normalizeString(registry._spec) || DEFAULT_SPEC;
  registry._note = normalizeString(registry._note) || DEFAULT_NOTE;
  registry._last_updated =
    typeof registry._last_updated === 'string' && registry._last_updated.trim() !== ''
      ? registry._last_updated.trim()
      : null;
  registry._last_updated_by =
    typeof registry._last_updated_by === 'string' && registry._last_updated_by.trim() !== ''
      ? registry._last_updated_by.trim()
      : null;
  registry.sessions =
    registry.sessions && typeof registry.sessions === 'object' && !Array.isArray(registry.sessions)
      ? registry.sessions
      : {};

  return registry;
}

export function loadSessionsRegistry({ registryPath = null, homeDir = null } = {}) {
  const resolvedRegistryPath = registryPath || getSessionsRegistryPath({ homeDir });
  if (!existsSync(resolvedRegistryPath)) {
    return normalizeRegistryPayload(null);
  }

  const raw = JSON.parse(readFileSync(resolvedRegistryPath, 'utf8'));
  return normalizeRegistryPayload(raw);
}

export function writeSessionsRegistryAtomic(
  registry,
  { registryPath = null, homeDir = null } = {},
) {
  const resolvedRegistryPath = registryPath || getSessionsRegistryPath({ homeDir });
  const resolvedRegistry = normalizeRegistryPayload(registry);
  const targetDir = dirname(resolvedRegistryPath);
  const tempPath = join(
    targetDir,
    `${basename(resolvedRegistryPath)}.tmp-${process.pid}-${Date.now()}`,
  );

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(resolvedRegistry, null, 2)}\n`, 'utf8');
  renameSync(tempPath, resolvedRegistryPath);

  return resolvedRegistryPath;
}

function applyOptionalString(target, key, value) {
  if (value === undefined) {
    return;
  }

  const normalized = normalizeString(value);
  target[key] = normalized || null;
}

export function registerSessionEntry(input = {}, options = {}) {
  const name = normalizeString(input.name);
  if (!name) {
    throw new TypeError('name is required');
  }
  if (input.projects !== undefined && !Array.isArray(input.projects)) {
    throw new TypeError('projects must be an array of strings');
  }

  const registry = loadSessionsRegistry(options);
  const existing = registry.sessions[name];
  const nextRecord = existing ? { ...existing } : {};

  applyOptionalString(nextRecord, 'role', input.role);
  if (input.projects !== undefined) {
    nextRecord.projects = normalizeProjects(input.projects);
  } else if (!Array.isArray(nextRecord.projects)) {
    nextRecord.projects = [];
  }
  applyOptionalString(nextRecord, 'access_scope', input.access_scope);
  applyOptionalString(nextRecord, 'cold_start_strategy', input.cold_start_strategy);
  applyOptionalString(nextRecord, 'note', input.note);

  registry.sessions[name] = nextRecord;
  registry._last_updated = resolveNowIso(options.nowIso);
  registry._last_updated_by = normalizeString(options.updatedBy) || 'unknown';

  writeSessionsRegistryAtomic(registry, options);

  return {
    ok: true,
    name,
    registered: true,
    action: existing ? 'updated' : 'created',
  };
}

export function updateSessionProjects(input = {}, options = {}) {
  const name = normalizeString(input.name);
  if (!name) {
    throw new TypeError('name is required');
  }
  if (!Array.isArray(input.projects)) {
    throw new TypeError('projects must be an array of strings');
  }

  const registry = loadSessionsRegistry(options);
  const existing = registry.sessions[name];
  if (!existing) {
    return {
      ok: false,
      error: 'session not found',
      name,
    };
  }

  const projects = normalizeProjects(input.projects);
  registry.sessions[name] = {
    ...existing,
    projects,
  };
  registry._last_updated = resolveNowIso(options.nowIso);
  registry._last_updated_by = normalizeString(options.updatedBy) || 'unknown';

  writeSessionsRegistryAtomic(registry, options);

  return {
    ok: true,
    name,
    projects,
    updated: true,
  };
}

export function listRegistryTempFiles({ registryPath = null, homeDir = null } = {}) {
  const resolvedRegistryPath = registryPath || getSessionsRegistryPath({ homeDir });
  const targetDir = dirname(resolvedRegistryPath);
  if (!existsSync(targetDir)) {
    return [];
  }

  const prefix = `${basename(resolvedRegistryPath)}.tmp-`;
  return readdirSync(targetDir).filter((entry) => entry.startsWith(prefix));
}

export function createRegistryMaintainer(options = {}) {
  const registryPath =
    options.registryPath || getSessionsRegistryPath({ homeDir: options.homeDir });
  let writeChain = Promise.resolve();

  function enqueue(work) {
    const run = writeChain.then(work, work);
    writeChain = run.catch(() => {});
    return run;
  }

  return {
    registryPath,
    registerSession(input = {}, extra = {}) {
      return enqueue(() =>
        registerSessionEntry(input, {
          registryPath,
          nowIso: extra.nowIso ?? options.nowIso,
          updatedBy: extra.updatedBy ?? input.requested_by ?? 'unknown',
        }),
      );
    },
    updateSessionProjects(input = {}, extra = {}) {
      return enqueue(() =>
        updateSessionProjects(input, {
          registryPath,
          nowIso: extra.nowIso ?? options.nowIso,
          updatedBy: extra.updatedBy ?? input.requested_by ?? 'unknown',
        }),
      );
    },
  };
}
