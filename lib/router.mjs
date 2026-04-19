/**
 * lib/router.mjs — 消息路由核心模块
 *
 * 通过闭包+ctx依赖注入模式提供：
 *   - routeMessage(msg, senderSession) — 核心消息路由
 *   - send(ws, payload)               — 单点发送
 *   - broadcast(payload, exceptName)  — 广播
 *   - broadcastToTopic(topic, payload, exceptName) — topic fanout
 *   - pushInbox / flushInbox          — 离线收件箱管理
 *   - scheduleInboxCleanup            — 收件箱TTL清理
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INBOX_MAX_SIZE, INBOX_TTL } from './constants.mjs';

const __routerDir = dirname(fileURLToPath(import.meta.url));

/**
 * 创建路由器实例（闭包封装所有路由相关函数）
 *
 * @param {object} ctx 依赖上下文
 * @param {Map}      ctx.sessions               — 会话注册表
 * @param {Map}      ctx.deliveredMessageIds    — 消息去重Map
 * @param {Map}      ctx.ackPending             — 待确认消息Map
 * @param {Array}    ctx.feishuApps             — 飞书应用配置数组
 * @param {Function} ctx.getFeishuToken         — 获取飞书token函数
 * @param {Function} ctx.isOpenClawSession      — 判断是否OpenClaw会话
 * @param {Function} ctx.deliverToOpenClaw      — OpenClaw投递函数
 * @param {Function} ctx.enqueueOpenClawRetry   — OpenClaw重试队列
 * @param {Function} ctx.stderr                 — stderr输出函数
 * @param {Function} ctx.audit                  — 审计日志函数
 * @param {Function} ctx.saveMessage            — 消息持久化函数
 * @param {Function} ctx.saveInboxMessage       — inbox消息持久化函数
 * @param {Function} ctx.getInboxMessages       — 读取session inbox消息函数
 * @param {Function} ctx.getRecipientRecent     — 读取session近期消息函数
 * @param {Function} ctx.findPendingRebind      — 查询 pending_rebind 记录
 * @param {Function} ctx.appendBufferedMessage  — 向 pending_rebind 追加缓冲消息
 * @param {Function} ctx.clearInbox             — 清空session inbox消息函数
 */
export function createRouter(ctx) {
  const {
    sessions,
    deliveredMessageIds,
    ackPending,
    feishuApps,
    getFeishuToken,
    isOpenClawSession,
    deliverToOpenClaw,
    enqueueOpenClawRetry,
    stderr,
    audit,
    saveMessage,
    saveInboxMessage,
    getInboxMessages,
    getRecipientRecent = () => [],
    findPendingRebind = () => null,
    appendBufferedMessage = () => 0,
    clearInbox,
  } = ctx;

  // ---------------------------------------------------------------------------
  // 底层发送工具
  // ---------------------------------------------------------------------------

  /** 向单个WebSocket安全发送JSON payload */
  function send(ws, payload) {
    try {
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    } catch (err) {
      stderr(`[ipc-hub] send error: ${err.message}`);
    }
  }

  /** 向所有在线会话广播，可排除指定发送者 */
  function broadcast(payload, exceptName = null) {
    for (const [name, session] of sessions) {
      if (name === exceptName) continue;
      if (session.ws && session.ws.readyState === session.ws.OPEN) {
        send(session.ws, payload);
      }
    }
  }

  /** 向订阅了指定 topic 的会话扇出消息，返回已投递的 session 名称 */
  function broadcastToTopic(topic, payload, exceptName = null) {
    const delivered = [];

    for (const [, session] of sessions) {
      if (session.name === exceptName) continue;
      // OpenClaw会话只通过/hooks/wake接收，跳过
      if (isOpenClawSession(session.name)) continue;
      if (!session.topics.has(topic)) continue;

      if (session.ws && session.ws.readyState === session.ws.OPEN) {
        send(session.ws, payload);
      } else {
        pushInbox(session, payload);
      }

      delivered.push(session.name);
    }

    return delivered;
  }

  // ---------------------------------------------------------------------------
  // 离线收件箱管理
  // ---------------------------------------------------------------------------

  /** 将消息压入离线收件箱（FIFO超出上限时淘汰最旧消息） */
  function pushInbox(session, msg) {
    session.inbox.push(msg);
    if (session.inbox.length > INBOX_MAX_SIZE) {
      session.inbox.shift(); // 淘汰最旧
    }
    // SQLite只做持久化备份，失败时不能影响现有内存缓冲行为
    try {
      saveInboxMessage(session.name, msg);
    } catch (err) {
      stderr(`[ipc-hub] saveInboxMessage error for ${session.name}: ${err.message}`);
    }
  }

  function toReplayMessage(item) {
    if (!item || typeof item !== 'object') return item;
    if (!Object.hasOwn(item, 'content_type')) return item;
    return {
      id: item.id,
      type: item.type,
      from: item.from,
      to: item.to,
      content: item.content,
      contentType: item.content_type ?? 'text',
      topic: item.topic,
      ts: item.ts,
    };
  }

  function getFallbackMessageKey(item) {
    const rawContent = typeof item?.content === 'string'
      ? item.content
      : item?.content == null
        ? ''
        : JSON.stringify(item.content);
    return `${item?.from ?? ''}|${item?.to ?? ''}|${item?.ts ?? ''}|${rawContent.slice(0, 32)}`;
  }

  function mergeReplayMessages(items) {
    const messages = [];
    const seenIds = new Set();
    const seenFallbackKeys = new Set();
    const merged = items
      .map((item, index) => {
        const replayItem = toReplayMessage(item);
        return {
          item: replayItem,
          index,
          ts: Number.isFinite(replayItem?.ts) ? replayItem.ts : Number.MAX_SAFE_INTEGER,
        };
      })
      .sort((a, b) => a.ts - b.ts || a.index - b.index);

    for (const { item } of merged) {
      if (item?.id) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
      } else {
        const fallbackKey = getFallbackMessageKey(item);
        if (seenFallbackKeys.has(fallbackKey)) continue;
        seenFallbackKeys.add(fallbackKey);
      }
      messages.push(item);
    }

    return messages;
  }

  /** 将缓冲的收件箱消息一次性发送给重新连接的会话 */
  function flushInbox(session) {
    let persistedMessages = [];
    let recentMessages = [];
    try {
      persistedMessages = getInboxMessages(session.name);
    } catch (err) {
      stderr(`[ipc-hub] getInboxMessages error for ${session.name}: ${err.message}`);
    }
    try {
      recentMessages = getRecipientRecent(session.name);
    } catch (err) {
      stderr(`[ipc-hub] getRecipientRecent error for ${session.name}: ${err.message}`);
    }

    const hasBufferedMessages = persistedMessages.length > 0 || recentMessages.length > 0 || session.inbox.length > 0;
    if (!hasBufferedMessages) return;

    // OpenClaw会话通过/hooks/wake接收消息，不通过WS flush
    if (isOpenClawSession(session.name)) {
      session.inbox.length = 0; // 丢弃——已通过/hooks/wake投递
      try {
        clearInbox(session.name);
      } catch (err) {
        stderr(`[ipc-hub] clearInbox error for ${session.name}: ${err.message}`);
      }
      return;
    }

    // 合并 SQLite inbox、messages 表 recent 与内存热缓存，按 ts 升序发送；优先按 id 去重
    const messages = mergeReplayMessages([...persistedMessages, ...recentMessages, ...session.inbox]);

    if (messages.length === 0) {
      session.inbox.length = 0;
      try {
        clearInbox(session.name);
      } catch (err) {
        stderr(`[ipc-hub] clearInbox error for ${session.name}: ${err.message}`);
      }
      return;
    }

    send(session.ws, { type: 'inbox', messages });
    session.inbox.length = 0;
    try {
      clearInbox(session.name);
    } catch (err) {
      stderr(`[ipc-hub] clearInbox error for ${session.name}: ${err.message}`);
    }
  }

  /** 设定收件箱TTL：过期后删除离线会话记录 */
  function scheduleInboxCleanup(session) {
    if (session.inboxExpiry !== null) {
      clearTimeout(session.inboxExpiry);
    }
    session.inboxExpiry = setTimeout(() => {
      if (!session.ws) {
        // 仍然离线——彻底删除会话
        sessions.delete(session.name);
        stderr(`[ipc-hub] inbox expired, removed offline session: ${session.name}`);
      }
    }, INBOX_TTL);
  }

  /** 创建一个离线 stub session，等待同名真实会话未来连接时复用 */
  function createStubSession(name) {
    return {
      name,
      ws: null,
      connectedAt: 0,
      topics: new Set(),
      inbox: [],
      inboxExpiry: null,
    };
  }

  /** 判断一个 session 是否为尚未真正连接过的 stub */
  function isStubSession(session) {
    return Boolean(session) && session.ws === null && session.connectedAt === 0;
  }

  /** 首次创建 stub 时，回发送方一条 unknown-target 系统警告 */
  function warnUnknownTarget(senderSession, targetName, msg) {
    if (!senderSession?.name || !senderSession?.ws) return;
    if (isStubSession(senderSession)) return;
    if (senderSession.ws.readyState !== senderSession.ws.OPEN) return;

    send(senderSession.ws, {
      type: 'unknown-target',
      from: 'hub',
      to: senderSession.name,
      target: targetName,
      msgId: msg.id,
      reason: 'target session not connected at routing time; message buffered in stub inbox; will deliver if a session with this exact name connects later',
      hint: 'call ipc_sessions() first to verify target name; Hub does not fuzzy-match',
      ts: Date.now(),
    });
    stderr(`[ipc-hub] unknown-target warned: ${senderSession.name} about missing ${targetName} (msgId=${msg.id ?? 'n/a'})`);
  }

  // ---------------------------------------------------------------------------
  // 核心路由逻辑
  // ---------------------------------------------------------------------------

  /**
   * 路由一条消息到目标：飞书群组、飞书P2P、OpenClaw、普通IPC会话
   *
   * @param {object} msg           — 标准消息对象（含 from/to/topic/content/id 等）
   * @param {object} senderSession — 发送方会话对象（至少含 name 字段）
   */
  function routeMessage(msg, senderSession) {
    const { to, topic } = msg;
    stderr(`[ipc-hub] routeMessage: ${msg.from} → ${to} (sender=${senderSession.name})`);

    // 消息去重：同一messageId不重复投递
    if (msg.id && deliveredMessageIds.has(msg.id)) {
      stderr(`[ipc-hub] routeMessage: skipping duplicate ${msg.id}`);
      return;
    }
    if (msg.id) deliveredMessageIds.set(msg.id, Date.now());

    audit('message_route', { from: msg.from, to, id: msg.id });
    if (msg.type === 'message') saveMessage(msg);

    // 记录待确认状态（用于ACK回调）
    if (msg.id && senderSession.name) {
      ackPending.set(msg.id, { sender: senderSession.name, ts: Date.now() });
    }
    const delivered = new Set(); // 已投递名单（避免topic+direct重复）

    // ---- 基于topic的扇出（可与直接寻址组合使用）----
    if (topic) {
      for (const deliveredName of broadcastToTopic(topic, msg, senderSession.name)) {
        delivered.add(deliveredName);
      }
    }

    // ---- 直接寻址或广播路由 ----
    if (to === '*' && !topic) {
      // 广播给所有人（无topic时），排除发送方
      for (const [, s] of sessions) {
        if (s.name === senderSession.name) continue;
        if (delivered.has(s.name)) continue;
        // OpenClaw会话只通过/hooks/wake接收，跳过
        if (isOpenClawSession(s.name)) continue;
        if (s.ws && s.ws.readyState === s.ws.OPEN) {
          send(s.ws, msg);
        } else {
          pushInbox(s, msg);
        }
      }
    } else if (to && to !== '*') {
      // 点对点——若topic已投递则跳过
      if (!delivered.has(to)) {
        // 路径1：飞书群组（feishu-group:<chatId>）
        if (to.startsWith('feishu-group:')) {
          const chatId = to.split(':')[1];
          if (chatId) {
            const sendApp = feishuApps.find(a => a.send && a.targetOpenId);
            if (sendApp) {
              getFeishuToken(sendApp).then(token => {
                if (!token) return;
                const text = msg.content;
                fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                  body: JSON.stringify({
                    receive_id: chatId,
                    msg_type: 'text',
                    content: JSON.stringify({ text }),
                  }),
                }).then(r => r.json()).then(data => {
                  if (data.code === 0) stderr(`[ipc-hub] feishu group: sent to chat ${chatId} from ${senderSession.name}`);
                  else stderr(`[ipc-hub] feishu group: error ${data.code}: ${data.msg}`);
                }).catch(err => stderr(`[ipc-hub] feishu group: failed: ${err?.message ?? err}`));
              });
              stderr(`[ipc-hub] ${senderSession.name} → ${to}: routed to Feishu group`);
            } else {
              stderr(`[ipc-hub] ${senderSession.name} → ${to}: no send-enabled Feishu app found`);
            }
          }

        // 路径2：飞书P2P（feishu 或 feishu:<appName>）
        } else if (to === 'feishu' || to.startsWith('feishu:')) {
          // to="feishu:jianmu-pm" → 找指定app；否则用默认send app
          const appName = to.includes(':') ? to.split(':')[1] : null;
          const app = appName
            ? feishuApps.find(a => a.name === appName && (a.chatId || a.targetOpenId))
            : feishuApps.find(a => a.send && (a.chatId || a.targetOpenId));
          if (app) {
            const receiveId = app.chatId || app.targetOpenId;
            const receiveIdType = app.chatId ? 'chat_id' : 'open_id';
            getFeishuToken(app).then(token => {
              if (!token) return;
              const text = msg.content;
              fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                  receive_id: receiveId,
                  msg_type: 'text',
                  content: JSON.stringify({ text }),
                }),
              }).then(r => r.json()).then(data => {
                if (data.code === 0) stderr(`[ipc-hub] feishu [${app.name}]: sent reply from ${senderSession.name} (${receiveIdType})`);
                else stderr(`[ipc-hub] feishu [${app.name}]: reply error ${data.code}: ${data.msg}`);
              }).catch(err => stderr(`[ipc-hub] feishu [${app.name}]: reply failed: ${err?.message ?? err}`));
            });
            stderr(`[ipc-hub] ${senderSession.name} → ${to}: routed to Feishu [${app.name}] via ${receiveIdType}`);
          } else {
            stderr(`[ipc-hub] ${senderSession.name} → ${to}: no matching Feishu app found`);
          }

        // 路径3：OpenClaw会话（通过/hooks/wake实时投递，WebSocket仅供MCP工具调用）
        } else if (isOpenClawSession(to)) {
          deliverToOpenClaw(msg).then(ok => {
            if (!ok) {
              enqueueOpenClawRetry(msg);
            } else {
              // /hooks/wake成功——更新pending-cards.json中的stage为2
              try {
                const pcPath = join(dirname(__routerDir), 'data', 'pending-cards.json');
                const pc = JSON.parse(readFileSync(pcPath, 'utf8'));
                for (const [, info] of Object.entries(pc)) {
                  if (info.tasks) {
                    for (const task of info.tasks) {
                      if (task.stage < 2 && task.hubMessageId === msg.id) {
                        task.stage = 2;
                      }
                    }
                  }
                }
                writeFileSync(pcPath, JSON.stringify(pc));
              } catch {}
            }
          });
          // Hub本身不转飞书——OpenClaw自己负责转发到自己的飞书群
          stderr(`[ipc-hub] ${senderSession.name} → ${to}: routed to OpenClaw /hooks/wake`);

        // 路径4：普通IPC会话
        } else {
          const pendingRebind = findPendingRebind(to);
          if (pendingRebind) {
            const buffered = appendBufferedMessage(to, msg);
            if (buffered > 0) {
              audit('rebind_buffered', { to, id: msg.id });
              stderr(`[ipc-hub] ${senderSession.name} → ${to}: buffered for pending rebind`);
              return;
            }
          }

          const target = sessions.get(to);
          if (target) {
            if (target.ws && target.ws.readyState === target.ws.OPEN) {
              send(target.ws, msg);
            } else {
              pushInbox(target, msg);
              stderr(`[ipc-hub] ${senderSession.name} → ${to}: session offline, buffered`);
            }
          } else {
            // 未知会话——创建stub并缓冲消息（通过pushInbox持久化到SQLite）
            const stub = createStubSession(to);
            sessions.set(to, stub);
            pushInbox(stub, msg);
            scheduleInboxCleanup(stub);
            stderr(`[ipc-hub] ${senderSession.name} → ${to}: unknown session, created stub with buffered msg`);
            warnUnknownTarget(senderSession, to, msg);
          }
        }
      }
    }
  }

  /** 将 pending_rebind 恢复路径上的 inbox + buffered_messages 合并发送给新 session */
  function flushPendingRebind(session, pendingRebind) {
    let persistedMessages = [];
    try {
      persistedMessages = getInboxMessages(session.name);
    } catch (err) {
      stderr(`[ipc-hub] getInboxMessages error for ${session.name}: ${err.message}`);
    }

    const bufferedMessages = Array.isArray(pendingRebind?.bufferedMessages)
      ? pendingRebind.bufferedMessages
      : [];
    const hasBufferedMessages = persistedMessages.length > 0 || bufferedMessages.length > 0 || session.inbox.length > 0;
    if (!hasBufferedMessages) return 0;

    if (isOpenClawSession(session.name)) {
      session.inbox.length = 0;
      try {
        clearInbox(session.name);
      } catch (err) {
        stderr(`[ipc-hub] clearInbox error for ${session.name}: ${err.message}`);
      }
      return 0;
    }

    const messages = mergeReplayMessages([...persistedMessages, ...bufferedMessages, ...session.inbox]);
    if (messages.length === 0) {
      session.inbox.length = 0;
      try {
        clearInbox(session.name);
      } catch (err) {
        stderr(`[ipc-hub] clearInbox error for ${session.name}: ${err.message}`);
      }
      return 0;
    }

    send(session.ws, { type: 'inbox', messages });
    session.inbox.length = 0;
    try {
      clearInbox(session.name);
    } catch (err) {
      stderr(`[ipc-hub] clearInbox error for ${session.name}: ${err.message}`);
    }
    return messages.length;
  }

  return {
    routeMessage,
    send,
    broadcast,
    broadcastToTopic,
    pushInbox,
    flushInbox,
    flushPendingRebind,
    scheduleInboxCleanup,
  };
}
