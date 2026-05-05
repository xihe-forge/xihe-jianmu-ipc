# git-attribution-warning v0.1.2 layered noise-control

Time: 2026-05-06T04:15+08
Owner: codex
Repos: `xihe-tianshu-harness`, `xihe-jianmu-ipc`

## Summary

v0.1.2 is shipped. The hook now follows the v2.1 layered path:

- default / non-escalation path: write audit only, no IPC noise;
- attribution drift path: send one direct IPC to `harness`;
- no `topic=git-attribution-warning` is emitted by the drift IPC payload, so the Hub cannot topic-fanout it to portfolio subscribers.

## Diagnosis

The current v0.1/v0.1.1 hook did not literally store drift messages as `to="*"` in `messages.db`. The real noise path was Hub routing semantics:

- Hook payload had `to="harness"` and `topic="git-attribution-warning"`.
- `lib/router.mjs` routes any message with `topic` through `broadcastToTopic(topic, ...)` before direct delivery.
- Therefore `to=harness + topic=git-attribution-warning` behaved as topic fanout plus direct harness delivery.

v0.1 report `reports/codex-runs/20260506T031200+0800-git-attribution-warning-hook.md` said drift sends IPC to `harness` with topic `git-attribution-warning`; that was the problematic part.

## Code Changes

Harness repo:

- `domains/software/hooks/git-attribution-warning.ps1`
  - default audit log path now writes `~/.claude/plugins/claude-hud/jianmu-attribution-audit.log`;
  - drift IPC body keeps `from=git-attribution-warning`, `to=harness`, `content=...`;
  - drift IPC body no longer includes `topic=git-attribution-warning`;
  - path-limited / no-drift commit paths write audit with `ipc=none`.
- `domains/software/hooks/git-attribution-warning.test.ps1`
  - raw HTTP regression now asserts `"to":"harness"`;
  - raw HTTP regression asserts no `"topic":"git-attribution-warning"`.

No encoding behavior was changed; v0.1.1 `UTF8.GetBytes($body)` + `charset=utf-8` remains intact.

## Before / After IPC Evidence

Before:

| Time +08 | Message ID | DB recipient | DB topic | Effect |
| --- | --- | --- | --- | --- |
| 2026-05-06 03:29 | `msg_1778009394756_a5855f` | `harness` | `git-attribution-warning` | topic fanout risk; mojibake content |
| 2026-05-06 03:40 | `msg_1778010054210_0a140c` | `harness` | `git-attribution-warning` | topic fanout risk |
| 2026-05-06 03:52 | `msg_1778010773146_8edfc1` | `harness` | `git-attribution-warning` | topic fanout risk; v0.1.1 Chinese fixed |

After:

| Time +08 | Message ID | DB recipient | DB topic | Effect |
| --- | --- | --- | --- | --- |
| 2026-05-06 04:13 | `msg_1778011992895_57c5ac` | `harness` | `null` | direct-only; no topic fanout |

The v0.1 meta portfolio broadcast `msg_1778010610998_a47024` was a release announcement (`topic=portfolio-broadcast`), not an attribution warning drift event.

## Dogfood Verification

Command simulated:

- `IPC_NAME=fake-jianmu-pm`
- `git commit -m "docs(pm): dogfood fake owner mix v0.1.2"`
- staged file env: `docs/spec/F07-team-management/fake-designer.md`

Observed:

- stderr warning printed and hook exited 0;
- HUD audit file wrote warning + ipc entries:
  - `C:\Users\jolen\.claude\plugins\claude-hud\jianmu-attribution-audit.log`
- Hub audit wrote:
  - `message_route` to `harness`;
  - `push_deliver` reason `route-direct`;
  - `ack_received` from `harness`, `rtt_ms=1225`;
- `messages.db` row for `msg_1778011992895_57c5ac`:
  - `to=harness`
  - `topic=null`
  - `status=delivered`
- `inbox` query for the message id returned `[]`;
- `rg msg_1778011992895_57c5ac data -g "mcp-trace-*.log"` matched only `data/mcp-trace-harness.log`.

## Tests

- `pwsh -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/git-attribution-warning.test.ps1`: 10/10 PASS
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/git-attribution-warning.test.ps1`: 10/10 PASS
- `pwsh -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/pre-commit-author-check.test.ps1`: 8/8 PASS
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/pre-commit-author-check.test.ps1`: 8/8 PASS
- `node --test tests/install-hooks.test.mjs`: 8/8 PASS

## IPC Sync

- jianmu-pm ack: `msg_1778012241352_9d0640`, accepted, direct `to=jianmu-pm`.
- portfolio broadcast: `msg_1778012241410_d09bef`, accepted, `to=*`, `topic=portfolio-broadcast`.

## Safety

- `git pull --ff-only` was run first in both repos; both were already up to date.
- No force push.
- No filter-branch.
- No reset hard.
- Git identity target: `Xihe <xihe-ai@lumidrivetech.com>`.
