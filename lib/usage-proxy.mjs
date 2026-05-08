import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;

function emptyFailure(generatedAt, error = 'usage unavailable') {
  return {
    ok: false,
    five_hour: null,
    seven_day: null,
    generated_at: generatedAt,
    source: 'jianmu-failure',
    error,
  };
}

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const utilization = Number(window.utilization);
  return {
    utilization: Number.isFinite(utilization) ? utilization : null,
    resets_at: typeof window.resets_at === 'string' ? window.resets_at : null,
  };
}

function normalizeSuccess(data, generatedAt, source) {
  return {
    ok: true,
    five_hour: normalizeWindow(data?.five_hour),
    seven_day: normalizeWindow(data?.seven_day),
    generated_at: generatedAt,
    source,
  };
}

function cacheTtlFor(result) {
  return result?.ok === true ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
}

export function createUsageProxy({
  fetchImpl = globalThis.fetch,
  homeDir = homedir,
  now = Date.now,
  readFileImpl = readFile,
} = {}) {
  let cache = null;
  let inFlight = null;

  async function readAccessToken() {
    const credentialsPath = join(homeDir(), '.claude', '.credentials.json');
    const content = await readFileImpl(credentialsPath, 'utf8');
    const parsed = JSON.parse(content);
    const accessToken = parsed?.claudeAiOauth?.accessToken;
    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      return null;
    }
    return accessToken;
  }

  async function fetchFresh() {
    const generatedAt = new Date(now()).toISOString();
    try {
      const accessToken = await readAccessToken();
      if (!accessToken) {
        return emptyFailure(generatedAt, 'missing oauth access token');
      }

      if (typeof fetchImpl !== 'function') {
        return emptyFailure(generatedAt, 'fetch unavailable');
      }

      const response = await fetchImpl(USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'jianmu-ipc-usage-proxy/1.0',
        },
      });

      if (!response?.ok) {
        return emptyFailure(
          generatedAt,
          response?.status ? `http-${response.status}` : 'http-error',
        );
      }

      const data = await response.json();
      return normalizeSuccess(data, generatedAt, 'jianmu-fresh');
    } catch {
      return emptyFailure(generatedAt, 'usage fetch failed');
    }
  }

  async function getUsage() {
    const currentTime = now();
    if (cache && currentTime - cache.storedAt < cacheTtlFor(cache.result)) {
      if (cache.result.ok === true) {
        return { ...cache.result, source: 'jianmu-cache' };
      }
      return cache.result;
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = fetchFresh()
      .then((result) => {
        cache = { result, storedAt: now() };
        return result;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  function clearCache() {
    cache = null;
    inFlight = null;
  }

  return { getUsage, clearCache };
}

const defaultProxy = createUsageProxy();

export function getUsage() {
  return defaultProxy.getUsage();
}

export function clearUsageProxyCache() {
  defaultProxy.clearCache();
}

export function startUsageProxyPrewarm(intervalMs = 240_000, options = {}) {
  const getUsageImpl = options.getUsage ?? (() => defaultProxy.getUsage());

  async function warm() {
    try {
      await getUsageImpl();
    } catch {
      /* prewarm must not crash the hub */
    }
  }

  void warm();
  const interval = setInterval(() => {
    void warm();
  }, intervalMs);
  interval.unref?.();

  return {
    stop() {
      clearInterval(interval);
    },
  };
}
