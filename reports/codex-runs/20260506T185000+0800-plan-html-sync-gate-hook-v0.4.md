# plan/html sync gate hook v0.4 ship

## Summary

- Implemented hard block hook in `xihe-tianshu-harness`: `domains/software/hooks/plan-html-sync-gate.ps1`.
- Added PS5/PS7 test coverage: `domains/software/hooks/plan-html-sync-gate.test.ps1`.
- Registered installer source in `templates/hooks-snippet.json` under `PreToolUse` + `Bash`, with command-prefix filtering in the hook for `git commit`.
- Updated `tests/install-hooks.test.mjs` expectations from 11 to 12 PowerShell hook commands.
- Fixed the old bad `${CLAUDE_PROJECT_DIR}/domains/...` template path in `templates/settings-fragment.json` to `${CLAUDE_PROJECT_DIR}/xihe-tianshu-harness/domains/...`.

Hard block note: the brief said PostToolUse, but PostToolUse runs after the Bash command has already executed. The shipped enforcement point is PreToolUse so the commit is actually blocked before it lands. The hook itself still applies the requested `git commit` prefix rule and exits 0 for all non-matching Bash commands.

## Behavior

- Reads the command from Claude hook env/stdin.
- Only inspects `git commit` / `git commit --amend` command prefixes.
- Reads staged files using `git diff --cached --name-only`.
- Only triggers when staged files include exactly `.planning/PROJECT-PLAN.md`.
- Compares worktree mtimes:
  - pass: `.planning/PROJECT-PLAN.html` mtime >= `.planning/PROJECT-PLAN.md` mtime
  - block: HTML missing/stale or MD missing while staged
- Block output:
  - stderr: `plan html 落后 md·须先 render 同步·路径：.planning/PROJECT-PLAN.html`
  - exit code: non-zero
  - direct IPC escalation: `to="harness"`, no topic fanout
  - local/hub audit event: `plan_html_sync_gate_hook`

PowerShell robustness:
- IPC POST body uses `[System.Text.Encoding]::UTF8.GetBytes(...)`.
- Content-Type is `application/json; charset=utf-8`.
- Git root is normalized from MSYS `/c/...` paths for PS7 compatibility.
- Repo path joins are segmented to avoid `-LiteralPath` + forward-slash false negatives on PS7.

## Dogfood Evidence

Command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File domains\software\hooks\plan-html-sync-gate.test.ps1`

Result: `6 PASS / 0 FAIL`

Command: `pwsh -NoProfile -ExecutionPolicy Bypass -File domains\software\hooks\plan-html-sync-gate.test.ps1`

Result: `6 PASS / 0 FAIL`

Covered cases:

| Case | Result |
|---|---|
| md changed + html stale | blocks, stderr contains required render message, IPC capture includes `to=harness` |
| md changed + html rendered | passes silently |
| other file commit while plan html stale | passes silently |
| amend commit with md staged | blocks with same rule |
| staged md but non-commit command | passes silently |
| real HTTP IPC payload | UTF-8 charset, no topic, Chinese bytes verified (`e890bde5908e`) |

## Verification

- PS5 gate test: 6/6 PASS.
- PS7 gate test: 6/6 PASS.
- Node installer test: `node --test tests\install-hooks.test.mjs` -> 8/8 PASS.
- PS5 pre-commit author regression: 8/8 PASS.
- PS7 pre-commit author regression: 8/8 PASS.
- PS5 git attribution regression: 10/10 PASS.
- PS7 git attribution regression: 10/10 PASS.
- `git diff --check` on changed harness files: PASS.

## Rollout

- Installed via `node tools\install-hooks.mjs`.
- User settings now contains:
  - `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${CLAUDE_PROJECT_DIR}/xihe-tianshu-harness/domains/software/hooks/plan-html-sync-gate.ps1`
- Harness commit pushed:
  - `cd95821 feat(hooks): add plan html sync hard gate` -> `origin/main`

## Five-Piece Sync

- TODO append: `handover/TODO.md`.
- Cross-repo report: this file.
- jianmu-pm IPC ack: `msg_1778067420500_f8a2a8`.
- portfolio broadcast: `msg_1778067420535_5cd17c`.
- No force push, no filter-branch, no reset hard. Git identity verified as `Xihe <xihe-ai@lumidrivetech.com>`.
