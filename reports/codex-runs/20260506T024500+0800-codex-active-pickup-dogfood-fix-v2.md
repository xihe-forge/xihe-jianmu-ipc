# Codex active IPC pickup dogfood fix v2

ts: 2026-05-06T04:34:00+08:00
ship-tier: e2e-dogfood
EXIT: 0 after commit/push
main-fix-commit: 9c8eb10

## Summary

Codex 主动收 IPC 的真 root cause 不是单纯 prompt 弱，而是投递链路打到隐藏 `codex app-server` sidecar：`thread/inject_items` / `turn/steer` / `turn/start` 可以让 sidecar model 生成文本，但它不是用户正在看的 Codex TUI，且 sidecar 没有真实 session 的 `ipc_send` 工具上下文，导致“日志看似 push 成功、可见 Codex 不主动响应”。

本次修复改成 visible PTY bridge：`codex-title-wrapper.mjs` 给可见 Codex TUI 建 ready/queue/ack 文件，MCP 收到 IPC 后优先把 prompt 写进同一个 Codex PTY 并回车。隐藏 app-server 默认禁用，只保留 `IPC_CODEX_APP_SERVER_FALLBACK=1` 明确 opt-in。

同时修掉 Claude runtime=unknown 同根问题：`mcp-wrapper.mjs` 插入后，`mcp-server` 的直接父进程只剩 `node mcp-wrapper.mjs`；`resolveRuntime()` 现在向上扫祖先进程链，能看到 grandparent `claude.exe`。

## RCA

- 旧路径：Hub WS -> target MCP -> local hidden `codex app-server --listen stdio://` -> hidden thread inject/steer/start。
- 断点：App Server API 到达的是 hidden sidecar，不是 visible Codex TUI。此前 `codex_app_server_*_ok` 只能证明 sidecar 收到，不证明用户正在使用的 Codex session 收到。
- `lib/router.mjs` 也有同类风险：目标 session 带 `appServerThreadId` 时会优先打 Hub 侧 app-server。本次改为 Codex 在线时永远优先 WS，让目标 MCP/PTY 接管；app-server 只做 opt-in 离线兜底。
- `mcp-wrapper` 不改 IPC 消息格式；它影响的是 runtime detection，因为三档 fallback 只看直接父进程。

Codex CLI 版本：本机 `codex-cli 0.128.0`。官方 App Server 文档/0.128 release 能证明 app-server API 存在，但没有承诺 inject/steer 会渲染到已有 TUI；本次因此不再把 app-server 当 visible push 路径。

Sources:
- https://developers.openai.com/codex/app-server/
- https://github.com/openai/codex/releases/tag/rust-v0.128.0

## Patch

- `lib/codex-pty-bridge.mjs`
  - 新增 ready/queue/ack 协议。
  - `formatCodexPtyPrompt()` 生成 `← ipc:` 可见行 + `ipc_send` 回复指令。
- `bin/codex-title-wrapper.mjs`
  - 启动时写 ready marker。
  - watch queue，把 IPC prompt 写入 Codex PTY，再提交回车。
- `mcp-server.mjs`
  - Codex runtime 收到 IPC 后优先 `pushLocalCodexInboundViaPty()`。
  - hidden app-server fallback 默认关闭。
  - `resolveRuntime()` 改为扫描祖先进程链。
  - Codex launch/app-server 配置 pin `model_reasoning_effort="xhigh"`。
- `lib/router.mjs` / `hub.mjs`
  - Codex 在线 session 优先 WS，不再被 `appServerThreadId` 抢到 hidden sidecar。
  - app-server route 受 `IPC_CODEX_APP_SERVER_FALLBACK=1` 控制。
- `bin/install.ps1`
  - `ipcx` 通过 `codex-title-wrapper.mjs` 启动 Codex，并设置 `IPC_RUNTIME=codex`。

## Runtime detection evidence

当前 Hub 统计：

```json
{"counts":{"unknown":1,"claude":11,"codex":1},"unknown":["network-watchdog"]}
```

Claude sample process chain after fix:

```text
taiwei-reviewer pid=171948 runtime=claude
  node mcp-server.mjs
  node mcp-wrapper.mjs
  claude.exe --dangerously-skip-permissions --dangerously-load-development-channels server:ipc
  node claude-stdin-auto-accept.mjs ...
```

结论：原 8 个后起 Claude unknown 的假设成立；grandparent fallback 修复后，当前 live Claude sessions 均恢复 `runtime:"claude"`。剩余 `network-watchdog` 是普通 watchdog，不是 Claude runtime。

## Dogfood evidence

### Failed-before-fix evidence

旧路径可让 sidecar 产生回答，但没有真实 IPC reply：

```text
inbound msg: msg_1778008420265_64e5fa
marker: DOGFOOD-CODEX-PICKUP-20260506031340137
result: hidden sidecar generated ACK text, no Hub IPC reply from visible Codex session
```

### Successful real Codex PTY evidence

Real Codex TUI session:

```text
name: codex-ipc-dogfood-v4
runtime: codex
MCP pid: 178040
wrapper pid: 139896
appServerThreadId: null
trace: data/mcp-trace-codex-ipc-dogfood-v4.log
```

Send used direct HTTP `/send`, not `jianmu-pm` main chat:

```text
from: codex-dogfood-v4-driver-1778013144162
to: codex-ipc-dogfood-v4
marker: DOGFOODV41778013144162
inbound msg id: msg_1778013144194_abec49
reply msg id: msg_1778013153617_e259d5
reply content: ACK DOGFOODV41778013144162
elapsed: 10117ms
```

MCP trace:

```json
{"event":"ws_message_parsed","type":"message","from":"codex-dogfood-v4-driver-1778013144162","id":"msg_1778013144194_abec49","has_content":true}
{"event":"codex_pty_push_ok","msg_id":"msg_1778013144194_abec49","wrapper_pid":139896,"prompt_chars":532}
{"event":"ack_sent","msg_id":"msg_1778013144194_abec49","confirmed_by":"codex-ipc-dogfood-v4"}
```

PTY bridge ack:

```json
{"ok":true,"msgId":"msg_1778013144194_abec49","ipcName":"codex-ipc-dogfood-v4","wrapperPid":139896,"promptChars":532,"submitDelayMs":1000,"writeCount":2}
```

## Reload SOP

Codex sessions launched before this patch do not have `data/codex-pty-bridge/<name>/ready.json`; they cannot receive visible active pickup. Do not kill them blindly. Use graceful reload:

1. Ask the session to finish/park current work.
2. Re-open with `ipcx <name>` or `ipc_spawn(runtime="codex", host="wt")`.
3. Confirm `/sessions` shows `runtime:"codex"` and `appServerThreadId:null`.
4. Confirm `data/codex-pty-bridge/<name>/ready.json` is fresh and wrapper pid alive.
5. Send a direct `/send` dogfood IPC and require reply within 60s.

## Tests

```text
node tests/router.test.mjs
node tests/ipc-spawn-codex.test.mjs
node tests/codex-pty-bridge.test.mjs
node tests/runtime-detection.test.mjs
IPC_TEST_CONCURRENCY=1 node bin/run-tests.mjs tests
```

Result: all passed. Full top-level suite exit 0.
