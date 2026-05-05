# git attribution warning hook v0.1 trial ship

## Scope

- Implemented Jianmu IPC Hub PreToolUse Bash advisory hook for shared git index attribution drift.
- Source of truth read: `feedback_pm_git_commit_index_drift.md` v2.1, including corrected 5-6 anchor (`ce7467ea` mixed 12 files, `6e404916` clean, `e07a75d4` rebase intermediate), `git rebase --autostash` race root cause, Layer 1 owner attribution verify, and Hook owner-mix expansion.
- Hook is advisory only: exit 0, warning/audit/IPC signal, no commit block.

## Implementation

- Added harness hook: `xihe-tianshu-harness/domains/software/hooks/git-attribution-warning.ps1`.
- Added tests: `git-attribution-warning.test.ps1`.
- Updated `templates/hooks-snippet.json`:
  - registers `git-attribution-warning.ps1` under PreToolUse Bash;
  - fixes old bad `pre-commit-author-check.ps1` path from `${CLAUDE_PROJECT_DIR}/domains/...` to `D:/workspace/ai/research/xiheAi/xihe-tianshu-harness/domains/...`.
- Patched existing `pre-commit-author-check.ps1` IPC send path to use explicit UTF-8 bytes, matching the new hook and avoiding PS5 JSON body mojibake.
- Updated install-hooks regression expectations from 9 to 10 PowerShell hooks.
- Ran `node tools/install-hooks.mjs`; user settings now includes one `git-attribution-warning.ps1` PreToolUse Bash command.

## Rules Covered

- `git add`:
  - no path or no concrete path warns;
  - `-A`, `-a`, `--all`, `.` warns as full-index shared-index risk;
  - concrete paths pass and are recorded as recent add state per `IPC_NAME`.
- `git commit`:
  - `--` separator passes;
  - no `--` compares staged files to recent add paths;
  - known commit scopes (`docs(pm)`, `docs(designer)`, `docs(harness)`, `docs(architect)`, `feat(F07)`, `feat(F08)`) compare staged paths to hardcoded owner prefixes;
  - unmapped scopes stay conservative unless recent-add mismatch exists.
- Drift warning path:
  - stderr visible warning;
  - local side audit log: `C:\Users\jolen\.claude\jianmu-ipc-hooks\git-attribution-warning.audit.jsonl`;
  - Jianmu Hub side audit log: `D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\data\audit.log`, event `git_attribution_warning_hook`;
  - drift sends IPC to `harness` with topic `git-attribution-warning`.

## Verification

- PS5: `powershell.exe -File domains/software/hooks/git-attribution-warning.test.ps1` -> 9/9 PASS.
- PS7: `pwsh -File domains/software/hooks/git-attribution-warning.test.ps1` -> 9/9 PASS.
- PS5: `pre-commit-author-check.test.ps1` -> 7/7 PASS.
- PS7: `pre-commit-author-check.test.ps1` -> 7/7 PASS.
- Node: `node --test tests/install-hooks.test.mjs` -> 8/8 PASS.
- Node: `node --test tests/task-agent-bind-ps1.test.mjs` -> 4/4 PASS.

## Dogfood Evidence

- Fake IPC: `IPC_NAME=fake-jianmu-pm`.
- Fake command: `git commit -m "docs(pm): dogfood fake owner mix hub audit"`.
- Fake staged mix:
  - `reports/pm/fake-pm.md`
  - `docs/spec/F07-team-management/fake-designer.md`
- Warning:
  - `[git-attribution-warning] commit 暂存区含 1 文件不属本 session/scope·attribution drift 风险·scope=docs(pm)·reason=scope-owner-mismatch:docs(pm)·files=docs/spec/F07-team-management/fake-designer.md·建议 git commit -m '...' -- <specific path>`
- IPC harness evidence:
  - `msg_1778010054210_0a140c`
  - status `delivered`
  - topic `git-attribution-warning`
  - created at `2026-05-06T03:40:54+08:00` (Hub stored UTC `2026-05-05 19:40:54`)
- Hub audit evidence:
  - `git_attribution_warning_hook` entry at `2026-05-06T03:40:54+08:00`
  - IPC audit entry includes `id=msg_1778010054210_0a140c`
  - Hub ack audit recorded `ack_received` from `harness`, `rtt_ms=2503`
- Encoding fix verified: first dogfood IPC exposed PS5 UTF-8 body corruption; hook now sends explicit UTF-8 bytes with `application/json; charset=utf-8`, and the second dogfood message stored Chinese content correctly.

## Deployment Notes

- User settings merge completed via install-hooks. Existing sessions may require settings reload/new session before Claude Code hook runtime re-reads the new command.
- IPC ack to `jianmu-pm`: `msg_1778010610942_1bfbd2`, accepted.
- Portfolio broadcast: `msg_1778010610998_a47024`, accepted.
- No force push, no filter-branch, no reset hard.
- Git identity verified: `Xihe <xihe-ai@lumidrivetech.com>`.
