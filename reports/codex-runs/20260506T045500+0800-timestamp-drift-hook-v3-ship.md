# timestamp drift hook v3 ship

## Summary

- Source spec read: `C:\Users\jolen\.claude\projects\D--workspace-ai-research-xiheAi\memory\feedback_timestamp_drift_hook_v3.md`.
- Implemented harness PostToolUse advisory hook: `xihe-tianshu-harness/domains/software/hooks/timestamp-drift-warning.ps1`.
- Registered matcher: `mcp__ipc__ipc_send|Bash|Write|Edit` in `templates/hooks-snippet.json`.
- Installed into `C:\Users\jolen\.claude\settings.json` via `node tools/install-hooks.mjs`.
- Harness commit pushed: `062e076 feat(hooks): timestamp drift warning advisory` -> `origin/main`.

## Behavior

- Truth anchor: hook runs `date -Iseconds` unless the test-only `TIMESTAMP_DRIFT_WARNING_NOW` override is set.
- Parsers: ISO 8601 with `Z`, `+08`, `+0800`, `+08:00`; short `HH:MM+TZ` expands to wall-clock date.
- Fuzzy Chinese time words such as `刚刚` are skipped and audit-only.
- Layering:
  - `<=60s`: pass, no stderr, no IPC, no audit by default.
  - `61-300s`: audit-only; sensitive text (`critique`, `SHIP`, commit/hash, `老板`, `刚刚`, `现在`) escalates.
  - `301-1800s`: stderr warning + direct IPC to `harness`.
  - `>1800s`: governance ledger marker + direct IPC to `harness`.
- IPC body uses explicit UTF-8 bytes and `Content-Type: application/json; charset=utf-8`.
- Drift escalation payload uses `to=harness` and no `topic`, so it cannot topic-fanout.

## Dogfood Evidence

Wall clock source was real `date -Iseconds`; no fixed test override.

| Case | AI timestamp | Wall clock | Drift | Result |
|---|---:|---:|---:|---|
| `pass_le_1min` | `2026-05-06T05:23:22+08:00` | near `2026-05-06T05:23:52+08:00` | ~30s | silent, no IPC |
| `warning_gt_5min` | `2026-05-06T05:13:52+08:00` | `2026-05-06T05:23:53+08:00` | `601s` | direct harness IPC `msg_1778016233501_57b045` |
| `governance_gt_30min` | `2026-05-06T04:38:52+08:00` | `2026-05-06T05:23:54+08:00` | `2702s` | governance marker + direct harness IPC `msg_1778016234908_598b54` |

Before/after anchor:
- pre-dogfood audit tail baseline latest unrelated route: `msg_1778016057541_3e88f9`.
- post-dogfood hook IPC ids: `msg_1778016233501_57b045`, `msg_1778016234908_598b54`.

Audit evidence:
- `~/.claude/jianmu-ipc-hooks/audit/timestamp-drift-2026-05-06.log` contains warning + governance entries.
- Hub audit contains `timestamp_drift_governance_ledger` with marker `TIMESTAMP_DRIFT_GOVERNANCE_LEDGER`.
- Hub audit details for both dogfood IPC entries show `to:"harness"` and `topic:null`.

## Verification

- PS5: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/timestamp-drift-warning.test.ps1` -> 10/10 PASS.
- PS7: `pwsh -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/timestamp-drift-warning.test.ps1` -> 10/10 PASS.
- Node: `node --test tests/install-hooks.test.mjs` -> 8/8 PASS.
- PS5: `git-attribution-warning.test.ps1` -> 10/10 PASS.
- PS7: `git-attribution-warning.test.ps1` -> 10/10 PASS.
- PS5: `pre-commit-author-check.test.ps1` -> 8/8 PASS.
- PS7: `pre-commit-author-check.test.ps1` -> 8/8 PASS.
- Node: `node --test tests/task-agent-bind-ps1.test.mjs` -> 4/4 PASS.

## Five-Piece Sync

- TODO append: `handover/TODO.md`.
- Cross-repo report: this file.
- `jianmu-pm` IPC ack: `msg_1778016709441_32c610`.
- Portfolio broadcast: Hub accepted `msg_1778016721384_cf7e03` (`to="*"`, release announcement; not a drift escalation).
- Install complete: user settings contains one `timestamp-drift-warning.ps1` PostToolUse command.

## Monitoring

- Baseline: 10 timestamp drift events >5min in 18 days, about 4/week.
- v3 target: >=50% reduction, <=2/week.
- Observation window: 2026-05-06 through 2026-07-05.
