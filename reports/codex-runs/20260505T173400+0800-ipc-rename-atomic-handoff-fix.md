# ipc_rename atomic handoff fix report

Time: 2026-05-05T18:12+08:00
Ship tier: e2e-full
Result: EXIT 0

## RCA

`ipc_rename` previously changed the local name, then used graceful `ws.close()` and immediately called reconnect. If the old WebSocket close handshake stalled, Hub could keep the old session name as an OPEN holder. An immediate `ipc_spawn` using the original name then failed with `Session is already online`.

## Implementation

- Added `terminateWs()` in `mcp-server.mjs` and injected it into `createMcpTools`.
- Changed `ipc_rename` to hard-terminate the old WebSocket and await reconnect/register acknowledgement before returning.
- Added register waiters in `mcp-server.mjs`; `registered` messages now resolve rename reconnect waiters.
- Guarded old socket close callbacks so a terminated stale socket cannot schedule an extra reconnect after `ws` has been replaced/nullified.
- Added Hub close fallback for stale current-session socket references while preserving `/session-alive` disconnected metadata.
- Added real Hub/WebSocket lifecycle coverage for rename, same-name replacement, socket destroy cleanup, message routing, and inbox replay.

## Acceptance Truth

| AC | Status | Evidence |
|---|---|---|
| AC1 | PASS | e2e waits until `/health` has archived name and no original name after rename. |
| AC2 | PASS | e2e immediately reconnects original name after rename without 4001 conflict. |
| AC3 | PASS | `ipc_rename` awaits reconnect register-ack contract in `tests/mcp-tools.test.mjs`. |
| AC4 | PASS | socket-level `_socket.destroy()` test verifies live `/sessions` cleanup. |
| AC5 | PASS | e2e sends to original name after replacement and verifies only new session receives it. |
| AC6 | PASS | Unit coverage for terminate/await contract plus integration coverage for close lifecycle. |
| AC7 | PASS | `npm test` full suite passed. |
| AC8 | PASS | New integration uses real Hub worker + real `ws` clients; no mocked ws close/terminate behavior for lifecycle path. |

## Verification

- `node --test tests/mcp-tools.test.mjs` PASS
- `node --test tests/integration/ipc-rename-atomic-handoff.test.mjs` PASS
- `node --test tests/integration/hub-session-alive.test.mjs` PASS after preserving disconnected metadata baseline
- `npm test` PASS

## Commits

jianmu-ipc:

- `48de065` `test: 覆盖 rename 原子交接生命周期`
- `16f3818` `fix: rename 使用强制断开并等待注册`
- report commit: this report

Harness:

- `db9c202` `docs: 同步 rename 原子交接 ship 状态`

Note: two unrelated local jianmu-ipc commits were already above the rename fix at push time and were included in the branch push: `4057fca`, `f2854a0`.
Note: one unrelated local harness commit was already above the sync commit at final push time and was included in the branch push: `1cfae1e`.

## Push Status

- jianmu-ipc `master` pushed to `git@github-xihe:xihe-forge/xihe-jianmu-ipc.git` after the report commit.
- harness `main` pushed to `git@github-xihe:xihe-forge/xihe-tianshu-harness.git`; rename sync commit `db9c202` is included, final remote tip after push was `1cfae1e`.

EXIT 0
