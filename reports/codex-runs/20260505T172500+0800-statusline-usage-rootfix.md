# statusline usage rootfix

Run: 2026-05-05T17:25+08:00 brief  
Ship tier: e2e-full  
Exit: 0

## RCA

- Statusline account bug: old `C:\Users\jolen\.claude\statusline-account.mjs` trusted `.current-account` only when marker mtime was within 60s of `.credentials.json`. Token refresh made credentials newer, then fallback used `subscriptionType`; both A and B are `max`, so fallback collapsed to A.
- HUD usage 429 bug: `claude-hud` live cache `0.0.7` still called `https://api.anthropic.com/api/oauth/usage` directly. The Jianmu `/usage` patch existed in repo but was not applied/built into the installed plugin.
- Extra real-world finding during AC4/AC6: current credentials can lose `refreshToken` while retaining B `accessToken`, and the original HUD patch still fell back to Anthropic on Hub timeout. Both were fixed.

## Implementation

- Added repo-owned `bin/statusline-account.mjs` and installed it to `C:\Users\jolen\.claude\statusline-account.mjs` with backup.
- Added `bin/cc-a.bat`, `bin/cc-b.bat`, `bin/cc-save.bat`, and `bin/install-statusline-account.ps1`.
- `cc-a` / `cc-b` now write `.current-account` JSON: `{"which":"a|b","fingerprint":"<sha256(refreshToken tail16) head16>"}`.
- `statusline-account.mjs` now trusts marker only when refresh-token fingerprint matches current credentials, then falls back to vault refresh/access token fingerprints, then only last to subscriptionType.
- Applied and rebuilt `claude-hud` live `0.0.7`; `dist/index.js` contains `http://127.0.0.1:3179/usage`.
- Updated `patches/claude-hud-jianmu-priority.patch` so HUD uses Jianmu Hub `/usage` first and suppresses direct Anthropic fallback on Hub timeout/failure.
- Added `bin/install-hud-patch.ps1`; registered Windows scheduled task `JianmuClaudeHudPatch` to run hourly.
- Updated README and package file list.
- Synced harness `handover/TODO.md` and `handover/PROJECT-PLAN.md`.

## Acceptance

| AC | Result | Evidence |
|----|--------|----------|
| AC1 | PASS | `cmd /c C:\Users\jolen\cc-a.bat --version; node C:\Users\jolen\.claude\statusline-account.mjs` output contained green ` A `. |
| AC2 | PASS | `cmd /c C:\Users\jolen\cc-b.bat --version; node C:\Users\jolen\.claude\statusline-account.mjs` output contained blue ` B `. |
| AC3 | PASS | After B switch, `.credentials.json` mtime was set 5 minutes into the future; statusline still output blue ` B `. |
| AC4 | PASS | Marker was temporarily moved away; statusline fallback resolved blue ` B ` by matching current access token hash to `account-b.json` vault. Added unit coverage for refresh and access fallback. |
| AC5 | PASS | `grep -E "127\.0\.0\.1:3179|127\.0\.0\.1|jianmu|Jianmu" ...\0.0.7\dist\index.js` matched `JIANMU_USAGE_ENDPOINT = 'http://127.0.0.1:3179/usage'`. |
| AC6 | PASS | Spawned `node ...\0.0.7\dist\index.js` with fake stdin and NODE_OPTIONS request trace. Trace showed `[hud-trace] http 127.0.0.1:3179` and no `https api.anthropic.com`; HUD rendered `usage: (jianmu-timeout)`. |
| AC7 | PASS | Copied live plugin to fake `0.0.99`, ran `bin\install-hud-patch.ps1`, verified fake dist contained `JIANMU_USAGE_ENDPOINT` and Jianmu usage code; removed fake after verification. |
| AC8 | PASS | `Get-ScheduledTask -TaskName JianmuClaudeHudPatch` returned task state `Ready`. |
| AC9 | PASS | `npm test` in `xihe-jianmu-ipc` passed full unit + integration + e2e suite. |

## Commits

jianmu-ipc:

- `4057fca` `test: 覆盖 statusline 账号指纹解析`
- `f2854a0` `fix: 根治 statusline 账号和 hud usage 直连`
- `3d1984e` `docs: 记录 rename 原子交接修复报告` (concurrent report commit on branch)

harness:

- `1cfae1e` `docs: 同步 statusline usage 根治交付`

## Push status

- `xihe-jianmu-ipc`: `git push origin master` returned `Everything up-to-date`; local `HEAD` equals `origin/master` at `3d1984ea6247bba4f0579465fd4bb9897711b1bd`.
- `xihe-tianshu-harness`: `git push origin main` returned `Everything up-to-date`; local `HEAD` equals `origin/main` at `1cfae1e3ed74e386c33f828092ff173a5de63263`.

## 5-piece sync

- Harness TODO updated.
- Harness PROJECT-PLAN updated.
- Jianmu report written here.
- Cross-repo commits present and pushed.
- Completion IPC notification sent to `jianmu-pm`.

EXIT 0
