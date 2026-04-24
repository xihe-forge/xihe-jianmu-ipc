# ADR-004: Harness Self-Handover + Host-Aware Spawn

- 日期：2026-04-19
- 状态：Accepted
- 关联：ADR-002、ADR-007

## Context

`harness` 是 portfolio 级协调 session。它一旦 context 用尽、卡死或进程崩溃，portfolio 会直接断流。B5 需要把 watchdog、handover 生成器和 `ipc_spawn(host)` 串成一条自动恢复链，同时避免递归自拉起雪崩。

2026-04-20 01:09 发生一次冷启误判事故：`jianmu-pm` 重启 watchdog daemon 后，watchdog 在没有任何本轮 heartbeat / pong 历史的前提下，第一轮 probe 直接读取到几十分钟前的旧消息，误判 `silent-confirmed` 并触发 `triggerHarnessSelfHandover()`，留下孤儿 HANDOVER commit `0fad0af`。这说明 watchdog 冷启期必须和“已确认 harness 存活”的正常判定期分开处理。

2026-04-20 凌晨 smoke 的 02:51 / 03:08 / 03:14 三条路径又暴露出两层补洞需求：

1. `degraded` 是中间风险态，不是 handover 触发态；只有真正进入 `down` 才允许自动 self-handover，否则 cold-start grace 与 context-critical-no-action 都会被绕过
2. watchdog / smoke wrapper 重启后，Hub inbox 回放的历史 `harness-heartbeat` 即使 topic 合法，也可能携带几分钟前的旧 `ts`；state machine 必须做鲜度过滤，不能无条件吞入

## Decision

1. watchdog 扩成 5 路探测：`cliProxy / hub / anthropic / dns / harness`
2. `harness` 状态与外部网络状态分离，使用独立 `createHarnessStateMachine()`
3. watchdog 订阅 topic `harness-heartbeat`，解析格式：
   `【harness <ISO-ts> · context-pct】<N>% | state=... | next_action=...`
4. `createHarnessStateMachine()` 增加 cold-start grace：watchdog 启动后默认前 2 分钟内，如尚未收到本轮 heartbeat / pong / probe-ok 活性信号，则任何原本要进入 `down` 的判断一律降级为 `degraded`，并记录 `held-by-grace: ...` reason；`WATCHDOG_COLD_START_GRACE_MS` 可覆盖该时长，测试可传 `0` 关闭
5. 只有 `down` 态会触发 `triggerHarnessSelfHandover()`；`degraded`（包括 `context-critical-no-action` 与 `held-by-grace:*`）只记录风险，不允许直接 self-handover
6. `createHarnessStateMachine().ingestHeartbeat()` 必须校验 heartbeat `ts`：
   - 若 `ts < startedAt - 60s`，视为历史消息并返回 `stale-heartbeat`
   - 若 `ts` 解析失败（`null` / `NaN` / 非法格式），返回 `invalid-ts-format`
   - 这两类 heartbeat 都不会 mark alive，也不会驱动 transition
7. `triggerHarnessSelfHandover()` 读取 checkpoint / STATUS / lastBreath，生成 HANDOVER v2；dry-run 只返回 `handoverContent + handoverFilename` 做 inline preview，不落盘、不 commit、不 push、不 spawn
8. `lib/lineage.mjs` 记录 handover 链深度与滑动窗口次数；超过阈值直接熔断
9. `ipc_spawn` 增加 `host` 参数：
   - `wt`: Win32 上通过 Windows Terminal 新 tab 拉起
   - `vscode-terminal`: 预留，当前返回 not implemented
   - `external`: 走 `spawn-fallback` IPC 给 tech-worker
   - canonical spawn cmdline 为 `"C:\Users\jolen\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`，session 名通过 `IPC_NAME` env 传递，不使用 `--session-name` / `--resume`
10. spawn cwd 契约改为调用方显式传 `cwd`；未传时 `spawnSession()` 兼容回退到 `process.cwd()`。`triggerHarnessSelfHandover()` 必须传 `handoverRepoPath`，确保 `wt --starting-directory` 指向 `xihe-tianshu-harness`

## Consequences

- `harness` 失联后，watchdog 能自动生成可审计的 HANDOVER 文档，而不是仅靠内存态恢复
- watchdog 冷启时先建立“本轮见过活性信号”的基线，再放开 silent-confirmed 判定，避免再次复现 2026-04-20 01:09 的孤儿 HANDOVER 事故
- Hub inbox 继承导致的历史 heartbeat 回放，现由 `ts` 鲜度过滤兜住；watchdog / smoke wrapper 重启不再把旧 critical heartbeat 当成本轮 hard-signal
- dry-run 改成 inline preview，不再污染真实 `handover/` 工作树；smoke 可以真正隔离文件副作用
- `GET /status` 现在同时暴露网络探测与 `harness` 探测快照，联调定位更快
- `ipc_spawn(host)` 让今晚 demo 的 `host=wt` 真拉起与 `host=external` fallback 两条路径都有明确契约
- `ipc_spawn(host, cwd)` 让新 tab 的 `.mcp.json` 查找根目录由调用方决定，避免 mcp-server 自身 cwd 污染启动目录
