/**
 * lib/feishu-adapter.mjs — 飞书多app配置加载与Token缓存
 *
 * 导出：
 *   feishuApps       — 当前加载的app配置数组（getter，支持热重载）
 *   getFeishuToken   — 获取/缓存tenant access token
 *   startFeishuConfigPoller(stderr) — 启动10秒轮询，配置变更时热重载
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const feishuConfigPath = join(__dir, '..', 'feishu-apps.json');

// 内部可变状态
let _feishuApps = [];
let _lastFeishuConfigMtime = 0;

// 初始加载
try {
  if (existsSync(feishuConfigPath)) {
    _feishuApps = JSON.parse(readFileSync(feishuConfigPath, 'utf8'));
  }
} catch { /* 配置不存在或格式无效 */ }

try { _lastFeishuConfigMtime = statSync(feishuConfigPath).mtimeMs; } catch {}

/** 始终返回最新的app数组（外部通过此getter读取，热重载自动生效） */
export function getFeishuApps() { return _feishuApps; }

/** 启动10秒轮询，文件变更时热重载 */
export function startFeishuConfigPoller(stderr) {
  const interval = setInterval(() => {
    try {
      const mtime = statSync(feishuConfigPath).mtimeMs;
      if (mtime !== _lastFeishuConfigMtime) {
        _lastFeishuConfigMtime = mtime;
        try {
          _feishuApps = JSON.parse(readFileSync(feishuConfigPath, 'utf8'));
          stderr(`[ipc-hub] feishu: reloaded ${_feishuApps.length} app(s) from feishu-apps.json`);
        } catch (err) {
          stderr(`[ipc-hub] feishu: failed to reload config: ${err?.message ?? err}`);
        }
      }
    } catch {}
  }, 10000);
  interval.unref();
  return interval;
}

// token缓存：Map<appId, { token, expiry }>
const feishuTokenCache = new Map();

/** 获取指定app的tenant access token（自动缓存，提前60秒刷新） */
export async function getFeishuToken(app) {
  const cached = feishuTokenCache.get(app.appId);
  if (cached && Date.now() < cached.expiry - 60000) {
    return cached.token;
  }

  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
    });
    const data = await res.json();
    if (data.code === 0) {
      feishuTokenCache.set(app.appId, {
        token: data.tenant_access_token,
        expiry: Date.now() + (data.expire - 60) * 1000,
      });
      return data.tenant_access_token;
    }
    return null;
  } catch {
    return null;
  }
}
