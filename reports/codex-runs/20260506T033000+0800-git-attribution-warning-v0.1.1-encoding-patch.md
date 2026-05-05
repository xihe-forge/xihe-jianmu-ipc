# git-attribution-warning v0.1.1 encoding patch

Time: 2026-05-06T03:30+08
Owner: codex
Repos: `xihe-tianshu-harness`, `xihe-jianmu-ipc`

## Summary

v0.1 dogfood confirmed the attribution warning logic worked, but the IPC content was mojibake in Hub. v0.1.1 is closed: Hub receives Chinese text correctly, and raw HTTP byte regression tests now cover both `git-attribution-warning.ps1` and `pre-commit-author-check.ps1`.

## Root Cause

Verified root cause is HTTP request encoding from Windows PowerShell 5.1, not the Hub JSON parser.

- Source bytes: hook/test files are valid UTF-8 NoBOM.
- Runtime encoding probe: WinPS5 reports `[Console]::OutputEncoding=utf-8`, `[Console]::InputEncoding=gb2312`, `$OutputEncoding=us-ascii`; stdout was not the primary IPC corruption path.
- Raw body capture: WinPS5 `Invoke-RestMethod -Body $body -ContentType application/json` emitted non-UTF-8 bytes. Chinese became `3f` (`?`), and `·` became single byte `b7`, which Hub decoded as U+FFFD.
- Fixed form: `UTF8.GetBytes($body)` + `ContentType 'application/json; charset=utf-8'` emitted valid UTF-8 bytes, e.g. `暂存区` as `e69a82e5ad98e58cba`.

## Before / After

- Before: `msg_1778009394756_a5855f`
  - `commit ???? 1 ????? session/scope�attribution drift ?? ... �?? git commit -m '...' -- <specific path>`
- After: `msg_1778010773146_8edfc1`
  - `commit 暂存区含 1 文件不属本 session/scope·attribution drift 风险·scope=docs(pm)·reason=scope-owner-mismatch:docs(pm)·files=docs/spec/F07-team-management/fake-designer.md·建议 git commit -m '...' -- <specific path>`

## Code State

- `xihe-tianshu-harness` `211bb76` adds `git-attribution-warning.ps1` with UTF-8 output setup, codepoint-built Chinese text, and UTF-8 byte IPC payloads.
- `pre-commit-author-check.ps1` now uses the same UTF-8 byte IPC payload pattern.
- `xihe-tianshu-harness` `e54bb0e` adds raw HTTP capture regression tests so the `????/�` failure mode is caught under both PS5 and PS7.

## Verification

- `pwsh -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/git-attribution-warning.test.ps1`: 10/10 PASS
- `pwsh -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/pre-commit-author-check.test.ps1`: 8/8 PASS
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/git-attribution-warning.test.ps1`: 10/10 PASS
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File domains/software/hooks/pre-commit-author-check.test.ps1`: 8/8 PASS
- `node --test tests/install-hooks.test.mjs`: 8/8 PASS
- Live dogfood fake commit sent Hub IPC `msg_1778010773146_8edfc1`; content is readable Chinese, not `????`.

## Follow-up

No runtime blocker remains. Other PowerShell hooks that call Hub with string `-Body` should use the same `UTF8.GetBytes` + `charset=utf-8` pattern when they send Chinese content.
