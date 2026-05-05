/**
 * command-parser.mjs
 *
 * Parses Chinese/English commands from Feishu (Lark) bot messages.
 * Returns a structured command object, or null if the message is a regular
 * forwarding message and should not be treated as a console command.
 *
 * Supported command types:
 *   status   — show all agent session status
 *   dispatch — send a task to a specific agent
 *   broadcast— send a message to all online agents
 *   restart  — restart a specific agent or service
 *   history  — query message history
 *   sessions_list — query sessions_history
 *   sessions_cleanup_request — request sessions_history cleanup approval
 *   help     — show available commands
 *   report   — trigger a status report
 */

/**
 * Parse a Feishu message text into a structured command object.
 *
 * @param {string} text - The raw message text from Feishu
 * @returns {{ type: string, [key: string]: any } | null}
 *   A command object on match, or null to indicate a regular (non-command) message.
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;

  const t = text.trim();
  if (!t) return null;

  const lower = t.toLowerCase();

  // ── SESSIONS CLEANUP / LIST ────────────────────────────────────────────────
  if (t === '清理 session 列表' || t === 'session 列表' || lower === 'sessions list') {
    return { type: 'sessions_list' };
  }

  let m = t.match(/^清理\s*session\s+(\d+)\s*天前$/i);
  if (m) {
    return { type: 'sessions_cleanup_request', olderThanDays: parseInt(m[1], 10) };
  }

  m = t.match(/^清理\s*session\s+(.+)$/i);
  if (m) {
    return { type: 'sessions_cleanup_request', name: m[1].trim() };
  }

  // ── 1. STATUS ──────────────────────────────────────────────────────────────
  // Triggers: "状态" | "status" | "在线" | "谁在线"
  if (
    t === '状态' ||
    lower === 'status' ||
    t === '在线' ||
    t === '谁在线'
  ) {
    return { type: 'status' };
  }

  // ── 2. HELP ────────────────────────────────────────────────────────────────
  // Triggers: "帮助" | "help" | "命令" | "commands"
  if (
    t === '帮助' ||
    lower === 'help' ||
    t === '命令' ||
    lower === 'commands'
  ) {
    return { type: 'help' };
  }

  // ── 3. REPORT ──────────────────────────────────────────────────────────────
  // Triggers: "日报" | "report" | "汇报" | "今日总结"
  if (
    t === '日报' ||
    lower === 'report' ||
    t === '汇报' ||
    t === '今日总结'
  ) {
    return { type: 'report' };
  }

  // ── 4. BROADCAST ───────────────────────────────────────────────────────────
  // Triggers: "广播:{content}" | "broadcast:{content}" |
  //           "通知所有人:{content}" | "全体:{content}"
  const broadcastPrefixes = ['广播:', 'broadcast:', '通知所有人:', '全体:'];
  for (const prefix of broadcastPrefixes) {
    if (lower.startsWith(prefix.toLowerCase())) {
      const content = t.slice(prefix.length).trim();
      if (content) return { type: 'broadcast', content };
    }
  }

  // ── 5. RESTART ─────────────────────────────────────────────────────────────
  // Triggers: "重启{target}" | "restart {target}"
  m = t.match(/^重启\s*(.+)$/);
  if (m) {
    return { type: 'restart', target: m[1].trim() };
  }
  m = t.match(/^restart\s+(.+)$/i);
  if (m) {
    return { type: 'restart', target: m[1].trim() };
  }

  // ── 6. HISTORY ─────────────────────────────────────────────────────────────
  // Triggers: "消息记录" | "历史消息" | "history" | "最近消息"
  // Optional suffixes: peer name and/or a numeric limit
  // Examples:
  //   "消息记录"
  //   "历史消息 openclaw"
  //   "history openclaw 20"
  //   "最近消息 20"
  const historyKeywords = ['消息记录', '历史消息', 'history', '最近消息'];
  for (const kw of historyKeywords) {
    if (lower.startsWith(kw.toLowerCase())) {
      const rest = t.slice(kw.length).trim();
      const result = { type: 'history' };
      if (rest) {
        // Split remainder into tokens; last token may be a number (limit)
        const tokens = rest.split(/\s+/);
        const last = tokens[tokens.length - 1];
        if (/^\d+$/.test(last)) {
          result.limit = parseInt(last, 10);
          if (tokens.length > 1) {
            result.peer = tokens.slice(0, -1).join(' ');
          }
        } else {
          result.peer = tokens.join(' ');
        }
      }
      return result;
    }
  }

  // ── 7. DISPATCH ────────────────────────────────────────────────────────────
  // Triggers (in order of specificity):
  //   "让{agent}去{task}"       — e.g. "让openclaw去查一下这个issue"
  //   "让{agent} {task}"        — e.g. "让openclaw 帮我找找"
  //   "@{agent} {task}"         — e.g. "@openclaw 查一下GitHub issue"
  //   "告诉{agent} {task}"      — e.g. "告诉openclaw 暂停"
  //   "告诉{agent}:{task}"
  //   "转发给{agent} {task}"    — e.g. "转发给openclaw 这段日志"
  //   "转发给{agent}:{task}"

  // Pattern: 让 <agent> 去 <task>
  m = t.match(/^让\s*(\S+)\s*去\s*(.+)$/);
  if (m) {
    return { type: 'dispatch', target: m[1].trim(), content: m[2].trim() };
  }

  // Pattern: 让 <agent> <task>  (agent is first non-space word after 让)
  m = t.match(/^让\s*(\S+)\s+(.+)$/);
  if (m) {
    return { type: 'dispatch', target: m[1].trim(), content: m[2].trim() };
  }

  // Pattern: @<agent> <task>
  m = t.match(/^@(\S+)\s+(.+)$/);
  if (m) {
    return { type: 'dispatch', target: m[1].trim(), content: m[2].trim() };
  }

  // Pattern: 告诉 <agent> [: ] <task>
  m = t.match(/^告诉\s*(\S+?)\s*[: ]\s*(.+)$/);
  if (m) {
    return { type: 'dispatch', target: m[1].trim(), content: m[2].trim() };
  }

  // Pattern: 转发给 <agent> [: ] <task>
  m = t.match(/^转发给\s*(\S+?)\s*[: ]\s*(.+)$/);
  if (m) {
    return { type: 'dispatch', target: m[1].trim(), content: m[2].trim() };
  }

  // ── 8. NOT A COMMAND ───────────────────────────────────────────────────────
  return null;
}
