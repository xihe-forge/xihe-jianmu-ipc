# ADR-004: Harness Self-Handover + Host-Aware Spawn

- 日期：2026-04-19
- 状态：Accepted
- 关联：ADR-002、ADR-007

## Context

`harness` 是 portfolio 级协调 session。它一旦 context 用尽、卡死或进程崩溃，portfolio 会直接断流。B5 需要把 watchdog、handover 生成器和 `ipc_spawn(host)` 串成一条自动恢复链，同时避免递归自拉起雪崩。

## Decision

1. watchdog 扩成 5 路探测：`cliProxy / hub / anthropic / dns / harness`
2. `harness` 状态与外部网络状态分离，使用独立 `createHarnessStateMachine()`
3. watchdog 订阅 topic `harness-heartbeat`，解析格式：
   `【harness <ISO-ts> · context-pct】<N>% | state=... | next_action=...`
4. `hard-signal`、`soft-A/soft-B`、`warn-without-compact` 等状态触发 `triggerHarnessSelfHandover()`
5. `triggerHarnessSelfHandover()` 读取 checkpoint / STATUS / lastBreath，生成 HANDOVER v2，并在非 dry-run 下提交到 `xihe-tianshu-harness`
6. `lib/lineage.mjs` 记录 handover 链深度与滑动窗口次数；超过阈值直接熔断
7. `ipc_spawn` 增加 `host` 参数：
   - `wt`: Win32 上通过 Windows Terminal 新 tab 拉起
   - `vscode-terminal`: 预留，当前返回 not implemented
   - `external`: 走 `spawn-fallback` IPC 给 tech-worker
   - canonical spawn cmdline 为 `"C:\Users\jolen\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`，session 名通过 `IPC_NAME` env 传递，不使用 `--session-name` / `--resume`
8. spawn cwd 契约改为调用方显式传 `cwd`；未传时 `spawnSession()` 兼容回退到 `process.cwd()`。`triggerHarnessSelfHandover()` 必须传 `handoverRepoPath`，确保 `wt --starting-directory` 指向 `xihe-tianshu-harness`

## Consequences

- `harness` 失联后，watchdog 能自动生成可审计的 HANDOVER 文档，而不是仅靠内存态恢复
- `GET /status` 现在同时暴露网络探测与 `harness` 探测快照，联调定位更快
- `ipc_spawn(host)` 让今晚 demo 的 `host=wt` 真拉起与 `host=external` fallback 两条路径都有明确契约
- `ipc_spawn(host, cwd)` 让新 tab 的 `.mcp.json` 查找根目录由调用方决定，避免 mcp-server 自身 cwd 污染启动目录
- 真实 gate `check.sh --only HANDOVER` 仍依赖 Context 引用与文件名模式，dry-run 需要兼容副本辅助验收
