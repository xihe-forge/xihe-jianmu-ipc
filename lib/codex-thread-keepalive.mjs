import { EventEmitter } from 'node:events';

export const DEFAULT_THREAD_KEEPALIVE_INTERVAL_MS = 25 * 60 * 1000;

function callSink(sink, message) {
  if (typeof sink !== 'function') return;
  try {
    sink(message);
  } catch {}
}

function callAudit(audit, event, data) {
  if (typeof audit !== 'function') return;
  try {
    audit(event, data);
  } catch {}
}

function getNotificationThreadId(message) {
  const params = message?.params ?? {};
  return params.threadId ?? params.thread?.id ?? null;
}

function getStatusType(result) {
  const status = result?.thread?.status ?? result?.status ?? null;
  if (typeof status === 'string') return status;
  return status?.type ?? null;
}

class ThreadKeepalive extends EventEmitter {
  constructor({
    client,
    threadId,
    sessionName,
    intervalMs = DEFAULT_THREAD_KEEPALIVE_INTERVAL_MS,
    stderr = null,
    audit = null,
  }) {
    super();
    if (!client || typeof client !== 'object') {
      throw new TypeError('createThreadKeepalive requires a client object');
    }
    if (!threadId) {
      throw new TypeError('createThreadKeepalive requires threadId');
    }
    this.client = client;
    this.threadId = threadId;
    this.sessionName = sessionName ?? '(unknown)';
    this.intervalMs = intervalMs;
    this.stderr = stderr;
    this.audit = audit;
    this.timer = null;
    this.inFlight = false;
    this.closedEmitted = false;
    this.notificationHandler = (message) => this.handleNotification(message);
  }

  start() {
    if (this.timer) return this;
    this.closedEmitted = false;
    if (typeof this.client.on === 'function') {
      this.client.on('notification', this.notificationHandler);
    }
    this.timer = setInterval(() => {
      void this.ping();
    }, this.intervalMs);
    this.timer.unref?.();
    callAudit(this.audit, 'codex_thread_keepalive_start', {
      sessionName: this.sessionName,
      threadId: this.threadId,
      intervalMs: this.intervalMs,
    });
    return this;
  }

  stop(reason = 'manual') {
    const wasAlive = this.isAlive();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof this.client.off === 'function') {
      this.client.off('notification', this.notificationHandler);
    }
    callAudit(this.audit, 'codex_thread_keepalive_stop', {
      sessionName: this.sessionName,
      threadId: this.threadId,
      reason,
      wasAlive,
    });
    return {
      stopped: true,
      wasAlive,
      sessionName: this.sessionName,
      threadId: this.threadId,
      reason,
    };
  }

  isAlive() {
    return Boolean(this.timer);
  }

  async ping() {
    if (!this.isAlive() || this.inFlight) return null;
    this.inFlight = true;
    let method = 'unknown';
    try {
      let result;
      if (typeof this.client.threadRead === 'function') {
        method = 'thread/read';
        result = await this.client.threadRead(this.threadId);
      } else if (typeof this.client.threadStatus === 'function') {
        method = 'thread/status';
        result = await this.client.threadStatus(this.threadId);
      } else {
        throw new Error('codex app-server client lacks threadRead/threadStatus');
      }
      callAudit(this.audit, 'codex_thread_keepalive_ping_ok', {
        sessionName: this.sessionName,
        threadId: this.threadId,
        method,
      });
      if (getStatusType(result) === 'closed') {
        this.handleClosed({ reason: 'status-closed', method });
      }
      return result;
    } catch (error) {
      this.handleClosed({ reason: 'ping-error', method, error });
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  handleNotification(message) {
    if (message?.method !== 'thread/closed') return;
    if (getNotificationThreadId(message) !== this.threadId) return;
    this.handleClosed({ reason: 'notification', notification: message });
  }

  handleClosed({ reason, method = null, error = null, notification = null } = {}) {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.stop(reason ?? 'closed');
    const event = {
      sessionName: this.sessionName,
      threadId: this.threadId,
      reason: reason ?? 'closed',
      method,
      error,
      notification,
    };
    callAudit(this.audit, 'codex_thread_keepalive_closed', {
      sessionName: this.sessionName,
      threadId: this.threadId,
      reason: event.reason,
      method,
      error: error?.message ?? null,
    });
    callSink(
      this.stderr,
      `[ipc] codex thread keepalive stopped for "${this.sessionName}" thread=${this.threadId} reason=${event.reason}\n`,
    );
    this.emit('closed', event);
  }
}

export function createThreadKeepalive(options) {
  return new ThreadKeepalive(options);
}
