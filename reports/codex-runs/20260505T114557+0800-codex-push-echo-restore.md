# codex push echo restore

## Root cause

- K.I commit `0768f49` 原行为：idle wake `turnStart` input 要求模型把 IPC 用 `← ipc: [<时间> from: <发送方>] <内容>` 格式回显到 reply 第一行，然后正常处理。
- K.Y-1 commit `2577539` 反转了该行为，把 idle wake 文案改成 `无需主动 echo·已自动可见` / `user 已能看到 ← ipc 行`。
- 真因：codex CLI UI 不一定渲染 history inject，必须让模型在屏幕 reply 首行显式 echo。

## K.I original text

`上方 history 刚 inject 一条 IPC 消息（格式 `[IPC-INBOUND from <发送方>] <内容>`）。请你做两步：第一·把这条 IPC 用 `← ipc: [<时间> from: <发送方>] <内容>` 格式直接回显到 reply 第一行·让用户在 codex CLI UI 看到 IPC 抵达；第二·正常处理这条 IPC（如需 reply 给发送方·用 ipc_send 工具）。`

## K.Y-1 reversed text

`上方 history 已 inject IPC 消息·user 已能看到 ← ipc 行。请你正常处理这条 IPC（如需 reply 用 ipc_send）。无需主动 echo·已自动可见。`

## Patch summary

- `mcp-server.mjs` idle path: restored K.I `turnStart` echo instruction verbatim.
- `mcp-server.mjs` active path: `turnSteer` keeps injected content beginning with `← ipc:` and appends `上面注入的 IPC 消息·请将首行 \`← ipc:\` 完整原样回显到下条 reply 顶部·然后接续当前任务`。
- `tests/codex-idle-wake.test.mjs`: idle assertion restored to `← ipc:` + `回显到 reply 第一行`; active assertion covers `turnSteer` echo instruction.
- `tests/codex-ui-echo.test.mjs`: idle assertion restored; active test renamed and now asserts echo instruction.

## Patch diff

```diff
 mcp-server.mjs                 |  8 ++++++--
 tests/codex-idle-wake.test.mjs | 13 +++++++++----
 tests/codex-ui-echo.test.mjs   |  9 ++++-----
 3 files changed, 19 insertions(+), 11 deletions(-)
```

## Verification

- `node --test tests/codex-idle-wake.test.mjs tests/codex-ui-echo.test.mjs`: FAIL in sandbox before test body, `spawn EPERM` from Node test runner isolation.
- `node --test --test-isolation=none tests/codex-idle-wake.test.mjs tests/codex-ui-echo.test.mjs`: PASS, 6 tests, 0 fail.
- `node tests/codex-idle-wake.test.mjs`: PASS, 4 tests, 0 fail.
- `node tests/codex-ui-echo.test.mjs`: PASS, 2 tests, 0 fail.
- `rg -n "无需主动 echo" mcp-server.mjs`: 0 matches.
- AC6 baseline true value: `node bin/run-tests.mjs tests` currently FAILS on `tests/claude-stdin-auto-accept-multi-prompt.test.mjs` because internal `child_process.spawn` is blocked by sandbox `EPERM`; earlier tests pass before that failure. No failure observed in modified files.

## Ship

- ship-tier: e2e-partial X/28
- 真打通待补 ETA: 老板观察 supervisor 屏幕真出现 `← ipc` 一行
- commit hash: not created; sandbox denied writes to `.git/config` and `.git/index.lock`.
- push status: not attempted because commit could not be created.
- fallback: Hub HTTP `/send` to `jianmu-pm` accepted, message id `msg_1777952832345_01f76b`, online `true`, buffered `false`.
- EXIT: 1, patch/test/report done; git commit/push blocked by sandbox git metadata permissions.
