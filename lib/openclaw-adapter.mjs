/**
 * lib/openclaw-adapter.mjs — OpenClaw Gateway HTTP适配器
 *
 * 负责通过 /hooks/wake 将IPC消息推送给OpenClaw进程。
 * 投递失败时进入后台重试队列（5分钟TTL，15秒间隔）。
 *
 * 导出：
 *   isOpenClawSession(name)     — 是否OpenClaw会话（名称以openclaw开头）
 *   deliverToOpenClaw(msg)      — 推送到/hooks/wake，成功返回true
 *   enqueueOpenClawRetry(msg)   — 加入重试队列
 *   startOpenClawRetryTimer(stderr) — 启动后台重试定时器
 */

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';

const OPENCLAW_RETRY_INTERVAL = 15000; // 每15秒扫描重试队列
const OPENCLAW_RETRY_TTL = 300000;     // 5分钟后放弃

const openclawRetryQueue = [];

/** 判断session名是否属于OpenClaw */
export function isOpenClawSession(name) {
  return name.startsWith('openclaw');
}

/** 向OpenClaw /hooks/wake推送IPC消息，成功返回true */
export async function deliverToOpenClaw(msg, stderr) {
  const text = `[IPC from ${msg.from}] ${msg.content}\n\n⚡ 请用 message 工具将以上 IPC 结果转发到飞书。`;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (OPENCLAW_TOKEN) headers['Authorization'] = `Bearer ${OPENCLAW_TOKEN}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${OPENCLAW_URL}/hooks/wake`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, mode: 'now' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      if (stderr) stderr(`[ipc-hub] openclaw adapter: pushed to /hooks/wake (from=${msg.from})`);
      return true;
    } else {
      const body = await res.text();
      if (stderr) stderr(`[ipc-hub] openclaw adapter: /hooks/wake error ${res.status}: ${body.substring(0, 200)}`);
      return false;
    }
  } catch (err) {
    if (stderr) stderr(`[ipc-hub] openclaw adapter: failed: ${err?.message ?? err}`);
    return false;
  }
}

/** 将失败消息加入后台重试队列 */
export function enqueueOpenClawRetry(msg, stderr) {
  openclawRetryQueue.push({ msg, enqueuedAt: Date.now(), attempts: 1 });
  if (stderr) stderr(`[ipc-hub] openclaw retry queue: enqueued msg from ${msg.from} (queue size: ${openclawRetryQueue.length})`);
}

/** 启动后台重试定时器（返回interval对象） */
export function startOpenClawRetryTimer(stderr) {
  const interval = setInterval(async () => {
    if (openclawRetryQueue.length === 0) return;
    const now = Date.now();
    for (let i = openclawRetryQueue.length - 1; i >= 0; i--) {
      const entry = openclawRetryQueue[i];
      if (now - entry.enqueuedAt > OPENCLAW_RETRY_TTL) {
        if (stderr) stderr(`[ipc-hub] openclaw retry queue: TTL expired for msg from ${entry.msg.from} after ${entry.attempts} attempts`);
        openclawRetryQueue.splice(i, 1);
        continue;
      }
      entry.attempts++;
      const ok = await deliverToOpenClaw(entry.msg, stderr);
      if (ok) {
        if (stderr) stderr(`[ipc-hub] openclaw retry queue: delivered on attempt ${entry.attempts} (from=${entry.msg.from})`);
        openclawRetryQueue.splice(i, 1);
      }
    }
  }, OPENCLAW_RETRY_INTERVAL);
  interval.unref();
  return interval;
}
