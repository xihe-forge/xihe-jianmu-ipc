export const SESSION_NAME_PATTERN = /^[a-z0-9_-]+$/;
export const PID_SESSION_NAME_PATTERN = /^session-(\d+)$/;

export function normalizeSessionName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function extractPidFromSessionName(value) {
  const name = normalizeSessionName(value);
  const match = name.match(PID_SESSION_NAME_PATTERN);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isPidSessionName(value) {
  return extractPidFromSessionName(value) !== null;
}

export function allowsTransientDebugName(env = process.env) {
  return (
    env?.IPC_ALLOW_TRANSIENT_DEBUG_NAME === '1' ||
    env?.IPC_ALLOW_TRANSIENT_DEBUG === '1' ||
    env?.IPC_ALLOW_PID_SESSION_NAME === '1'
  );
}

export function validateSessionName(value, { allowPid = false } = {}) {
  const name = normalizeSessionName(value);
  if (!name) {
    return { ok: false, error: 'name is required' };
  }

  if (!SESSION_NAME_PATTERN.test(name)) {
    return { ok: false, error: 'session name must match [a-z0-9_-]+' };
  }

  if (!allowPid && isPidSessionName(name)) {
    return { ok: false, error: 'PID-based session names are not allowed' };
  }

  return { ok: true, name };
}

export function validateSessionNameForHub(value, { env = process.env } = {}) {
  return validateSessionName(value, { allowPid: allowsTransientDebugName(env) });
}
