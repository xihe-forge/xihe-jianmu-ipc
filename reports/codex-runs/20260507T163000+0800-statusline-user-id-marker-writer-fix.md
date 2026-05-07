# statusline user_id marker writer fix

Time: 2026-05-07T16:30+08:00

## RCA

- `726c914 fix: statusline 改用用户身份指纹` added profile identity reader/writer (`marker.user_id`, `vault.xihe_identity.user_id`).
- `250b9ac fix: statusline v3 移除 profile API` removed profile API for 401 tolerance and also removed the user_id writer. That left current marker/vault records without `user_id`, so reader paths could not fire.
- Live install was mixed: `~/.claude/statusline-account.mjs` still had user_id reader code, but `start-claude-account.ps1` did not call the identity writer before launching Claude.
- Additional verified fallback bug: Windows PowerShell `Set-Content -Encoding UTF8` wrote BOM-prefixed vault JSON; statusline `JSON.parse(readFileSync(...))` failed on BOM, skipped vault fallback, then `subscriptionType=max` misidentified B as A.

## Changes

- `bin/update-claude-account-identity.ps1`
  - Captures Anthropic profile identity when available.
  - Writes `marker.user_id` and `vault.xihe_identity.user_id`.
  - Preserves fallback behavior: 401/empty profile does not fail the switch path.
  - Preserves non-empty vault OAuth fields when current credentials contain blank token fields.
  - Writes UTF-8 without BOM.
- `bin/statusline-account.mjs`
  - Restores profile identity fetch/cache.
  - Verifies `marker.user_id` before fingerprint.
  - If a legacy marker lacks `user_id`, captures current profile identity and backfills marker.
  - Resolves by `vault.xihe_identity.user_id` / email before fingerprint fallback.
  - Reads BOM-prefixed JSON safely.
- Tests updated for profile success, 401 fallback, blank-refresh preservation, BOM vault JSON, stale fingerprint with stable user_id.

## Verification

- Focused:
  - `node --test tests\statusline-account.test.mjs` PASS, 10/10.
  - `node --test tests\claude-account-scripts.test.mjs` PASS, 3/3.
- Full unit:
  - `node bin\run-tests.mjs tests` PASS.
- Live install:
  - `powershell -NoProfile -ExecutionPolicy Bypass -File bin\install-statusline-account.ps1` copied source scripts to `C:\Users\jolen`.
- Dogfood:
  - `cc-b --version` captured `user_id=7da00c0d-0aee-4176-aa4a-02c892062b1c`.
  - `.current-account`: `which=b`, `user_id=7da00c0d-0aee-4176-aa4a-02c892062b1c`.
  - `.creds-vault/account-b.json`: `xihe_identity.user_id=7da00c0d-0aee-4176-aa4a-02c892062b1c`.
  - `node %USERPROFILE%\.claude\statusline-account.mjs` renders B.
  - Stale fingerprint simulation: marker fingerprint temporarily changed to `stale-fingerprint-for-dogfood`; statusline still rendered B via `user_id`; writer restored marker fingerprint afterward.
  - `cc-a --version` hit profile 401 and `claude -p` reported Not logged in for A, so A user_id could not be captured on this machine. This is the intended non-fatal 401 fallback path, not a code-path failure.

## Notes

- B is restored as the active account after dogfood; `claude auth status` reports logged in as `f7nksgd89x@privaterelay.appleid.com`.
- The root production failure is fixed for B and covered by unit tests for both profile success and profile failure fallback.
