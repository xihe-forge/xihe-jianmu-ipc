import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createStateMachine } from '../lib/network-state.mjs';
import { createHarnessStateMachine } from '../lib/harness-state.mjs';
import { probeHarnessHeartbeat } from '../lib/harness-heartbeat.mjs';
import {
  DEFAULT_CHECKPOINT_PATH,
  DEFAULT_HANDOVER_REPO_PATH,
  DEFAULT_LAST_BREATH_PATH,
  DEFAULT_STATUS_PATH,
  triggerHarnessSelfHandover,
} from '../lib/harness-handover.mjs';
import { createLineageTracker } from '../lib/lineage.mjs';
import { isLoopbackAddress, loadInternalToken } from '../lib/internal-auth.mjs';
import {
  probeAnthropic,
  probeCliProxy,
  probeDns,
  probeHub,
} from '../lib/network-probes.mjs';

export const DEFAULT_IPC_PORT = 3179;
export const DEFAULT_WATCHDOG_PORT = 3180;
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;
export const DEFAULT_WATCHDOG_COLD_START_GRACE_MS = 120_000;
export const WATCHDOG_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
export const WATCHDOG_HOST = '127.0.0.1';
export const WATCHDOG_SESSION_NAME = 'network-watchdog';
export const HARNESS_SESSION_NAME = 'harness';
export const HARNESS_HEARTBEAT_TOPIC = 'harness-heartbeat';
export const HARNESS_HEARTBEAT_PATTERN = /【harness\s+(.+?)\s+·\s+context-pct】(\d+)% \| state=(\w+) \| next_action=(\S+)/;
export const WATCHDOG_WS_RECONNECT_DELAY_MS = 3_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function createWait(waitImpl, setTimeoutImpl) {
  if (typeof waitImpl === 'function') {
    return waitImpl;
  }

  return (delayMs) => new Promise((resolveWait) => {
    setTimeoutImpl(resolveWait, delayMs);
  });
}

function isSuccessfulResponse(response) {
  return Number.isFinite(response?.status)
    && response.status >= 200
    && response.status < 300;
}

function toErrorMessage(error) {
  return error?.message ?? String(error);
}

function normalizeMaybeFunction(value) {
  return typeof value === 'function' ? value() : value;
}

function isHeldByColdStartGrace(reason) {
  return typeof reason === 'string' && reason.startsWith('held-by-grace');
}

function buildHubUrl(ipcPort) {
  return `http://127.0.0.1:${ipcPort}`;
}

function buildHubWsUrl({ ipcPort, sessionName, hubAuthToken }) {
  const url = new URL(`ws://127.0.0.1:${ipcPort}/ws`);
  url.searchParams.set('name', sessionName);
  if (typeof hubAuthToken === 'string' && hubAuthToken.trim() !== '') {
    url.searchParams.set('token', hubAuthToken);
  }
  return url.toString();
}

function mapHarnessTransitionToHandoverReason(reason) {
  if (reason === 'hard-signal' || reason === 'context-critical-no-action') {
    return 'threshold_65';
  }
  if (reason === 'warn-without-compact' || reason === 'context-warn') {
    return 'threshold_55';
  }
  if (reason === 'ws-down-grace-exceeded') {
    return 'crash_recovery';
  }
  return 'manual';
}

async function loadDefaultIpcSpawn() {
  const module = await import('../mcp-server.mjs');
  return module.spawnSession;
}

export function parseHarnessHeartbeatContent(content) {
  if (typeof content !== 'string') {
    return null;
  }

  const match = content.match(HARNESS_HEARTBEAT_PATTERN);
  if (!match) {
    return null;
  }

  const [, isoTs, pctText, state, nextAction] = match;
  const pct = Number.parseInt(pctText, 10);
  if (!Number.isFinite(pct)) {
    return null;
  }

  const parsedTs = Date.parse(isoTs);

  return {
    ts: Number.isNaN(parsedTs) ? Number.NaN : parsedTs,
    tsIso: isoTs,
    pct,
    state,
    nextAction,
  };
}

async function postInternalNetworkEvent({
  body,
  ipcPort,
  internalToken,
  fetchImpl,
  stderr,
  wait,
}) {
  const url = `${buildHubUrl(ipcPort)}/internal/network-event`;
  let lastError = null;

  for (let attempt = 0; attempt <= WATCHDOG_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': internalToken,
        },
        body: JSON.stringify(body),
      });

      if (isSuccessfulResponse(response)) {
        return true;
      }

      lastError = new Error(`HTTP ${response?.status ?? 'unknown'}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < WATCHDOG_RETRY_DELAYS_MS.length) {
      await wait(WATCHDOG_RETRY_DELAYS_MS[attempt]);
    }
  }

  stderr(
    `[network-watchdog] failed to POST /internal/network-event after ${WATCHDOG_RETRY_DELAYS_MS.length + 1} attempt(s): ${lastError?.message ?? lastError}`,
  );
  return false;
}

export function createDefaultWatchdogProbes({
  ipcPort = DEFAULT_IPC_PORT,
  harnessProbeConfig = {},
} = {}) {
  const nowImpl = harnessProbeConfig.now ?? Date.now;
  let lastSeenOnlineAt = normalizeMaybeFunction(harnessProbeConfig.lastSeenOnlineAt);
  if (!Number.isFinite(lastSeenOnlineAt)) {
    lastSeenOnlineAt = null;
  }

  const harnessProbe = () => probeHarnessHeartbeat({
    hubUrl: harnessProbeConfig.hubUrl ?? buildHubUrl(ipcPort),
    timeoutMs: harnessProbeConfig.timeoutMs,
    wsDisconnectGraceMs: harnessProbeConfig.wsDisconnectGraceMs ?? 60 * 1000,
    lastSeenOnlineAt,
    sessionName: harnessProbeConfig.sessionName,
    authToken: harnessProbeConfig.authToken ?? process.env.IPC_AUTH_TOKEN ?? null,
    fetchImpl: harnessProbeConfig.fetchImpl,
    now: nowImpl,
  });
  harnessProbe.onProbeResult = (result) => {
    if (result?.ok && result?.connected === true) {
      lastSeenOnlineAt = nowImpl();
    }
    if (typeof harnessProbeConfig.onProbeResult === 'function') {
      harnessProbeConfig.onProbeResult(result);
    }
  };

  return {
    cliProxy: () => probeCliProxy(),
    hub: () => probeHub({ port: ipcPort }),
    anthropic: () => probeAnthropic(),
    dns: () => probeDns(),
    harness: harnessProbe,
  };
}

export function createWatchdogIpcClient({
  ipcPort = DEFAULT_IPC_PORT,
  sessionName = WATCHDOG_SESSION_NAME,
  harnessSessionName = HARNESS_SESSION_NAME,
  harnessHeartbeatTopic = HARNESS_HEARTBEAT_TOPIC,
  hubAuthToken = process.env.IPC_AUTH_TOKEN ?? '',
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  wsImpl = WebSocket,
  onHarnessHeartbeat = null,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
} = {}) {
  let ws = null;
  let reconnectTimer = null;
  let stopped = false;

  function buildSendHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (typeof hubAuthToken === 'string' && hubAuthToken.trim() !== '') {
      headers.Authorization = `Bearer ${hubAuthToken}`;
    }
    return headers;
  }

  async function postSend(body, errorLabel) {
    try {
      const response = await fetchImpl(`${buildHubUrl(ipcPort)}/send`, {
        method: 'POST',
        headers: buildSendHeaders(),
        body: JSON.stringify(body),
      });
      return isSuccessfulResponse(response);
    } catch (error) {
      stderr(`[network-watchdog] ${errorLabel}: ${toErrorMessage(error)}`);
      return false;
    }
  }

  function handleInboundMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.topic === harnessHeartbeatTopic && typeof message.content === 'string') {
      const parsed = parseHarnessHeartbeatContent(message.content);
      if (parsed && typeof onHarnessHeartbeat === 'function') {
        onHarnessHeartbeat(parsed);
      }
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer != null) {
      return;
    }

    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, WATCHDOG_WS_RECONNECT_DELAY_MS);
  }

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message?.type === 'message') {
      handleInboundMessage(message);
      return;
    }

    if (message?.type === 'inbox' && Array.isArray(message.messages)) {
      for (const item of message.messages) {
        handleInboundMessage(item);
      }
    }
  }

  function connect() {
    if (stopped) {
      return;
    }

    let socket;
    try {
      socket = new wsImpl(buildHubWsUrl({ ipcPort, sessionName, hubAuthToken }));
    } catch (error) {
      stderr(`[network-watchdog] watchdog WS connect failed: ${toErrorMessage(error)}`);
      scheduleReconnect();
      return;
    }

    ws = socket;

    socket.on('open', () => {
      try {
        socket.send(JSON.stringify({ type: 'register', name: sessionName }));
        socket.send(JSON.stringify({ type: 'subscribe', topic: harnessHeartbeatTopic }));
      } catch (error) {
        stderr(`[network-watchdog] watchdog WS subscribe failed: ${toErrorMessage(error)}`);
      }
    });

    socket.on('message', handleMessage);
    socket.on('close', () => {
      if (ws === socket) {
        ws = null;
      }
      scheduleReconnect();
    });
    socket.on('error', (error) => {
      stderr(`[network-watchdog] watchdog WS error: ${toErrorMessage(error)}`);
    });
  }

  async function sendMessage({ to, topic = null, content } = {}) {
    return postSend({
      from: sessionName,
      to,
      ...(topic == null ? {} : { topic }),
      content,
    }, 'watchdog message send failed');
  }

  return {
    async start() {
      stopped = false;
      connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer != null) {
        clearTimeoutImpl(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
    },
    sendMessage,
  };
}

function omitHarnessProbe(probes) {
  return Object.fromEntries(
    Object.entries(probes).filter(([name]) => name !== 'harness'),
  );
}

export function createWatchdogStatusHandler({
  getSnapshot,
  getHarnessSnapshot = null,
  getUptime,
} = {}) {
  return function handleStatus(req, res) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const snapshot = getSnapshot();
      const harness = typeof getHarnessSnapshot === 'function'
        ? getHarnessSnapshot()
        : (snapshot?.harness ?? null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        state: snapshot.state,
        failing: [...snapshot.failing],
        lastChecks: snapshot.lastChecks,
        uptime: getUptime(),
        harness,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  };
}

export function createNetworkWatchdog({
  probes = null,
  ipcPort = DEFAULT_IPC_PORT,
  watchdogPort = DEFAULT_WATCHDOG_PORT,
  intervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
  internalToken,
  hubAuthToken = process.env.IPC_AUTH_TOKEN ?? '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  waitImpl,
  createStateMachineImpl = createStateMachine,
  createHarnessStateMachineImpl = createHarnessStateMachine,
  createWatchdogIpcClientImpl = createWatchdogIpcClient,
  createServerImpl = http.createServer,
  watchdogHost = WATCHDOG_HOST,
  watchdogSessionName = WATCHDOG_SESSION_NAME,
  harnessSessionName = HARNESS_SESSION_NAME,
  coldStartGraceMs = DEFAULT_WATCHDOG_COLD_START_GRACE_MS,
  harnessProbeConfig = {},
  onHarnessStateChange = null,
  triggerHarnessSelfHandoverImpl = null,
  handoverConfig = null,
  lineage = null,
  ipcSpawn = null,
} = {}) {
  if (typeof internalToken !== 'string' || internalToken.trim() === '') {
    throw new Error('internalToken is required');
  }

  let timer = null;
  let stopped = false;
  let started = false;
  let unhealthySince = null;
  let downSince = null;
  let startedAt = null;
  let currentWatchdogPort = watchdogPort;
  let statusServer = null;
  let lastHarnessProbe = null;
  let lastHandoverResult = null;
  let pendingHarnessHandover = null;
  const wait = createWait(waitImpl, setTimeoutImpl);
  const pendingTransitions = new Set();
  const resolvedProbes = probes ?? createDefaultWatchdogProbes({
    ipcPort,
    harnessProbeConfig: {
      ...harnessProbeConfig,
      hubUrl: harnessProbeConfig.hubUrl ?? buildHubUrl(ipcPort),
      fetchImpl: harnessProbeConfig.fetchImpl ?? fetchImpl,
      now: harnessProbeConfig.now ?? now,
      sessionName: harnessProbeConfig.sessionName ?? harnessSessionName,
      authToken: harnessProbeConfig.authToken ?? hubAuthToken,
      wsDisconnectGraceMs: harnessProbeConfig.wsDisconnectGraceMs ?? 60 * 1000,
    },
  });
  const networkProbes = omitHarnessProbe(resolvedProbes);
  const harnessProbe = typeof resolvedProbes.harness === 'function'
    ? resolvedProbes.harness
    : null;
  const canAutoHandover = typeof triggerHarnessSelfHandoverImpl === 'function'
    && lineage
    && typeof ipcSpawn === 'function'
    && handoverConfig
    && typeof handoverConfig === 'object';
  let resolvedHandoverIpcSend = handoverConfig?.ipcSend ?? null;

  function trackPending(promise) {
    pendingTransitions.add(promise);
    promise.finally(() => {
      pendingTransitions.delete(promise);
    });
    return promise;
  }

  function dispatchTransition(body) {
    return trackPending(postInternalNetworkEvent({
      body,
      ipcPort,
      internalToken,
      fetchImpl,
      stderr,
      wait,
    }));
  }

  const networkStateMachine = createStateMachineImpl({
    probes: networkProbes,
    now,
    onTransition: (transition) => {
      const eventTs = Number.isFinite(transition.ts) ? transition.ts : now();

      if (transition.to !== 'OK' && unhealthySince == null) {
        unhealthySince = eventTs;
      }

      if (transition.to === 'down') {
        if (unhealthySince == null) {
          unhealthySince = eventTs;
        }
        downSince = eventTs;
        void dispatchTransition({
          event: 'network-down',
          failing: transition.failing,
          since: unhealthySince,
          triggeredBy: 'watchdog',
          ts: eventTs,
        });
        return;
      }

      if (transition.from === 'down' && transition.to === 'OK') {
        const recoveredAfter = downSince == null ? 0 : Math.max(0, eventTs - downSince);
        unhealthySince = null;
        downSince = null;
        void dispatchTransition({
          event: 'network-up',
          recoveredAfter,
          triggeredBy: 'watchdog',
          ts: eventTs,
        });
        return;
      }

      if (transition.to === 'OK') {
        unhealthySince = null;
      }
    },
  });

  function buildHarnessSnapshot() {
    const snapshot = harnessStateMachine.getSnapshot();
    return {
      state: snapshot.state,
      contextWarnPct: snapshot.contextPct,
      nextAction: snapshot.nextAction,
      warnCount: snapshot.warnCount,
      lastTransition: snapshot.lastTransition,
      lastReason: snapshot.lastReason,
      lastProbe: lastHarnessProbe,
    };
  }

  const harnessStateMachine = createHarnessStateMachineImpl({
    now,
    coldStartGraceMs,
    onTransition: (transition) => {
      if (
        canAutoHandover
        && transition.to === 'down'
        && !isHeldByColdStartGrace(transition.reason)
        && pendingHarnessHandover == null
      ) {
        const promise = Promise.resolve()
          .then(() => triggerHarnessSelfHandoverImpl({
            ...handoverConfig,
            ipcSend: resolvedHandoverIpcSend,
            lineage,
            ipcSpawn,
            reason: mapHarnessTransitionToHandoverReason(transition.reason),
          }))
          .then((result) => {
            lastHandoverResult = result;
            return result;
          })
          .catch((error) => {
            lastHandoverResult = {
              triggered: false,
              error: toErrorMessage(error),
            };
            stderr(`[network-watchdog] harness handover failed: ${toErrorMessage(error)}`);
            return lastHandoverResult;
          })
          .finally(() => {
            pendingHarnessHandover = null;
          });
        pendingHarnessHandover = trackPending(promise);
      }

      if (
        typeof onHarnessStateChange === 'function'
        && transition.to === 'down'
      ) {
        onHarnessStateChange({
          state: transition.to,
          reason: transition.reason,
          context: {
            pct: transition.contextPct,
            nextAction: transition.nextAction,
          },
          snapshot: buildHarnessSnapshot(),
        });
      }
    },
  });

  const watchdogIpcClient = createWatchdogIpcClientImpl({
    ipcPort,
    sessionName: watchdogSessionName,
    harnessSessionName,
    hubAuthToken,
    fetchImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
    stderr,
    onHarnessHeartbeat: (heartbeat) => {
      harnessStateMachine.ingestHeartbeat(heartbeat);
    },
  });
  if (resolvedHandoverIpcSend == null && typeof watchdogIpcClient.sendMessage === 'function') {
    resolvedHandoverIpcSend = (message) => watchdogIpcClient.sendMessage(message);
  }

  function buildCompositeState() {
    const snapshot = networkStateMachine.getState();
    return {
      ...snapshot,
      harness: buildHarnessSnapshot(),
    };
  }

  async function runHarnessTick() {
    if (!harnessProbe) {
      return buildHarnessSnapshot();
    }

    let result;
    try {
      result = await harnessProbe();
    } catch (error) {
      result = { ok: false, error: toErrorMessage(error) };
    }

    if (typeof harnessProbe.onProbeResult === 'function') {
      harnessProbe.onProbeResult(result);
    }

    if (result?.ok && result?.connected === true) {
      harnessStateMachine.markAliveSignal('probe-ok');
    }

    lastHarnessProbe = {
      ...result,
      ts: now(),
    };
    harnessStateMachine.ingestProbeResult(result);
    return lastHarnessProbe;
  }

  function ingestHarnessHeartbeat(heartbeat) {
    if (!heartbeat || typeof heartbeat !== 'object') {
      return false;
    }
    harnessStateMachine.ingestHeartbeat(heartbeat);
    return true;
  }

  function ingestHarnessHeartbeatContent(content) {
    const parsed = parseHarnessHeartbeatContent(content);
    if (!parsed) {
      return false;
    }
    return ingestHarnessHeartbeat(parsed);
  }

  function scheduleNextTick() {
    if (stopped) {
      return;
    }

    timer = setTimeoutImpl(() => {
      void runTick({ scheduleNext: true });
    }, intervalMs);
  }

  async function runTick({ scheduleNext = false } = {}) {
    try {
      const [networkState] = await Promise.all([
        networkStateMachine.tick(),
        runHarnessTick(),
      ]);
      return {
        ...networkState,
        harness: buildHarnessSnapshot(),
      };
    } catch (error) {
      stderr(`[network-watchdog] tick failed: ${error?.message ?? error}`);
      return buildCompositeState();
    } finally {
      if (scheduleNext && !stopped) {
        scheduleNextTick();
      }
    }
  }

  async function waitForIdle() {
    if (pendingTransitions.size === 0) {
      return;
    }

    await Promise.allSettled([...pendingTransitions]);
  }

  async function start({ runImmediately = true } = {}) {
    if (started) {
      return controller;
    }

    started = true;
    stopped = false;
    startedAt = now();
    await watchdogIpcClient.start();

    if (!statusServer) {
      const statusHandler = createWatchdogStatusHandler({
        getSnapshot: buildCompositeState,
        getHarnessSnapshot: buildHarnessSnapshot,
        getUptime: () => (startedAt == null ? 0 : Math.max(0, now() - startedAt)),
      });
      statusServer = createServerImpl(statusHandler);
      await new Promise((resolveStart, rejectStart) => {
        const onError = (error) => {
          statusServer?.off('listening', onListening);
          rejectStart(error);
        };
        const onListening = () => {
          statusServer?.off('error', onError);
          const address = statusServer?.address();
          if (typeof address === 'object' && address) {
            currentWatchdogPort = address.port;
          }
          resolveStart();
        };

        statusServer.once('error', onError);
        statusServer.once('listening', onListening);
        statusServer.listen(watchdogPort, watchdogHost);
      });
    }

    if (runImmediately) {
      void runTick({ scheduleNext: true });
    }
    return controller;
  }

  async function stop() {
    if (!started) {
      return;
    }

    stopped = true;
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    await waitForIdle();
    await watchdogIpcClient.stop();
    if (statusServer) {
      const server = statusServer;
      statusServer = null;
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
    started = false;
  }

  const controller = {
    start,
    stop,
    runTick,
    waitForIdle,
    ingestHarnessHeartbeat,
    ingestHarnessHeartbeatContent,
    ingestHarnessHeartbeatMessage: ingestHarnessHeartbeatContent,
    getState: buildCompositeState,
    getHarnessState: buildHarnessSnapshot,
    getLastHandoverResult: () => lastHandoverResult,
    getConfig: () => ({
      ipcPort,
      watchdogPort: currentWatchdogPort,
      intervalMs,
    }),
  };

  return controller;
}

export function formatWatchdogHelp() {
  return [
    'Usage: node bin/network-watchdog.mjs',
    '',
    'Environment:',
    `  IPC_PORT=${DEFAULT_IPC_PORT}                 Hub HTTP port`,
    `  IPC_WATCHDOG_PORT=${DEFAULT_WATCHDOG_PORT}      Watchdog status port`,
    `  IPC_WATCHDOG_INTERVAL_MS=${DEFAULT_WATCHDOG_INTERVAL_MS}  Probe interval in milliseconds`,
    `  WATCHDOG_COLD_START_GRACE_MS=${DEFAULT_WATCHDOG_COLD_START_GRACE_MS}  Suppress harness self-handover until first alive signal`,
    '  IPC_INTERNAL_TOKEN=<token>          Shared internal auth token',
  ].join('\n');
}

export async function startWatchdog(options = {}) {
  const ipcPort = parsePort(options.ipcPort ?? process.env.IPC_PORT, DEFAULT_IPC_PORT);
  const watchdogPort = parsePort(options.watchdogPort ?? process.env.IPC_WATCHDOG_PORT, DEFAULT_WATCHDOG_PORT);
  const intervalMs = parsePort(options.intervalMs ?? process.env.IPC_WATCHDOG_INTERVAL_MS, DEFAULT_WATCHDOG_INTERVAL_MS);
  const coldStartGraceMs = parseNonNegativeInt(
    options.coldStartGraceMs ?? process.env.WATCHDOG_COLD_START_GRACE_MS,
    DEFAULT_WATCHDOG_COLD_START_GRACE_MS,
  );
  const internalToken = options.internalToken ?? await loadInternalToken({ rootDir: PROJECT_ROOT });
  const ipcSpawn = options.ipcSpawn ?? await loadDefaultIpcSpawn();
  const lineage = options.lineage ?? createLineageTracker({
    dbPath: process.env.IPC_DB_PATH || join(PROJECT_ROOT, 'data', 'messages.db'),
  });
  const baseHandoverConfig = options.handoverConfig ?? {};

  const watchdog = createNetworkWatchdog({
    ...options,
    ipcPort,
    watchdogPort,
    intervalMs,
    coldStartGraceMs,
    internalToken,
    ipcSpawn,
    lineage,
    triggerHarnessSelfHandoverImpl: options.triggerHarnessSelfHandoverImpl ?? triggerHarnessSelfHandover,
    handoverConfig: {
      checkpointPath: baseHandoverConfig.checkpointPath ?? DEFAULT_CHECKPOINT_PATH,
      lastBreathPath: baseHandoverConfig.lastBreathPath ?? DEFAULT_LAST_BREATH_PATH,
      statusPath: baseHandoverConfig.statusPath ?? DEFAULT_STATUS_PATH,
      handoverRepoPath: baseHandoverConfig.handoverRepoPath ?? DEFAULT_HANDOVER_REPO_PATH,
      ...baseHandoverConfig,
    },
  });

  await watchdog.start();
  return watchdog;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${formatWatchdogHelp()}\n`);
    return 0;
  }

  const watchdog = await startWatchdog();
  const shutdown = async (signal) => {
    process.stderr.write(`[network-watchdog] ${signal} received, shutting down\n`);
    await watchdog.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const exitCode = await main();
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (error) {
    process.stderr.write(`[network-watchdog] failed to start: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
