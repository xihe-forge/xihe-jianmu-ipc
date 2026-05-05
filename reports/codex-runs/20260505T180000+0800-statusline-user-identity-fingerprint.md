# statusline user identity fingerprint v2

Run window: 2026-05-05T21:20+08:00 to 2026-05-05T22:20+08:00

## Profile endpoint research

Live curl used current `~/.claude/.credentials.json` access token prefix `sk-ant-oat01-XQm`.

| Candidate | Result | Fields |
|---|---:|---|
| `GET https://api.anthropic.com/api/oauth/profile` | 200 | top-level `account`, `organization`, `application`; `account.uuid` present; `account.email` present; `organization.uuid` present |
| `GET https://api.anthropic.com/v1/user` | 404 | `type,error,request_id` |
| `GET https://api.anthropic.com/api/oauth/user` | 404 | `type,error,request_id` |

Decision: main path is valid. Use `account.uuid` as stable `user_id`; store email/org metadata when present. Fallback A was not selected because the profile endpoint works. Extra finding: saved vault access tokens for both account A and B are stale and return 401 when copied into `.credentials.json`.

## Implementation

- `bin/statusline-account.mjs`
  - `resolveAccount()` now verifies marker `user_id` against profile identity.
  - Adds 60-minute cache at `~/.claude/.statusline-user-id-cache.json` with `access_token_prefix_16`, `user_id`, `email`, `org_id`, `expires_at`; file mode is set to `0600` where supported.
  - Marker-missing path can call profile and match current `user_id` against vault `xihe_identity`.
  - Existing v1 vault refresh/access token fingerprint fallback and subscription fallback remain intact for API failure.

- `bin/update-claude-account-identity.ps1`
  - New launcher helper for `cc-a`, `cc-b`, and `cc-save`.
  - On live profile success, writes vault `xihe_identity` and marker `{which,user_id,captured_at}`.
  - On profile 401/network failure, restores marker from existing vault identity or writes legacy fingerprint marker so Claude launch is not blocked.

- `bin/install-statusline-account.ps1` now installs the helper into `C:\Users\jolen`.

## Verification

- Focused test: `node --test tests/statusline-account.test.mjs` PASS, 8/8.
- Full baseline: `npm test` PASS.
- Installer: `powershell -NoProfile -ExecutionPolicy Bypass -File bin/install-statusline-account.ps1` PASS.
- Real switch smoke:
  - `cc-a --version` exit 0; profile capture 401; legacy marker written; resolver returns `a`.
  - `cc-b --version` exit 0; profile capture 401; legacy marker written; resolver returns `b`.
- Direct auth blocker check: after copying Account A, `claude --print "Return exactly ok"` failed 401 authentication.

## Acceptance truth

| AC | Truth |
|---|---|
| AC1 | Blocked: Account A vault token returns 401 to profile, so `user_id` marker/vault write cannot be truthfully completed. Legacy fallback marker resolves A. |
| AC2 | Blocked: Account B vault token returns 401 to profile, so `user_id` marker/vault write cannot be truthfully completed. Legacy fallback marker resolves B. |
| AC3 | Blocked for real token rotation lifecycle because both vault credentials are already stale/invalid for profile. Unit regression covers rotated refresh token with stable `user_id`. |
| AC4 | PASS: profile endpoint research recorded above. Working endpoint is `/api/oauth/profile`. |
| AC5 | PASS: unit test verifies cache hit avoids profile call while access token prefix is unchanged and refetches after prefix changes. |
| AC6 | PASS in unit test; blocked in real vault because vaults do not yet have `xihe_identity` and profile returns 401 after copy. |
| AC7 | PASS: API failure falls back gracefully through existing identity or v1 fingerprint/subscription; `cc-a/cc-b --version` no longer fail on profile 401. |
| AC8 | PASS: `npm test` full suite green. |
| AC9 | PASS: this report records endpoint research, implementation, and the credential blocker. |

## Commits

- jianmu-ipc RED: `847eb6d` `test: 复现 statusline 身份指纹切换失效`
- jianmu-ipc GREEN: `726c914` `fix: statusline 改用用户身份指纹`
- harness sync: `6dff0c2` `docs: 同步 statusline 用户身份指纹 v2`

## Push status

Pending at report creation; final task notification will include pushed refs or failure.

## IPC

Sent `jianmu-pm` blocker notification with the exact blocker: profile endpoint works, but saved A/B vault tokens are stale and direct Account A Claude auth returns 401.

EXIT 0
