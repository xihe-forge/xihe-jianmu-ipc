/**
 * console-cards.mjs — Feishu interactive card builders for the AI Control Console
 *
 * Builds Feishu card JSON objects (v1 schema) for managing AI agents from chat.
 * All functions return plain objects ready for JSON serialization.
 *
 * Usage:
 *   import { buildStatusCard, buildHelpCard, buildDispatchCard } from './lib/console-cards.mjs';
 *   const card = buildStatusCard(agents, hubHealth);
 *   // POST card to Feishu message API
 */

/** @param {string} str @param {number} max */
function truncate(str, max = 40) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/** @param {number} ms */
function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

/** @param {boolean} online */
function statusEmoji(online) {
  return online ? '🟢' : '⚫';
}

// ---------------------------------------------------------------------------
// 1. buildStatusCard
// ---------------------------------------------------------------------------

/**
 * Build a card showing all agent statuses and hub health.
 *
 * @param {Array<{ name: string, online: boolean, connectedAt: string|null, lastSeen: number|null }>} agents
 * @param {{ uptime: number, messageCount: number }} hubHealth
 * @returns {object} Feishu card JSON
 */
export function buildStatusCard(agents, hubHealth) {
  const now = Date.now();
  const onlineCount = agents.filter(a => a.online).length;
  const total = agents.length;

  const agentLines = agents.length > 0
    ? agents.map(a => {
        const duration = a.online && a.connectedAt
          ? formatDuration(now - new Date(a.connectedAt).getTime())
          : a.lastSeen
            ? `离线 ${formatDuration(now - a.lastSeen)} 前`
            : '从未连接';
        const label = a.online ? `在线 ${duration}` : duration;
        return `${statusEmoji(a.online)} **${a.name}** — ${label}`;
      }).join('\n')
    : '_暂无已知Agent_';

  const uptime = hubHealth?.uptime != null ? formatDuration(hubHealth.uptime * 1000) : '—';
  const msgCount = hubHealth?.messageCount ?? 0;

  const bodyMd = `**在线: ${onlineCount} / ${total}**\n\n${agentLines}\n\n---\nHub运行时长: ${uptime}　消息总数: ${msgCount}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🖥️ AI 控制台' },
      template: 'blue',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: bodyMd } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 刷新' },
            type: 'primary',
            value: { action: 'refresh_status' },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. buildHelpCard
// ---------------------------------------------------------------------------

/**
 * Build a card listing all available console commands.
 *
 * @returns {object} Feishu card JSON
 */
export function buildHelpCard() {
  const commands = [
    ['状态', '查看所有Agent在线状态'],
    ['让{agent}{task}', '派发任务给指定Agent'],
    ['广播:{content}', '向所有在线Agent广播消息'],
    ['重启 {target}', '重启指定服务'],
    ['消息记录', '查看最近消息历史'],
    ['日报', '生成今日工作报告'],
    ['帮助', '显示此帮助'],
  ];

  const rows = commands.map(([cmd, desc]) => `**${cmd}** — ${desc}`).join('\n');

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📖 命令帮助' },
      template: 'blue',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: rows } },
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. buildDispatchCard
// ---------------------------------------------------------------------------

/**
 * Build a confirmation card after dispatching a task to an agent.
 *
 * @param {string} target - Agent name
 * @param {string} content - Task content
 * @param {string} messageId - IPC message ID
 * @param {boolean} [sent=true] - Whether the agent was online (sent) or buffered (pending)
 * @returns {object} Feishu card JSON
 */
export function buildDispatchCard(target, content, messageId, sent = true) {
  const preview = truncate(content);
  const statusNote = sent ? '已送达' : '已缓冲（Agent离线）';
  const bodyMd = `→ **${target}**: ${preview}\n\n_状态: ${statusNote}_`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📤 任务已派发' },
      template: sent ? 'green' : 'wathet',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: bodyMd } },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. buildBroadcastCard
// ---------------------------------------------------------------------------

/**
 * Build a confirmation card after a broadcast message is sent.
 *
 * @param {string} content - Broadcast content
 * @param {number} onlineCount - Number of agents that received it
 * @param {number} totalCount - Total known agents
 * @returns {object} Feishu card JSON
 */
export function buildBroadcastCard(content, onlineCount, totalCount) {
  const preview = truncate(content);
  const bodyMd = `已发送给 **${onlineCount}/${totalCount}** 个在线Agent\n\n内容: ${preview}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📢 广播已发送' },
      template: 'green',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: bodyMd } },
    ],
  };
}

// ---------------------------------------------------------------------------
// 5. buildApprovalCard
// ---------------------------------------------------------------------------

/**
 * Build an approval request card from an agent asking the user to confirm.
 *
 * @param {string} agentName - Name of the requesting agent
 * @param {string} question - The question or action requiring approval
 * @param {string} approvalId - Unique approval request ID
 * @returns {object} Feishu card JSON
 */
export function buildApprovalCard(agentName, question, approvalId) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⚠️ ${agentName} 请求确认` },
      template: 'orange',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: question } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认' },
            type: 'primary',
            value: { action: 'approve', id: approvalId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { action: 'reject', id: approvalId },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 6. buildReportCard
// ---------------------------------------------------------------------------

/**
 * Build a daily work report card.
 *
 * @param {{ date: string, agents: Array<{ name: string, messagesHandled: number, status: string }>, totalMessages: number, hubUptime: number }} reportData
 * @returns {object} Feishu card JSON
 */
export function buildReportCard(reportData) {
  const { date, agents = [], totalMessages = 0, hubUptime = 0 } = reportData;

  const agentRows = agents.length > 0
    ? agents.map(a => `${statusEmoji(a.status === 'online')} **${a.name}** — 处理消息: ${a.messagesHandled}`).join('\n')
    : '_无Agent数据_';

  const uptime = formatDuration(hubUptime * 1000);
  const bodyMd = `**总消息数:** ${totalMessages}　**Hub运行时长:** ${uptime}\n\n---\n**Agent明细**\n\n${agentRows}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 ${date} 工作报告` },
      template: 'blue',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: bodyMd } },
    ],
  };
}

// ---------------------------------------------------------------------------
// 7. buildErrorCard
// ---------------------------------------------------------------------------

/**
 * Build a generic error card.
 *
 * @param {string} title - Error title
 * @param {string} message - Error detail message
 * @returns {object} Feishu card JSON
 */
export function buildErrorCard(title, message) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'red',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: message } },
    ],
  };
}
