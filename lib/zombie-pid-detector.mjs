import { audit } from './audit.mjs';

export const ZOMBIE_PID_TICK_INTERVAL_MS_DEFAULT = 15 * 60 * 1000;
export const ZOMBIE_PID_COOLDOWN_MS_DEFAULT = 30 * 60 * 1000;

function normalizeSessionsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  if (payload?.values && typeof payload.values === 'function') return [...payload.values()];
  return [];
}

export function isPidAlive(pid, killImpl = process.kill) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return true;
  }
}

export function createZombiePidDetector({
  getSessions,
  isPidAlive: isPidAliveImpl = isPidAlive,
  postReclaim,
  now = Date.now,
  cooldownMs = ZOMBIE_PID_COOLDOWN_MS_DEFAULT,
  dryRun = true,
  stderr = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (typeof getSessions !== 'function') {
    throw new Error('getSessions is required');
  }
  if (typeof isPidAliveImpl !== 'function') {
    throw new Error('isPidAlive is required');
  }
  if (typeof postReclaim !== 'function') {
    throw new Error('postReclaim is required');
  }

  const recentlyEvicted = new Map();

  async function tick() {
    const results = { scanned: 0, dead: 0, evicted: 0, dryRun: [] };
    const sessions = normalizeSessionsPayload(await getSessions());
    const ts = now();

    for (const session of sessions) {
      results.scanned += 1;
      if (!session || typeof session.pid !== 'number') continue;
      if (isPidAliveImpl(session.pid)) continue;
      results.dead += 1;

      const name = typeof session.name === 'string' ? session.name : '';
      if (!name) continue;

      const lastAt = recentlyEvicted.get(name);
      if (Number.isFinite(lastAt) && ts - lastAt < cooldownMs) continue;

      audit('zombie_pid_detected', {
        name,
        pid: session.pid,
        cwd: session.cwd ?? null,
        dryRun,
      });

      if (dryRun) {
        results.dryRun.push({ name, pid: session.pid });
        recentlyEvicted.set(name, ts);
        stderr(`[zombie-pid-detector] DRY-RUN would evict ${name} pid=${session.pid}`);
        continue;
      }

      const reclaimResult = await postReclaim(name);
      if (reclaimResult?.ok) {
        results.evicted += 1;
        recentlyEvicted.set(name, ts);
        stderr(`[zombie-pid-detector] evicted ${name} pid=${session.pid}`);
      } else {
        stderr(
          `[zombie-pid-detector] reclaim failed for ${name}: ${reclaimResult?.reason ?? 'unknown'}`,
        );
      }
    }

    return results;
  }

  return { tick };
}
