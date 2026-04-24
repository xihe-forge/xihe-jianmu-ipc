export function createChannelNotifier({ serverNotify, stderr, now }) {
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
    Promise.resolve(serverNotify(payload)).catch((err) => {
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
    stderr(`[ipc] MCP initialized, flushing ${flushCount} queued channel notification(s)\n`);
    while (state.pendingChannelPayloads.length > 0) {
      sendChannelPayloadNow(state.pendingChannelPayloads.shift());
    }
  }

  return {
    pushChannelNotification,
    markInitialized,
    _state: state,
  };
}
