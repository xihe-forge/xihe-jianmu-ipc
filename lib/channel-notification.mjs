export function createChannelNotifier({ serverNotify, stderr, now, trace = () => {} }) {
  const state = {
    mcpInitialized: false,
    pendingChannelPayloads: [],
  };

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

    notificationPromise.then(() => {
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
    });
  }

  function pushChannelNotification(msg) {
    const payload = buildChannelPayload(msg);
    if (!state.mcpInitialized) {
      state.pendingChannelPayloads.push(payload);
      stderr(`[ipc] queued channel notification (pre-init window), queued=${state.pendingChannelPayloads.length}\n`);
      return;
    }
    sendChannelPayloadNow(payload);
  }

  function markInitialized() {
    state.mcpInitialized = true;
    const flushCount = state.pendingChannelPayloads.length;
    trace('mcp_initialized_flush_begin', { queued_count: flushCount });
    stderr(`[ipc] MCP initialized, flushing ${flushCount} queued channel notification(s)\n`);
    while (state.pendingChannelPayloads.length > 0) {
      const payload = state.pendingChannelPayloads.shift();
      trace('channel_notification_flushed', {
        msg_id: payload.params?.meta?.message_id,
      });
      sendChannelPayloadNow(payload);
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
