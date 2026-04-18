import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateMachine } from '../lib/network-state.mjs';
import { loadInternalToken } from '../lib/internal-auth.mjs';
import {
  probeAnthropic,
  probeCliProxy,
  probeDns,
  probeHub,
} from '../lib/network-probes.mjs';

export const DEFAULT_IPC_PORT = 3179;
export const DEFAULT_WATCHDOG_PORT = 3180;
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;
export const WATCHDOG_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

async function postInternalNetworkEvent({
  body,
  ipcPort,
  internalToken,
  fetchImpl,
  stderr,
  wait,
}) {
  const url = `http://127.0.0.1:${ipcPort}/internal/network-event`;
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

export function createDefaultWatchdogProbes({ ipcPort = DEFAULT_IPC_PORT } = {}) {
  return {
    cliProxy: () => probeCliProxy(),
    hub: () => probeHub({ port: ipcPort }),
    anthropic: () => probeAnthropic(),
    dns: () => probeDns(),
  };
}

export function createNetworkWatchdog({
  probes = createDefaultWatchdogProbes(),
  ipcPort = DEFAULT_IPC_PORT,
  watchdogPort = DEFAULT_WATCHDOG_PORT,
  intervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
  internalToken,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  stderr = (...args) => process.stderr.write(`${args.join(' ')}\n`),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  waitImpl,
  createStateMachineImpl = createStateMachine,
} = {}) {
  if (typeof internalToken !== 'string' || internalToken.trim() === '') {
    throw new Error('internalToken is required');
  }

  let timer = null;
  let stopped = false;
  let unhealthySince = null;
  let downSince = null;
  const wait = createWait(waitImpl, setTimeoutImpl);
  const pendingTransitions = new Set();

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

  const stateMachine = createStateMachineImpl({
    probes,
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
      return await stateMachine.tick();
    } catch (error) {
      stderr(`[network-watchdog] tick failed: ${error?.message ?? error}`);
      return stateMachine.getState();
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

  function start() {
    stopped = false;
    void runTick({ scheduleNext: true });
    return controller;
  }

  async function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    await waitForIdle();
  }

  const controller = {
    start,
    stop,
    runTick,
    waitForIdle,
    getState: () => stateMachine.getState(),
    getConfig: () => ({
      ipcPort,
      watchdogPort,
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
    '  IPC_INTERNAL_TOKEN=<token>          Shared internal auth token',
  ].join('\n');
}

export async function startWatchdog(options = {}) {
  const ipcPort = parsePort(options.ipcPort ?? process.env.IPC_PORT, DEFAULT_IPC_PORT);
  const watchdogPort = parsePort(options.watchdogPort ?? process.env.IPC_WATCHDOG_PORT, DEFAULT_WATCHDOG_PORT);
  const intervalMs = parsePort(options.intervalMs ?? process.env.IPC_WATCHDOG_INTERVAL_MS, DEFAULT_WATCHDOG_INTERVAL_MS);
  const internalToken = options.internalToken ?? await loadInternalToken({ rootDir: PROJECT_ROOT });

  const watchdog = createNetworkWatchdog({
    ...options,
    probes: options.probes ?? createDefaultWatchdogProbes({ ipcPort }),
    ipcPort,
    watchdogPort,
    intervalMs,
    internalToken,
  });

  watchdog.start();
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
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
