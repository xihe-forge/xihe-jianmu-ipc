/**
 * tests/feishu-adapter.test.mjs — lib/feishu-adapter.mjs 单元测试
 *
 * 覆盖 getFeishuToken 的缓存策略、失败处理、API 调用参数。
 * getFeishuApps / startFeishuConfigPoller 依赖 feishu-apps.json 文件 I/O，
 * 由集成测试覆盖（feishu-apps.json 在运行时由 Hub 加载）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFeishuToken } from '../lib/feishu-adapter.mjs';

// ── mock fetch 工具 ───────────────────────────────────────────────────────────

/** 替换 globalThis.fetch，记录调用参数，返回指定响应 */
function mockFetch(responseOrFn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const resp = typeof responseOrFn === 'function' ? await responseOrFn({ url, opts }) : responseOrFn;
    return {
      async json() {
        if (resp instanceof Error) throw resp;
        return resp;
      },
    };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

/** 每个测试用唯一 appId 避免缓存污染 */
function uniqApp(suffix = '') {
  return {
    appId: `cli_test_${Date.now()}_${Math.random().toString(16).slice(2, 6)}${suffix}`,
    appSecret: 'secret',
  };
}

// ── getFeishuToken: 成功路径 ──────────────────────────────────────────────────

test('getFeishuToken: code=0 返回 tenant_access_token', async () => {
  const app = uniqApp();
  const fetchMock = mockFetch({ code: 0, tenant_access_token: 't_abc', expire: 7200 });
  try {
    const token = await getFeishuToken(app);
    assert.equal(token, 't_abc');
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
    assert.equal(fetchMock.calls[0].opts.method, 'POST');
    assert.equal(fetchMock.calls[0].opts.headers['Content-Type'], 'application/json');
    const body = JSON.parse(fetchMock.calls[0].opts.body);
    assert.equal(body.app_id, app.appId);
    assert.equal(body.app_secret, app.appSecret);
  } finally {
    fetchMock.restore();
  }
});

test('getFeishuToken: 重复调用同 appId 使用缓存（只 fetch 一次）', async () => {
  const app = uniqApp('_cache');
  const fetchMock = mockFetch({ code: 0, tenant_access_token: 't_cached', expire: 7200 });
  try {
    const t1 = await getFeishuToken(app);
    const t2 = await getFeishuToken(app);
    const t3 = await getFeishuToken(app);
    assert.equal(t1, 't_cached');
    assert.equal(t2, 't_cached');
    assert.equal(t3, 't_cached');
    assert.equal(fetchMock.calls.length, 1, '缓存命中后不应再次调用 fetch');
  } finally {
    fetchMock.restore();
  }
});

test('getFeishuToken: 不同 appId 独立缓存', async () => {
  const appA = uniqApp('_iso_a');
  const appB = uniqApp('_iso_b');
  const fetchMock = mockFetch(({ opts }) => {
    const body = JSON.parse(opts.body);
    return {
      code: 0,
      tenant_access_token: `t_${body.app_id}`,
      expire: 7200,
    };
  });
  try {
    const tA = await getFeishuToken(appA);
    const tB = await getFeishuToken(appB);
    assert.equal(tA, `t_${appA.appId}`);
    assert.equal(tB, `t_${appB.appId}`);
    assert.equal(fetchMock.calls.length, 2, '不同 app 应分别 fetch');

    // 再次调用各自应走缓存
    const tA2 = await getFeishuToken(appA);
    const tB2 = await getFeishuToken(appB);
    assert.equal(tA2, tA);
    assert.equal(tB2, tB);
    assert.equal(fetchMock.calls.length, 2, '缓存命中后不应再次调用 fetch');
  } finally {
    fetchMock.restore();
  }
});

// ── getFeishuToken: 失败路径 ──────────────────────────────────────────────────

test('getFeishuToken: code !== 0 返回 null', async () => {
  const app = uniqApp('_codefail');
  const fetchMock = mockFetch({ code: 99991663, msg: 'invalid app_id' });
  try {
    const token = await getFeishuToken(app);
    assert.equal(token, null);
  } finally {
    fetchMock.restore();
  }
});

test('getFeishuToken: fetch 抛异常返回 null（不 crash）', async () => {
  const app = uniqApp('_throwfail');
  const fetchMock = mockFetch(new Error('ECONNREFUSED'));
  try {
    const token = await getFeishuToken(app);
    assert.equal(token, null, '异常时应返回 null');
  } finally {
    fetchMock.restore();
  }
});

test('getFeishuToken: fetch 失败后不缓存（下次会重试）', async () => {
  const app = uniqApp('_retry');
  let callCount = 0;
  const fetchMock = mockFetch(() => {
    callCount++;
    if (callCount === 1) return { code: 99991663, msg: 'temp fail' };
    return { code: 0, tenant_access_token: 't_retry', expire: 7200 };
  });
  try {
    const t1 = await getFeishuToken(app);
    assert.equal(t1, null);
    const t2 = await getFeishuToken(app);
    assert.equal(t2, 't_retry', '失败后应重试而非缓存 null');
    assert.equal(fetchMock.calls.length, 2);
  } finally {
    fetchMock.restore();
  }
});

// ── getFeishuToken: 过期刷新 ──────────────────────────────────────────────────

test('getFeishuToken: expire 小于 60 秒时已过期，下次重新 fetch', async () => {
  const app = uniqApp('_expire');
  let callCount = 0;
  const fetchMock = mockFetch(() => {
    callCount++;
    // expire=30 → expiry = now + (30-60)*1000 = 30 秒前 → 缓存已过期
    return { code: 0, tenant_access_token: `t_${callCount}`, expire: 30 };
  });
  try {
    const t1 = await getFeishuToken(app);
    const t2 = await getFeishuToken(app);
    assert.equal(t1, 't_1');
    assert.equal(t2, 't_2', 'expiry < now+60s 时应重新 fetch');
    assert.equal(fetchMock.calls.length, 2);
  } finally {
    fetchMock.restore();
  }
});

test('getFeishuToken: expire 足够长时命中缓存', async () => {
  const app = uniqApp('_freshcache');
  const fetchMock = mockFetch({ code: 0, tenant_access_token: 't_fresh', expire: 7200 });
  try {
    const t1 = await getFeishuToken(app);
    const t2 = await getFeishuToken(app);
    assert.equal(t1, 't_fresh');
    assert.equal(t2, 't_fresh');
    assert.equal(fetchMock.calls.length, 1, 'expire=7200 秒时应命中缓存');
  } finally {
    fetchMock.restore();
  }
});

// ── 请求体格式 ────────────────────────────────────────────────────────────────

test('getFeishuToken: POST body 只包含 app_id 和 app_secret', async () => {
  const app = uniqApp('_body');
  const fetchMock = mockFetch({ code: 0, tenant_access_token: 't', expire: 7200 });
  try {
    await getFeishuToken(app);
    const body = JSON.parse(fetchMock.calls[0].opts.body);
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ['app_id', 'app_secret']);
  } finally {
    fetchMock.restore();
  }
});
