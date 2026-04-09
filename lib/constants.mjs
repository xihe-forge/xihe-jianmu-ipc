/** Default port for the IPC hub WebSocket server */
export const DEFAULT_PORT = 3179;

/** Hub bind address — defaults to loopback; set IPC_HUB_BIND=0.0.0.0 to expose on all interfaces */
export const DEFAULT_HOST = process.env.IPC_HUB_BIND || '127.0.0.1';

/** Interval between heartbeat pings (ms) */
export const HEARTBEAT_INTERVAL = 30000;

/** Time to wait for pong before terminating client (ms) */
export const HEARTBEAT_TIMEOUT = 10000;

/** Maximum number of messages to buffer in a session's offline inbox */
export const INBOX_MAX_SIZE = 50;

/** Time-to-live for inbox messages after session disconnects (ms) — 5 minutes */
export const INBOX_TTL = 300000;

/** Delay before auto-shutdown when no sessions are connected (ms) — disabled (0 = never) */
export const IDLE_SHUTDOWN_DELAY = 0;

/** Timeout for hub autostart to become ready (ms) */
export const HUB_AUTOSTART_TIMEOUT = 3000;

/** Retry interval when polling for hub readiness after autostart (ms) */
export const HUB_AUTOSTART_RETRY_INTERVAL = 500;
