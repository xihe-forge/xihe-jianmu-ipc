# operations.mjs 契约优先设计调研

## 结论摘要

- 建议做，但只做渐进式迁移，不做 big bang。
- 核心原因：HTTP API 和 MCP tools 已经在 `send`、`sessions`、`task` 上形成“事实上的共享契约”，但 schema 目前散落在 `lib/http-handlers.mjs`、`lib/mcp-tools.mjs`、`lib/protocol.mjs`、`lib/db.mjs`，已经出现 drift。
- ROI 评级：中。
- 试点 operation：`send_message`。

## 1. 现状盘点

### 1.1 Operation 重合面

| 逻辑 operation | HTTP 暴露 | MCP 暴露 | 现状判断 |
|---|---|---|---|
| `send_message` | `POST /send` | `ipc_send` | 明显重合 |
| `list_sessions` | `GET /sessions` | `ipc_sessions` | 明显重合，但 MCP 实际调用 `/health` |
| `health_status` | `GET /health` | 无 | HTTP-only，且内部重复序列化 session 列表 |
| `query_messages` | `GET /messages` | 无 | HTTP-only |
| `query_message_stats` | `GET /stats` | 无 | HTTP-only |
| `create_task` | `POST /task` | `ipc_task(action=create)` | 明显重合 |
| `list_tasks` | `GET /tasks` | `ipc_task(action=list)` | 明显重合 |
| `get_task` | `GET /tasks/:id` | 无 | HTTP-only |
| `update_task` | `PATCH /tasks/:id` | `ipc_task(action=update)` | 明显重合 |
| `feishu_reply` | `POST /feishu-reply` | 无 | HTTP-only |
| `topic_subscription` | 无 | `ipc_subscribe` | MCP-only |
| `session_whoami` | 无 | `ipc_whoami` | MCP-only |
| `spawn_session` | 无 | `ipc_spawn` | MCP-only |
| `rename_session` | 无 | `ipc_rename` | MCP-only |
| `reconnect_hub` | 无 | `ipc_reconnect` | MCP-only |

备注：

- `GET /`、`/dashboard`、`/dashboard/*` 属于静态文件服务，不建议纳入 operation registry。
- `ipc_task` 现在是一个复合工具，语义上其实对应 3 个 operation：`create_task`、`list_tasks`、`update_task`。

### 1.2 每个 operation 的输入/输出 schema

#### 1.2.1 Shared operations

| operation | 当前输入 schema | 当前输出 schema | schema 定义位置 |
|---|---|---|---|
| `send_message` | HTTP: body 至少要求 `{ from: string, to: string, content: any-non-null, topic?: string }`，且允许直接传完整 message 对象。MCP: `ipc_send` 的 `inputSchema` 为 `{ to: string, content: string, topic?: string }`。 | HTTP: `{ accepted: true, id: string, online: boolean, buffered: boolean }`。MCP: WS 成功返回 `{ sent: true, id: string, via: 'ws' }`；HTTP fallback 返回 `{ accepted, id, via: 'http', online, buffered }`；失败返回 `{ delivered: false, error, via: 'http_failed' }`。 | HTTP 校验/序列化在 `lib/http-handlers.mjs`；MCP `inputSchema` 和返回格式在 `lib/mcp-tools.mjs`；message 实体在 `lib/protocol.mjs#createMessage`。 |
| `list_sessions` | HTTP: 无输入。MCP: `ipc_sessions` 无输入。 | HTTP: `Array<{ name: string, connectedAt: number, topics: string[] }>`。MCP: 同 shape，但通过读取 `/health.sessions` 获得。 | HTTP 在 `lib/http-handlers.mjs`；MCP tool schema/执行在 `lib/mcp-tools.mjs`。 |
| `create_task` | HTTP: body 要求 `{ from: string, to: string, title: string, description?: string, priority?: number, deadline?: number|null, payload?: object|null }`。MCP: `ipc_task` 的 `create` 分支只暴露 `{ action: 'create', to: string, title: string, description?: string, priority?: number }`。 | HTTP/MCP 都返回 `{ ok: true, taskId: string, online: boolean, buffered: boolean }`。 | HTTP 在 `lib/http-handlers.mjs`；MCP `inputSchema` 和执行在 `lib/mcp-tools.mjs`；task 实体在 `lib/protocol.mjs#createTask`。 |
| `list_tasks` | HTTP: query `{ agent?: string, status?: string, limit?: number }`。MCP: `ipc_task` 的 `list` 分支暴露 `{ action: 'list', agent?: string, filterStatus?: string, limit?: number }`。 | HTTP/MCP 都返回 `{ tasks: TaskRow[], stats: Array<{ status: string, count: number }> }`。 | HTTP 在 `lib/http-handlers.mjs`；MCP 在 `lib/mcp-tools.mjs`；TaskRow 来自 `lib/db.mjs#listTasks` 和 `getTaskStats`。 |
| `update_task` | HTTP: path `:id` + body `{ status: 'pending'|'started'|'completed'|'failed'|'cancelled' }`。MCP: `ipc_task` 的 `update` 分支暴露 `{ action: 'update', taskId: string, status: 'started'|'completed'|'failed'|'cancelled' }`。 | HTTP/MCP 都返回 `{ ok: true, task: TaskRow }`。 | HTTP 在 `lib/http-handlers.mjs`；MCP 在 `lib/mcp-tools.mjs`；合法状态源头在 `lib/protocol.mjs#TASK_STATUSES`。 |

#### 1.2.2 HTTP-only operations

| operation | 当前输入 schema | 当前输出 schema | schema 定义位置 |
|---|---|---|---|
| `health_status` | 无输入。 | `{ ok: true, sessions: SessionSummary[], uptime: number, messageCount: number }` | `lib/http-handlers.mjs` |
| `query_messages` | query `{ from?: string, to?: string, peer?: string, limit?: number=50 }` | `MessageRow[]`，字段来自 SQLite `messages` 表：`{ id, type, from, to, content, content_type, topic, ts, status, created_at }`，返回前会 `redactSensitive` | 路由在 `lib/http-handlers.mjs`，行 shape 在 `lib/db.mjs#getMessages` |
| `query_message_stats` | query `{ hours?: number=24 }` | `{ period_hours: number, agents: Array<{ name: string, count: number }> }` | `lib/http-handlers.mjs` + `lib/db.mjs#getMessageCountByAgent` |
| `get_task` | path `:id` | `TaskRow`，字段来自 SQLite `tasks` 表：`{ id, from, to, title, description, status, priority, deadline, payload, ts, updated_at, completed_at }` | `lib/http-handlers.mjs` + `lib/db.mjs#getTask` |
| `feishu_reply` | body `{ app: string, content: string, from?: string, chatId?: string }` | 成功 `{ ok: true, app: string }`；失败 `{ ok: false, error: string }` 或 `{ error: string }` | `lib/http-handlers.mjs` |

#### 1.2.3 MCP-only operations

| operation | 当前输入 schema | 当前输出 schema | schema 定义位置 |
|---|---|---|---|
| `session_whoami` | 无输入 | `{ name: string, hub_connected: boolean, hub: string, pending_outgoing: number }` | `lib/mcp-tools.mjs` |
| `topic_subscription` | `{ topic: string, action: 'subscribe'|'unsubscribe' }` | 成功 `{ action, topic, ok: true }`；失败 `{ ok: false, error }` 或文本错误 | `lib/mcp-tools.mjs` |
| `spawn_session` | `{ name: string, task: string, interactive?: boolean, model?: string }` | 成功 `{ name, mode: 'interactive'|'background', status: 'spawned', pid?: number }`；失败为文本错误 | `lib/mcp-tools.mjs` + `mcp-server.mjs#spawnSession` |
| `rename_session` | `{ name: string }` | `{ renamed: true, from: string, to: string }` | `lib/mcp-tools.mjs` |
| `reconnect_hub` | `{ host?: string, port?: number }` | `{ reconnecting: true, from: string, to: string, session: string }` | `lib/mcp-tools.mjs` |

### 1.3 Schema 现在散落在哪里

当前没有单一 contract layer，schema 分布如下：

1. HTTP request schema 以“命令式 if/parse/默认值”的方式散落在 `lib/http-handlers.mjs`。
2. MCP request schema 只在 `lib/mcp-tools.mjs` 的 `MCP_TOOL_DEFINITIONS[*].inputSchema` 中声明，而且运行时又做了一次独立参数检查，形成“双写”。
3. 领域实体 schema 只在 `lib/protocol.mjs` 和 `lib/db.mjs` 中隐式存在：
   - `createMessage()` 和 `createTask()` 决定 in-memory object shape。
   - `getMessages()` / `getTask()` / `listTasks()` 决定 API response row shape。
4. MCP response schema 没有正式定义，只在 `handleToolCall()` 的 `toJsonResult()` / `toTextResult()` 里隐式存在。
5. HTTP auth、audit、payload limit、response status code 也都嵌在 handler 分支里，而不是 contract metadata。

### 1.4 已经出现的 drift

1. `ipc_send` 的 `inputSchema` 暴露了 `topic`，HTTP `/send` 也接收 `topic`，但 `ipc_send` 的 HTTP fallback 实际没有把 `topic` 传给 `/send`。
2. HTTP `POST /task` 支持 `deadline` 和 `payload`，但 `ipc_task create` 的 schema 和实现都没有暴露这两个字段。
3. HTTP `PATCH /tasks/:id` 接受 `pending|started|completed|failed|cancelled`，但 `ipc_task update` 的 enum 缺少 `pending`。
4. `ipc_sessions` 语义上是 `list_sessions`，但实现上依赖 `/health.sessions`，导致健康检查 response shape 和 sessions list 被意外耦合。
5. `/health` 与 `/sessions` 各自重复构造了一次 `SessionSummary[]`，没有共享 serializer。

这些 drift 说明问题不只是“文档不统一”，而是 contract 已经开始在行为层面分叉。

## 2. lib/operations.mjs 设计草案

### 2.1 设计目标

目标不是把所有东西都塞进一个巨大 switch，而是新增一个“operation contract layer”：

1. 用一个地方描述 operation 名称、说明、输入/输出 schema。
2. 允许同一 operation 暴露多个 transport。
3. 允许 transport 有自己的 projection/alias，但 canonical schema 只有一份。
4. 允许少数 operation 保留 transport-specific executor，例如 `ipc_send` 的 WS fast path、`ipc_reconnect` 的本地重连。
5. 保持纯 JS，不强依赖新增大依赖；phase 1 不建议引入完整 JSON Schema validator。

### 2.2 推荐的数据结构

```js
// lib/operations.mjs
export const OPERATIONS = [
  {
    name: 'send_message',
    description: 'Send a message to a session or broadcast target',
    schema: {
      input: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          content: { type: 'string' },
          topic: { type: 'string' },
        },
        required: ['to', 'content'],
      },
      output: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean' },
          id: { type: 'string' },
          online: { type: 'boolean' },
          buffered: { type: 'boolean' },
        },
        required: ['accepted', 'id', 'online', 'buffered'],
      },
    },
    handler: async ({ ctx, actor, input }) => {
      // canonical business semantics
    },
    transports: {
      http: {
        method: 'POST',
        path: '/send',
        source: 'body',
        maxBodyBytes: 1024 * 1024,
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            content: { type: 'string' },
            topic: { type: 'string' },
          },
          required: ['from', 'to', 'content'],
        },
        normalize: ({ body }) => ({
          actor: { name: body.from },
          input: { to: body.to, content: body.content, topic: body.topic ?? null },
        }),
        status: 200,
      },
      mcp: {
        tool: 'ipc_send',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            content: { type: 'string' },
            topic: { type: 'string' },
          },
          required: ['to', 'content'],
        },
        normalize: ({ args, sessionName }) => ({
          actor: { name: sessionName },
          input: { to: args.to, content: String(args.content), topic: args.topic ?? null },
        }),
        resultFormat: 'json-text',
        executeMode: 'local-or-http',
      },
    },
    auth: { http: 'required', mcp: 'session' },
    audit: {
      success: ({ actor, input, output }) => ({
        event: 'message_send',
        details: { from: actor.name, to: input.to, id: output.id },
      }),
    },
    redact: {
      auditInputFields: ['content'],
    },
  },
];
```

这个结构里最关键的是三层分离：

1. `schema.input/output` 是 canonical contract。
2. `transports.http/mcp.inputSchema` 是对外 projection，用来兼容已有外部 surface。
3. `normalize()` 把 transport 参数转成统一的 `{ actor, input }`。

### 2.3 Canonical operation 粒度建议

不要把“当前 transport 暴露方式”直接等同于 operation 粒度，建议把 registry 设计成原子 operation：

| 当前暴露 | 推荐 canonical operation |
|---|---|
| `POST /send` + `ipc_send` | `send_message` |
| `GET /sessions` + `ipc_sessions` | `list_sessions` |
| `GET /health` | `health_status`，内部可复用 `list_sessions` serializer |
| `POST /task` + `ipc_task(create)` | `create_task` |
| `GET /tasks` + `ipc_task(list)` | `list_tasks` |
| `PATCH /tasks/:id` + `ipc_task(update)` | `update_task` |
| `ipc_task` | 保留为 MCP alias/tool facade，内部 dispatch 到 3 个 canonical operation |

这样做有两个好处：

1. registry 不会被 `ipc_task` 这种“大 union schema”污染。
2. 以后如果要新增 `ipc_task get` 或 `ipc_messages`，只是在 transport 层暴露已有 operation。

### 2.4 HTTP handler 如何从 operation 派生

推荐保留 `createHttpHandler(ctx)` 入口，但内部不再手写大 if/else，而是：

1. 启动时把 `OPERATIONS` 编译成 route table。
2. route metadata 提供 `method`、`path`、`source(body/query/path)`、`maxBodyBytes`、`status`。
3. 通用 adapter 负责：
   - Body 读取和 `MAX_BODY` 限制。
   - `JSON.parse`。
   - query/path/body 参数提取。
   - 调用 `normalize()` 生成 `{ actor, input }`。
   - 执行 auth hook、handler、audit hook、response serialize。
4. 非 operation 路由继续保留手写：
   - `/`
   - `/dashboard`
   - `/dashboard/*`

建议保持现有 URL 和 status code 不变，只替换实现方式：

- `POST /send` 仍返回 `200`
- `POST /task` 仍返回 `201`
- `PATCH /tasks/:id` 仍返回 `200`
- `GET /tasks/:id` 的 `404` 仍保留

### 2.5 MCP tool 如何从 operation 派生

推荐保留 `createMcpTools(ctx)` 入口，但把 `tools` 和 `handleToolCall` 改成由 operation registry 驱动：

1. `listTools()` 从 `transports.mcp.tool` 自动生成 tool 列表。
2. `description` 和 `inputSchema` 直接来自 operation metadata。
3. `handleToolCall()` 的流程统一为：
   - 根据 tool name 找 operation。
   - 运行 `normalize({ args, sessionName, hubHost, hubPort })`。
   - 执行 operation handler 或 transport-specific executor。
   - 按 `resultFormat` 序列化成当前 MCP SDK 需要的 `content: [{ type: 'text', text: ... }]`。

这里要特别保留两类特殊能力：

1. `executeMode: 'local-or-http'`
   - 适合 `send_message`。
   - WS 已连接时走本地 fast path，断线时退回 HTTP proxy。
2. `executeMode: 'local'`
   - 适合 `topic_subscription`、`session_whoami`、`spawn_session`、`rename_session`、`reconnect_hub`。
   - 这些 operation 不需要 Hub HTTP endpoint，也不应该被硬拉成 server-side operation。

### 2.6 audit / redact / 认证接入点

推荐把这三类 concern 统一挂在 operation adapter 层，而不是继续散在具体分支里：

| concern | 建议接入点 | 说明 |
|---|---|---|
| `auth` | transport pre-hook | `http` 根据 `Authorization: Bearer` 和 `operation.auth.http` 决定；`mcp` 依赖已建立的 session，上层只传 `actor` |
| `audit` | transport around-hook | adapter 在 success / failure 后根据 `operation.audit` 生成事件；事件名可以兼容现有 `http_send`、`task_create` 等 |
| `redact` | audit 前 + response 前 | 先对 audit details 做脱敏，再写日志；对 `query_messages` 这种 response 继续保留 `db.mjs` 的 defense-in-depth |

建议原则：

1. `handler()` 不直接读 header、req、res、MCP request。
2. `handler()` 只接收 `ctx`、`actor`、`input`。
3. transport adapter 负责把外部协议细节映射进来。

## 3. ROI 评估

### 3.1 收益

1. 降低 schema 双边维护成本。
   - 当前 `send` 和 `task` 至少有 HTTP/MCP 两套输入定义，且返回值各自内嵌在不同分支里。
2. 降低 drift 风险。
   - `topic` 丢失、`deadline/payload` 缺失、`pending` enum 不一致都属于单一 contract 缺席的直接后果。
3. 降低新增 operation 的边际成本。
   - 有 registry 之后，新增“HTTP+MCP 双暴露”的 operation 不再需要复制 schema、复制验证、复制文档。
4. 文档可自动生成。
   - `CLAUDE.md`、README API 表格、MCP tool 列表都可以从 registry 生成，至少可以半自动校验。
5. 测试更容易做 contract 级 golden test。
   - 不再只测“某个 if 分支”，而是可以测“operation contract + transport projection”。

### 3.2 重构成本估算

按“渐进式 + 保持外部 contract 不变”估算：

- 生产代码：约 7-9 个文件，约 700-1000 行改动。
- 含测试与文档：约 11-13 个文件，约 1000-1400 行改动。

大概率会触及的文件：

1. `lib/http-handlers.mjs`
2. `lib/mcp-tools.mjs`
3. `mcp-server.mjs`
4. `hub.mjs`
5. `lib/protocol.mjs` 或新增 shared serializer/helper
6. 新增 `lib/operations.mjs`
7. 新增 `lib/operation-adapters/http.mjs`
8. 新增 `lib/operation-adapters/mcp.mjs`
9. `tests/mcp-tools.test.mjs`
10. `tests/integration/hub-api.test.mjs`
11. `tests/e2e/websocket.test.mjs`
12. `tests/mcp-server.test.mjs`

测试面上，当前测试总量是 347 个顶层 `test()`。其中直接耦合 HTTP/MCP 外部 surface 的大约 55 个：

- `tests/mcp-tools.test.mjs`：28
- `tests/integration/hub-api.test.mjs`：16
- `tests/e2e/websocket.test.mjs`：10
- `tests/mcp-server.test.mjs`：1

如果迁移保持公共行为不变，这 55 个测试多数是“需要回归执行”，不一定全部重写。真正需要改写的量更可能在 20-40 个之间，集中在 contract fixture 和 tool/route 注册方式变化上。

### 3.3 风险

| 风险 | 影响 | 规避建议 |
|---|---|---|
| MCP 协议兼容性 | 如果改动 `tool name`、`inputSchema`、结果包装格式，Claude Code / OpenClaw 侧会直接 break | tool 名保持不变；MCP 继续返回当前 `json-text`；alias 字段如 `filterStatus` 先保留 |
| 抽象过度 | `spawn/rename/reconnect/subscribe` 是 MCP 本地控制操作，强行做成统一 server-side handler 会让设计变形 | 允许 operation 有 `local` executor，不追求“所有 operation 都必须走同一个 runtime” |
| 迁移期双轨行为不一致 | 老分支和新 registry 同时存在时，容易再产生一层 drift | 每迁移一个 operation 就删掉对应旧分支；新增 contract parity test |
| 测试成本 | 直接相关的 55 个测试需要重点回归 | 先锁定 golden behavior，再迁移 |
| 运行时性能 | 多一层 dispatch/normalize/validate | 启动时预编译 route/tool map，不在请求路径上做线性扫描；phase 1 不引入重型 validator |

整体判断：

- 兼容性风险：中高。
- 实现复杂度：中。
- 性能风险：低。

## 4. 分阶段迁移方案

### Phase 0：先建 contract，不改外部行为

目标：

1. 新增 `lib/operations.mjs`，只定义 metadata，不接管执行。
2. 把现有 operation inventory 和 schema 先收拢成 registry。
3. 新增最小 contract test，验证：
   - tool name 不变
   - route path/method 不变
   - 关键 enum 不变

### Phase 1：试点 `send_message`

原因：

1. 同时覆盖 HTTP + MCP。
2. 输入/输出最简单。
3. 已有明确 drift（`topic` 在 fallback 路径丢失）。
4. 不需要先处理 path params、query alias、复合 action。

做法：

1. `POST /send` 改成 operation adapter。
2. `ipc_send` 改成由同一 contract 派生 tool schema。
3. 保留 MCP 的 WS fast path，只把 schema/normalize/output 统一。

### Phase 2：迁移 `list_sessions` + `task_*`

顺序建议：

1. `list_sessions`
   - 先让 `ipc_sessions` 改为代理 canonical `list_sessions`，不再依赖 `/health.sessions`。
2. `create_task`
3. `list_tasks`
4. `update_task`

注意点：

1. `ipc_task` 不要作为 canonical operation；它应该只是 MCP facade。
2. `deadline`、`payload`、`pending`、`filterStatus/status` alias 在这一阶段一次性收敛。

### Phase 3：补齐 HTTP-only query operations

迁移对象：

1. `health_status`
2. `query_messages`
3. `query_message_stats`
4. `get_task`
5. `feishu_reply`

说明：

- `health_status` 可以组合 `list_sessions` 的 serializer，但不一定要暴露成 MCP tool。
- `feishu_reply` 是 integration-heavy operation，可以放进 registry 做文档和 audit 统一，但优先级低于 shared operations。

### Phase 4：再决定是否纳入 MCP-only local ops

对象：

1. `session_whoami`
2. `topic_subscription`
3. `spawn_session`
4. `rename_session`
5. `reconnect_hub`

建议：

- 这些 operation 可以进入 registry 提升 discoverability 和文档自动化。
- 但它们不是这次重构的 ROI 核心，不应该阻塞 shared operations 落地。

### Phase 5：文档自动生成与清理

1. 用 registry 生成 `CLAUDE.md` 中的 MCP tool / HTTP API 列表。
2. 校验 README 中的工具表格是否一致。
3. 删除旧的重复 schema 分支和注释。

## 5. 推荐结论

### 推荐结论

推荐做，但范围要收敛为“shared contract first”：

1. 先解决 `send_message`、`list_sessions`、`task_*` 这几个真实发生双边维护的 operation。
2. 不要为了“纯粹”把静态文件服务和所有本地控制指令一起 big bang 重写。

### 推荐理由

这次重构的价值不在于“代码看起来更优雅”，而在于当前系统已经出现了 contract drift，而且 drift 恰好发生在最核心的共享业务面上：

- `send_message`
- `list_sessions`
- `task_create/list/update`

只要继续新增 operation，双边维护成本会继续上升。现在做渐进式 contract layer，收益明确，风险可控。

### 试点建议

首个试点选 `send_message`。

理由：

1. 共享面最清晰。
2. contract 最小。
3. 能最快验证 `operation registry + HTTP/MCP 双 adapter` 的设计是否顺手。
4. 一旦成功，后续 `task_*` 迁移模式基本就固定了。
