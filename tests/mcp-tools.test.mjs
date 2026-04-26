import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createMcpTools } from '../lib/mcp-tools.mjs';

function createMockWs(readyState = 1) {
  const sent = [];
  let closed = 0;
  return {
    readyState,
    send(data) {
      sent.push(JSON.parse(data));
    },
    close() {
      closed += 1;
      this.readyState = 3;
    },
    _sent: sent,
    _getClosedCount: () => closed,
  };
}

function createHarness(options = {}) {
  const state = {
    sessionName: 'alpha',
    hubHost: '127.0.0.1',
    hubPort: 8765,
    ws: createMockWs(1),
    pendingOutgoingCount: 2,
    ...(options.state ?? {}),
  };

  const calls = {
    httpGet: [],
    httpPost: [],
    httpPatch: [],
    wsSend: [],
    spawnSession: [],
    disconnectWs: 0,
    reconnect: 0,
    stderr: [],
  };

  const impl = options.impl ?? {};
  const ctx = {
    getSessionName: () => state.sessionName,
    setSessionName: (name) => {
      state.sessionName = name;
    },
    getHubHost: () => state.hubHost,
    setHubHost: (host) => {
      state.hubHost = host;
    },
    getHubPort: () => state.hubPort,
    setHubPort: (port) => {
      state.hubPort = port;
    },
    getWs: () => state.ws,
    disconnectWs: () => {
      calls.disconnectWs += 1;
      if (state.ws?.close) state.ws.close();
      state.ws = null;
    },
    reconnect: () => {
      calls.reconnect += 1;
    },
    getPendingOutgoingCount: () => state.pendingOutgoingCount,
    wsSend: (payload) => {
      calls.wsSend.push(payload);
      if (impl.wsSend) return impl.wsSend(payload, { state, calls });
      return true;
    },
    httpGet: async (url) => {
      calls.httpGet.push(url);
      if (impl.httpGet) return impl.httpGet(url, { state, calls });
      return { sessions: [] };
    },
    httpPost: async (url, body) => {
      calls.httpPost.push({ url, body });
      if (impl.httpPost) return impl.httpPost(url, body, { state, calls });
      return { accepted: true, id: 'hub-msg-1', online: true, buffered: false };
    },
    httpPatch: async (url, body) => {
      calls.httpPatch.push({ url, body });
      if (impl.httpPatch) return impl.httpPatch(url, body, { state, calls });
      return { ok: true };
    },
    spawnSession: async (params) => {
      calls.spawnSession.push(params);
      if (impl.spawnSession) return impl.spawnSession(params, { state, calls });
      return {
        name: params.name,
        mode: params.interactive ? 'interactive' : 'background',
        status: 'spawned',
      };
    },
    stderrLog: (message) => {
      calls.stderr.push(message);
      if (impl.stderrLog) impl.stderrLog(message, { state, calls });
    },
  };

  return {
    state,
    calls,
    tools: createMcpTools(ctx),
  };
}

function getText(result) {
  return result.content[0].text;
}

function getJson(result) {
  return JSON.parse(getText(result));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function importMcpServerModule() {
  const moduleUrl = new URL('../mcp-server.mjs', import.meta.url);
  return import(`${moduleUrl.href}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test('listTools: 暴露 14 个 MCP 工具', () => {
  const { tools } = createHarness();
  const result = tools.listTools();

  assert.equal(result.tools.length, 14);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [
      'ipc_send',
      'ipc_sessions',
      'ipc_whoami',
      'ipc_subscribe',
      'ipc_spawn',
      'ipc_rename',
      'ipc_reclaim_my_name',
      'ipc_reconnect',
      'ipc_task',
      'ipc_recent_messages',
      'ipc_recall',
      'ipc_observation_detail',
      'ipc_register_session',
      'ipc_update_session',
    ],
  );
});

test('ipc_spawn schema: 暴露 cwd 参数', () => {
  const { tools } = createHarness();
  const spawnTool = tools.listTools().tools.find((tool) => tool.name === 'ipc_spawn');

  assert.equal(spawnTool.inputSchema.properties.cwd.type, 'string');
});

test('ipc_send: 缺少参数时返回错误', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_send', { to: 'beta' });

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'ipc_send requires "to" and "content"');
});

test('ipc_send: WebSocket 已连接时发送标准消息', async () => {
  const { tools, state, calls } = createHarness();
  const result = await tools.handleToolCall('ipc_send', {
    to: 'beta',
    content: 'hello',
    topic: 'build',
  });
  const payload = state.ws._sent[0];

  assert.equal(result.isError, undefined);
  assert.equal(calls.httpPost.length, 0);
  assert.equal(payload.type, 'message');
  assert.equal(payload.from, 'alpha');
  assert.equal(payload.to, 'beta');
  assert.equal(payload.content, 'hello');
  assert.equal(payload.topic, 'build');
  assert.match(payload.id, /^msg_/);
  assert.equal(typeof payload.ts, 'number');
  assert.deepEqual(getJson(result), { sent: true, id: payload.id, via: 'ws' });
});

test('ipc_send: 非字符串内容会被转成字符串', async () => {
  const { tools, state } = createHarness();
  await tools.handleToolCall('ipc_send', { to: 'beta', content: 42 });

  assert.equal(state.ws._sent[0].content, '42');
});

test('ipc_send: WebSocket 未连接时回退 HTTP /send', async () => {
  const { tools, calls } = createHarness({
    state: { ws: createMockWs(3) },
  });
  const result = await tools.handleToolCall('ipc_send', {
    to: 'beta',
    content: 'fallback',
    topic: 'ops',
  });

  assert.equal(calls.httpPost.length, 1);
  assert.deepEqual(calls.httpPost[0], {
    url: 'http://127.0.0.1:8765/send',
    body: { from: 'alpha', to: 'beta', content: 'fallback' },
  });
  assert.deepEqual(getJson(result), {
    accepted: true,
    id: 'hub-msg-1',
    via: 'http',
    online: true,
    buffered: false,
  });
});

test('ipc_send: HTTP fallback 失败时返回 isError', async () => {
  const { tools } = createHarness({
    state: { ws: null },
    impl: {
      httpPost: async () => {
        throw new Error('network down');
      },
    },
  });
  const result = await tools.handleToolCall('ipc_send', { to: 'beta', content: 'hello' });

  assert.equal(result.isError, true);
  assert.deepEqual(getJson(result), {
    delivered: false,
    error: 'network down',
    via: 'http_failed',
  });
});

test('ipc_sessions: 调用 /health 并解析 sessions', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => ({
        sessions: [{ name: 'alpha' }, { name: 'beta' }],
      }),
    },
  });
  const result = await tools.handleToolCall('ipc_sessions');

  assert.deepEqual(calls.httpGet, ['http://127.0.0.1:8765/health']);
  assert.deepEqual(getJson(result), [{ name: 'alpha' }, { name: 'beta' }]);
});

test('ipc_sessions: sessions 缺失时返回空数组', async () => {
  const { tools } = createHarness({
    impl: {
      httpGet: async () => ({ ok: true }),
    },
  });
  const result = await tools.handleToolCall('ipc_sessions');

  assert.deepEqual(getJson(result), []);
});

test('ipc_sessions: 失败时记录 stderr 并返回错误', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => {
        throw new Error('hub unavailable');
      },
    },
  });
  const result = await tools.handleToolCall('ipc_sessions');

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'Failed to fetch sessions: hub unavailable');
  assert.equal(calls.stderr.length, 1);
  assert.match(calls.stderr[0], /ipc_sessions error: hub unavailable/);
});

test('ipc_whoami: 返回当前 session 名和连接信息', async () => {
  const { tools } = createHarness({
    state: {
      sessionName: 'worker-a',
      hubHost: 'hub.local',
      hubPort: 9000,
      pendingOutgoingCount: 5,
      ws: createMockWs(3),
    },
  });
  const result = await tools.handleToolCall('ipc_whoami');

  assert.deepEqual(getJson(result), {
    name: 'worker-a',
    hub_connected: false,
    hub: 'hub.local:9000',
    pending_outgoing: 5,
  });
});

test('ipc_subscribe: 缺参数时报错', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_subscribe', { topic: 'build' });

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'ipc_subscribe requires "topic" and "action"');
});

test('ipc_subscribe: 非法 action 报错', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_subscribe', { topic: 'build', action: 'join' });

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'action must be "subscribe" or "unsubscribe"');
});

test('ipc_subscribe: WebSocket 未连接时返回错误', async () => {
  const { tools } = createHarness({
    state: { ws: null },
  });
  const result = await tools.handleToolCall('ipc_subscribe', {
    topic: 'build',
    action: 'subscribe',
  });

  assert.equal(result.isError, true);
  assert.deepEqual(getJson(result), { ok: false, error: 'hub not connected' });
});

test('ipc_subscribe: 通过 wsSend 发送 subscribe 指令', async () => {
  const { tools, calls } = createHarness();
  const result = await tools.handleToolCall('ipc_subscribe', {
    topic: 'build',
    action: 'subscribe',
  });

  assert.deepEqual(calls.wsSend, [{ type: 'subscribe', topic: 'build' }]);
  assert.deepEqual(getJson(result), { action: 'subscribe', topic: 'build', ok: true });
});

test('ipc_spawn: 缺少 name 或 task 时报错', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_spawn', { name: 'worker-b' });

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'ipc_spawn requires "name" and "task"');
});

test('ipc_spawn: 非法 session 名被拒绝', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_spawn', { name: 'bad name', task: 'run' });

  assert.equal(result.isError, true);
  assert.equal(
    getText(result),
    'Invalid session name "bad name": only letters, numbers, underscore and hyphen allowed',
  );
});

test('ipc_spawn: 已存在的 session 名会报错', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async (url) => {
        assert.equal(url, 'http://127.0.0.1:8765/sessions');
        return [{ name: 'worker-b' }];
      },
    },
  });
  const result = await tools.handleToolCall('ipc_spawn', { name: 'worker-b', task: 'run' });

  assert.equal(result.isError, true);
  assert.equal(calls.spawnSession.length, 0);
  assert.equal(
    getText(result),
    'Session "worker-b" is already online. Use a different name or wait for it to disconnect.',
  );
});

test('ipc_spawn: 未传 cwd 时调用 spawnSession 并透传 interactive/model', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => [],
    },
  });
  const result = await tools.handleToolCall('ipc_spawn', {
    name: 'worker-b',
    task: 'solve bug',
    interactive: true,
    model: 'claude-sonnet-4-6',
  });

  assert.deepEqual(calls.spawnSession, [
    {
      name: 'worker-b',
      task: 'solve bug',
      interactive: true,
      model: 'claude-sonnet-4-6',
      cwd: undefined,
    },
  ]);
  assert.equal(calls.spawnSession[0].cwd, undefined);
  assert.deepEqual(getJson(result), {
    name: 'worker-b',
    mode: 'interactive',
    status: 'spawned',
  });
});

test('ipc_spawn: 传 cwd 时透传给 spawnSession', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => [],
    },
  });

  await tools.handleToolCall('ipc_spawn', {
    name: 'worker-b',
    task: 'resume handover',
    cwd: '/foo',
  });

  assert.equal(calls.spawnSession.length, 1);
  assert.equal(calls.spawnSession[0].cwd, '/foo');
});

test('ipc_spawn: 显式 host=wt 时透传给 spawnSession', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => [],
    },
  });

  await tools.handleToolCall('ipc_spawn', {
    name: 'worker-b',
    task: 'resume handover',
    host: 'wt',
  });

  assert.deepEqual(calls.spawnSession, [
    {
      name: 'worker-b',
      task: 'resume handover',
      interactive: false,
      model: undefined,
      host: 'wt',
      cwd: undefined,
    },
  ]);
});

test('ipc_spawn: host=external dryRun 返回修正后的 spawn-fallback IPC content', async () => {
  const sandbox = mkdtempSync(join(os.tmpdir(), 'ipc-spawn-fallback-'));
  const originalCwd = process.cwd();
  const configPath = join(sandbox, '.mcp.json');

  try {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            ipc: {
              env: {
                IPC_AUTH_TOKEN: '0123456789abcdef-token',
              },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    process.chdir(sandbox);

    const { spawnSession } = await importMcpServerModule();
    const { tools } = createHarness({
      impl: {
        httpGet: async () => [],
        spawnSession: async (params) => spawnSession({ ...params, dryRun: true }),
      },
    });

    const result = await tools.handleToolCall('ipc_spawn', {
      name: 'worker-b',
      task: 'resume handover',
      host: 'external',
    });
    const payload = getJson(result);

    assert.equal(payload.host, 'external');
    assert.equal(payload.dryRun, true);
    assert.match(
      payload.ipc_content,
      /cmdline: "C:\\Users\\jolen\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude\.exe" --dangerously-skip-permissions --dangerously-load-development-channels server:ipc/,
    );
    assert.doesNotMatch(payload.ipc_content, /--session-name/);
    assert.doesNotMatch(payload.ipc_content, /--resume/);
    assert.match(
      payload.ipc_content,
      new RegExp(`cwd: ${escapeRegex(sandbox.replace(/\\/g, '/'))}`),
    );
    assert.match(
      payload.ipc_content,
      /env: IPC_NAME=worker-b IPC_AUTH_TOKEN=0123456789\.\.\. \(完整 token 从 cwd \.mcp\.json 读\)/,
    );
    assert.match(payload.ipc_content, /task_hint: resume handover/);
    assert.match(payload.ipc_content, /post_spawn_action: 新 session 冷启清单 step 3 ipc_whoami/);
  } finally {
    process.chdir(originalCwd);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test(
  'ipc_spawn: host=wt dryRun 返回 cmd /c start 包装后的 command_hint',
  { skip: process.platform !== 'win32' },
  async () => {
    const sandbox = mkdtempSync(join(os.tmpdir(), 'ipc-spawn-wt-'));

    try {
      const { spawnSession } = await importMcpServerModule();
      const { tools } = createHarness({
        impl: {
          httpGet: async () => [],
          spawnSession: async (params) => spawnSession({ ...params, dryRun: true }),
        },
      });

      const result = await tools.handleToolCall('ipc_spawn', {
        name: 'worker-b',
        task: 'resume handover',
        host: 'wt',
        cwd: sandbox,
        model: 'opus',
      });
      const payload = getJson(result);
      const normalizedSandbox = sandbox.replace(/\\/g, '/');

      assert.equal(payload.host, 'wt');
      assert.equal(payload.dryRun, true);
      assert.equal(payload.cwd, normalizedSandbox);
      assert.match(
        payload.command_hint,
        /^wt\.exe new-tab --title worker-b --starting-directory /,
      );
      assert.match(
        payload.command_hint,
        new RegExp(`--starting-directory ${escapeRegex(sandbox)}`),
      );
      assert.match(
        payload.command_hint,
        / -- cmd \/k set IPC_NAME=worker-b && "C:\\Users\\jolen\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude\.exe" --dangerously-skip-permissions --dangerously-load-development-channels server:ipc --model opus$/,
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
);

test('ipc_spawn: host=vscode-terminal 也会透传给 spawnSession', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => [],
    },
  });

  await tools.handleToolCall('ipc_spawn', {
    name: 'worker-b',
    task: 'open terminal',
    host: 'vscode-terminal',
  });

  assert.equal(calls.spawnSession[0].host, 'vscode-terminal');
});

test('ipc_spawn: 非法 host 会被拒绝', async () => {
  const { tools, calls } = createHarness();
  const result = await tools.handleToolCall('ipc_spawn', {
    name: 'worker-b',
    task: 'run',
    host: 'tmux',
  });

  assert.equal(result.isError, true);
  assert.equal(calls.spawnSession.length, 0);
  assert.equal(
    getText(result),
    'Invalid host "tmux": must be one of wt, vscode-terminal, external, vscode-uri',
  );
});

test('ipc_rename: 更新 session 名并触发断开重连', async () => {
  const { tools, state, calls } = createHarness();
  const result = await tools.handleToolCall('ipc_rename', { name: 'worker-renamed' });

  assert.equal(state.sessionName, 'worker-renamed');
  assert.equal(calls.disconnectWs, 1);
  assert.equal(calls.reconnect, 1);
  assert.equal(calls.stderr.length, 1);
  assert.match(calls.stderr[0], /renamed: alpha/);
  assert.deepEqual(getJson(result), {
    renamed: true,
    from: 'alpha',
    to: 'worker-renamed',
  });
});

test('ipc_reclaim_my_name: 调用 Hub /reclaim-name 返回结果', async () => {
  const { tools } = createHarness({
    state: {
      hubHost: '127.0.0.1',
      hubPort: 8765,
    },
  });
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      async json() {
        return { ok: true, evicted: true };
      },
    };
  };

  try {
    const result = await tools.handleToolCall('ipc_reclaim_my_name', { name: 'alpha' });

    assert.deepEqual(fetchCalls, [
      {
        url: 'http://127.0.0.1:8765/reclaim-name',
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'alpha' }),
        },
      },
    ]);
    assert.equal(getText(result), JSON.stringify({ ok: true, evicted: true }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ipc_reconnect: 缺 host 和 port 时返回错误', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_reconnect', {});

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'ipc_reconnect requires at least one of "host" or "port"');
});

test('ipc_reconnect: 更新 host/port 并触发断开重连', async () => {
  const { tools, state, calls } = createHarness();
  const result = await tools.handleToolCall('ipc_reconnect', { host: '10.0.0.8', port: 9900 });

  assert.equal(state.hubHost, '10.0.0.8');
  assert.equal(state.hubPort, 9900);
  assert.equal(calls.disconnectWs, 1);
  assert.equal(calls.reconnect, 1);
  assert.deepEqual(getJson(result), {
    reconnecting: true,
    from: '127.0.0.1:8765',
    to: '10.0.0.8:9900',
    session: 'alpha',
  });
});

test('ipc_task create: 缺少 to/title 时报错', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_task', { action: 'create', to: 'worker-b' });

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'ipc_task create requires "to" and "title"');
});

test('ipc_task create: 调用 /task 并使用默认 priority', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpPost: async () => ({ taskId: 'task-1', ok: true }),
    },
  });
  const result = await tools.handleToolCall('ipc_task', {
    action: 'create',
    to: 'worker-b',
    title: '修复队列',
  });

  assert.deepEqual(calls.httpPost, [
    {
      url: 'http://127.0.0.1:8765/task',
      body: {
        from: 'alpha',
        to: 'worker-b',
        title: '修复队列',
        description: '',
        priority: 3,
      },
    },
  ]);
  assert.deepEqual(getJson(result), { taskId: 'task-1', ok: true });
});

test('ipc_task update: 缺少 taskId/status 时报错', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_task', { action: 'update', taskId: 'task-1' });

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'ipc_task update requires "taskId" and "status"');
});

test('ipc_task update: 调用 PATCH /tasks/{id}', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpPatch: async () => ({ ok: true, status: 'completed' }),
    },
  });
  const result = await tools.handleToolCall('ipc_task', {
    action: 'update',
    taskId: 'task 1',
    status: 'completed',
  });

  assert.deepEqual(calls.httpPatch, [
    {
      url: 'http://127.0.0.1:8765/tasks/task%201',
      body: { status: 'completed' },
    },
  ]);
  assert.deepEqual(getJson(result), { ok: true, status: 'completed' });
});

test('ipc_task list: 构造查询参数并透传结果', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => ({ tasks: [{ id: 'task-1' }] }),
    },
  });
  const result = await tools.handleToolCall('ipc_task', {
    action: 'list',
    agent: 'worker-b',
    filterStatus: 'started',
    limit: 10,
  });

  assert.deepEqual(calls.httpGet, [
    'http://127.0.0.1:8765/tasks?agent=worker-b&status=started&limit=10',
  ]);
  assert.deepEqual(getJson(result), { tasks: [{ id: 'task-1' }] });
});

test('ipc_task: 未知 action 返回错误', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('ipc_task', { action: 'close' });

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'Unknown action: close');
});

test('ipc_recent_messages: 使用当前 session 和默认参数请求 recent backlog', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => ({
        ok: true,
        since: 21600000,
        limit: 50,
        messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
      }),
    },
  });
  const result = await tools.handleToolCall('ipc_recent_messages', {});

  assert.deepEqual(calls.httpGet, [
    'http://127.0.0.1:8765/recent-messages?name=alpha&since=21600000&limit=50',
  ]);
  assert.deepEqual(getJson(result), {
    messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
    count: 2,
    since: 21600000,
    limit: 50,
  });
});

test('ipc_recent_messages: 透传 name/since/limit 到 HTTP 端点', async () => {
  const { tools, calls } = createHarness({
    impl: {
      httpGet: async () => ({
        ok: true,
        since: 5000,
        limit: 20,
        messages: [{ id: 'msg-3' }],
      }),
    },
  });
  const result = await tools.handleToolCall('ipc_recent_messages', {
    name: 'worker-b',
    since: 5000,
    limit: 20,
  });

  assert.deepEqual(calls.httpGet, [
    'http://127.0.0.1:8765/recent-messages?name=worker-b&since=5000&limit=20',
  ]);
  assert.deepEqual(getJson(result), {
    messages: [{ id: 'msg-3' }],
    count: 1,
    since: 5000,
    limit: 20,
  });
});

test('ipc_recent_messages: HTTP 失败时返回 error result', async () => {
  const { tools } = createHarness({
    impl: {
      httpGet: async () => {
        throw new Error('hub unavailable');
      },
    },
  });
  const result = await tools.handleToolCall('ipc_recent_messages', {});

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'Failed to fetch recent messages: hub unavailable');
});

test('handleToolCall: 未知工具返回错误', async () => {
  const { tools } = createHarness();
  const result = await tools.handleToolCall('unknown_tool', {});

  assert.equal(result.isError, true);
  assert.equal(getText(result), 'Unknown tool: unknown_tool');
});
