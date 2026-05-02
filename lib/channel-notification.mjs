export function createChannelNotifier({ serverNotify, stderr, now, trace = () => {}, initTimeoutMs = 5000 }) {
  const state = {
    mcpInitialized: false,
    pendingChannelPayloads: [],
  };

  // Fallback: if server.oninitialized never fires (e.g. Claude Code 2.1.119 binary bug where
  // handshake never completes), force flush after a short timeout so queued notifications
  // are not stuck forever. Safe because even if race happens, SDK drops pre-init notifications
  // same as before — this just means we don't lose ALL notifications when handshake never completes.
  if (typeof setTimeout === 'function' && initTimeoutMs > 0) {
    const timer = setTimeout(() => {
      if (!state.mcpInitialized) {
        trace('mcp_initialized_timeout_fallback', { queued_count: state.pendingChannelPayloads.length, timeout_ms: initTimeoutMs });
        stderr(`[ipc] MCP initialized fallback after ${initTimeoutMs}ms (handshake not received), flushing ${state.pendingChannelPayloads.length} queued\n`);
        markInitialized();
      }
    }, initTimeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function buildChannelPayload(msg) {
    const from = msg.from || 'unknown';
    const topic = msg.topic ? ` [${msg.topic}]` : '';
    const time = now().toLocaleString('zh-CN', { hour12: false });
    const body = msg.content || JSON.stringify(msg);
    const content = `[${time} from: ${from}${topic}]\n${body}`;
    return {
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          from: msg.from || 'unknown',
          message_id: msg.id || '',
          topic: msg.topic || '',
        },
      },
    };
  }

  function sendChannelPayloadNow(payload) {
    trace('channel_notification_send_attempt', {
      msg_id: payload.params?.meta?.message_id,
      method: payload.method,
    });

    let notificationPromise;
    try {
      notificationPromise = Promise.resolve(serverNotify(payload));
    } catch (err) {
      notificationPromise = Promise.reject(err);
    }

    return notificationPromise.then(() => {
      trace('channel_notification_send_ok', {
        msg_id: payload.params?.meta?.message_id,
        method: payload.method,
      });
    }).catch((err) => {
      trace('channel_notification_send_fail', {
        msg_id: payload.params?.meta?.message_id,
        method: payload.method,
        err_message: err?.message ?? String(err),
      });
      stderr(`[ipc] failed to push channel notification: ${err?.message ?? err}\n`);
      throw err;
    });
  }

  function pushChannelNotification(msg) {
    const payload = buildChannelPayload(msg);
    if (!state.mcpInitialized) {
      const queued = {};
      queued.payload = payload;
      queued.promise = new Promise((resolve, reject) => {
        queued.resolve = resolve;
        queued.reject = reject;
      });
      state.pendingChannelPayloads.push(queued);
      stderr(`[ipc] queued channel notification (pre-init window), queued=${state.pendingChannelPayloads.length}\n`);
      return queued.promise;
    }
    return sendChannelPayloadNow(payload);
  }

  function markInitialized() {
    if (state.mcpInitialized) return;
    state.mcpInitialized = true;
    const flushCount = state.pendingChannelPayloads.length;
    trace('mcp_initialized_flush_begin', { queued_count: flushCount });
    stderr(`[ipc] MCP initialized, flushing ${flushCount} queued channel notification(s)\n`);
    while (state.pendingChannelPayloads.length > 0) {
      const queued = state.pendingChannelPayloads.shift();
      const payload = queued.payload;
      trace('channel_notification_flushed', {
        msg_id: payload.params?.meta?.message_id,
      });
      sendChannelPayloadNow(payload).then(queued.resolve, queued.reject);
    }
  }

  function isInitialized() {
    return state.mcpInitialized;
  }

  return {
    pushChannelNotification,
    markInitialized,
    isInitialized,
    _state: state,
  };
}
