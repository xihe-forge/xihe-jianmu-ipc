/**
 * agent-status.mjs — Agent session status tracker for the IPC Hub
 *
 * Polls the Hub's HTTP API on a 15-second interval to maintain a live map of
 * all known AI agent sessions. Emits change events when agents go online or
 * offline. Also caches the most recent /health payload for uptime and message
 * count display.
 *
 * Usage:
 *   import { startTracking, getAllStatus, onStatusChange } from './lib/agent-status.mjs';
 *   startTracking();
 *   onStatusChange(({ name, online, prev }) => console.log(name, online));
 *
 * Env:
 *   IPC_HUB_HOST  — Hub hostname (default: 127.0.0.1)
 *   IPC_PORT      — Hub HTTP port  (default: 3179)
 */

const HUB_HOST = process.env.IPC_HUB_HOST || '127.0.0.1';
const HUB_PORT = process.env.IPC_PORT || '3179';

const POLL_INTERVAL = 15_000; // ms

/** @type {Map<string, { name: string, online: boolean, lastSeen: number|null, connectedAt: string|null, lastActivity: number|null }>} */
const statusMap = new Map();

/** @type {Set<function>} */
const changeListeners = new Set();

/** @type {{ uptime: number, messageCount: number, version: string }|null} */
let cachedHealth = null;

/** @type {ReturnType<typeof setInterval>|null} */
let pollTimer = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a Hub endpoint and return the parsed JSON body.
 * Returns null (never throws) if the Hub is unreachable.
 *
 * @param {string} path
 * @returns {Promise<any|null>}
 */
async function hubFetch(path) {
  const url = `http://${HUB_HOST}:${HUB_PORT}${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Emit a status-change event to all registered listeners.
 *
 * @param {{ name: string, online: boolean, prev: boolean|null }} change
 */
function emitChange(change) {
  for (const fn of changeListeners) {
    try { fn(change); } catch { /* listener errors must not break polling */ }
  }
}

/**
 * Run one poll cycle: fetch /sessions and /health, update statusMap, fire
 * change events for agents whose online flag flipped.
 */
async function poll() {
  const [sessions, health] = await Promise.all([
    hubFetch('/sessions'),
    hubFetch('/health'),
  ]);

  // Update cached health (keep stale data if hub unreachable)
  if (health) {
    cachedHealth = {
      uptime: health.uptime ?? 0,
      messageCount: health.messageCount ?? 0,
      version: health.version ?? '',
    };
  }

  const now = Date.now();

  if (sessions === null) {
    // Hub unreachable — mark every known online agent as offline
    for (const [name, entry] of statusMap) {
      if (entry.online) {
        const prev = entry.online;
        entry.online = false;
        emitChange({ name, online: false, prev });
      }
    }
    return;
  }

  // Build a set of currently-online names from the Hub response
  const onlineNames = new Set();
  for (const session of sessions) {
    if (typeof session.name !== 'string') continue;
    onlineNames.add(session.name);

    const existing = statusMap.get(session.name);
    if (!existing) {
      // New agent — create entry and emit "came online"
      statusMap.set(session.name, {
        name: session.name,
        online: true,
        lastSeen: now,
        connectedAt: session.connectedAt ?? null,
        lastActivity: null,
      });
      emitChange({ name: session.name, online: true, prev: null });
    } else if (!existing.online) {
      // Previously known agent that reconnected
      const prev = existing.online;
      existing.online = true;
      existing.lastSeen = now;
      existing.connectedAt = session.connectedAt ?? existing.connectedAt;
      emitChange({ name: session.name, online: true, prev });
    } else {
      // Still online — refresh lastSeen and connectedAt
      existing.lastSeen = now;
      existing.connectedAt = session.connectedAt ?? existing.connectedAt;
    }
  }

  // Any previously-online agent not in the current response has gone offline
  for (const [name, entry] of statusMap) {
    if (entry.online && !onlineNames.has(name)) {
      const prev = entry.online;
      entry.online = false;
      emitChange({ name, online: false, prev });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the 15-second polling interval. Safe to call multiple times — a
 * second call is a no-op if tracking is already running.
 */
export function startTracking() {
  if (pollTimer !== null) return;
  poll(); // fire immediately, then on interval
  pollTimer = setInterval(poll, POLL_INTERVAL);
  if (pollTimer.unref) pollTimer.unref(); // don't prevent process exit
}

/**
 * Stop the polling interval. The statusMap is preserved.
 */
export function stopTracking() {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * Get one agent's status record.
 *
 * @param {string} name
 * @returns {{ name: string, online: boolean, lastSeen: number|null, connectedAt: string|null, lastActivity: number|null }|undefined}
 */
export function getStatus(name) {
  return statusMap.get(name);
}

/**
 * Get all known agents sorted online-first, then by name.
 *
 * @returns {Array<{ name: string, online: boolean, lastSeen: number|null, connectedAt: string|null, lastActivity: number|null }>}
 */
export function getAllStatus() {
  return [...statusMap.values()].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Record that a message involving `name` was just routed.
 * Creates a stub entry for agents not yet seen by the poller.
 *
 * @param {string} name
 */
export function markActivity(name) {
  const entry = statusMap.get(name);
  if (entry) {
    entry.lastActivity = Date.now();
  } else {
    statusMap.set(name, {
      name,
      online: false,
      lastSeen: null,
      connectedAt: null,
      lastActivity: Date.now(),
    });
  }
}

/**
 * Register a listener that is called whenever an agent's online/offline
 * status changes.
 *
 * @param {(change: { name: string, online: boolean, prev: boolean|null }) => void} fn
 * @returns {() => void} Unsubscribe function
 */
export function onStatusChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/**
 * Return the most recently cached /health data from the Hub.
 * Returns null if the Hub has never been successfully reached.
 *
 * @returns {{ uptime: number, messageCount: number, version: string }|null}
 */
export function getHubHealth() {
  return cachedHealth;
}

// ---------------------------------------------------------------------------
// Format helpers (Feishu display)
// ---------------------------------------------------------------------------

/**
 * Format a timestamp as a Chinese relative-time string.
 * e.g. "3小时前", "5分钟前", "2天前", "刚刚"
 *
 * @param {number|null} ts — Unix ms timestamp, or null
 * @returns {string}
 */
function relativeTime(ts) {
  if (ts === null) return '从未';
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}天前`;
}

/**
 * Format a single agent's status as a one-line string suitable for Feishu.
 *
 * Online:  "🟢 openclaw — 在线 3小时"
 * Offline: "🔴 openclaw — 离线 (最后在线: 2小时前)"
 *
 * @param {{ name: string, online: boolean, lastSeen: number|null, connectedAt: string|null }} agent
 * @returns {string}
 */
export function formatStatusLine(agent) {
  if (agent.online) {
    // Show how long the agent has been connected
    let duration = '';
    if (agent.connectedAt) {
      const connectedMs = Date.now() - new Date(agent.connectedAt).getTime();
      const connectedMin = Math.floor(connectedMs / 60_000);
      if (connectedMin < 1) {
        duration = '刚连接';
      } else if (connectedMin < 60) {
        duration = `${connectedMin}分钟`;
      } else if (connectedMin < 1440) {
        duration = `${Math.floor(connectedMin / 60)}小时`;
      } else {
        duration = `${Math.floor(connectedMin / 1440)}天`;
      }
    }
    return `🟢 ${agent.name} — 在线${duration ? ' ' + duration : ''}`;
  } else {
    const lastOnline = agent.lastSeen !== null
      ? relativeTime(agent.lastSeen)
      : '从未';
    return `🔴 ${agent.name} — 离线 (最后在线: ${lastOnline})`;
  }
}

/**
 * Format a multi-line summary of all known agents, suitable for a Feishu card.
 * Includes Hub health stats when available.
 *
 * @returns {string}
 */
export function formatStatusSummary() {
  const agents = getAllStatus();
  const lines = [];

  const onlineCount = agents.filter(a => a.online).length;
  lines.push(`**Agent 状态** (${onlineCount}/${agents.length} 在线)`);
  lines.push('');

  if (agents.length === 0) {
    lines.push('暂无已知 Agent');
  } else {
    for (const agent of agents) {
      lines.push(formatStatusLine(agent));
    }
  }

  const health = getHubHealth();
  if (health) {
    lines.push('');
    const uptimeSec = Math.floor(health.uptime);
    let uptimeStr;
    if (uptimeSec < 60) {
      uptimeStr = `${uptimeSec}秒`;
    } else if (uptimeSec < 3600) {
      uptimeStr = `${Math.floor(uptimeSec / 60)}分钟`;
    } else if (uptimeSec < 86400) {
      uptimeStr = `${Math.floor(uptimeSec / 3600)}小时`;
    } else {
      uptimeStr = `${Math.floor(uptimeSec / 86400)}天`;
    }
    lines.push(`Hub 运行时长: ${uptimeStr} | 消息总数: ${health.messageCount}`);
    if (health.version) lines.push(`版本: ${health.version}`);
  }

  return lines.join('\n');
}
