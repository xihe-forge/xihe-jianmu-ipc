# statusline v3 no-profile API ship report

时间：2026-05-05T22:45+08  
ship-tier：e2e-full  
结果：EXIT 0

## v3 vs v2 diff

- v2：`statusline-account.mjs` 通过 Anthropic profile endpoint 校验 `user_id`，并写/读 user_id cache；PowerShell helper 也会调用 profile endpoint 写 vault `xihe_identity.user_id`。
- v3：完全删除 profile endpoint、profile fetch、user_id cache、vault user_id match；状态栏只走本地 hash 流程：marker fingerprint match -> vault refresh/access hash fallback -> subscription fallback。
- v3 保留 vault auto-sync：`start-claude-account.ps1` 启动即写 v1 风格 marker；后台 `sync-claude-account-vault.ps1` 仍 8s 首跑 + 60s 周期；每次 sync 原子更新 vault OAuth 字段和 marker.fingerprint。
- `xihe_identity` 兼容保留，但新版只写 `{ which, captured_at }`，不再写 user_id/email/org_id。

## AC truth table

| AC | 结果 | 证据 |
|---|---|---|
| AC1 | PASS | Added-lines grep: no `anthropic.com` / `oauth/profile` / old profile symbols in v3 patch. Existing non-profile tests still contain messages/usage URLs outside this patch. |
| AC2 | PASS | Temp `start-claude-account.ps1` + fake `claude` shim: first sync after 8s copied `live-refresh-after-start` into vault; marker hash matched credentials hash. |
| AC3 | PASS | Real 60s sync loop with manual token rotation: vault refreshToken became `rotated-refresh-60s`; marker.fingerprint became `2a8f7c7d92599e98`. |
| AC4 | PASS | Temp resolver returned `a` for account A and `b` for account B after rotation. |
| AC5 | PASS | `tests/statusline-account.test.mjs` covers marker match, stale marker -> vault fallback, access-token vault fallback, subscription fallback, and null all-fail. |
| AC6 | PASS | `rg "oauth/profile|PROFILE_ENDPOINT|fetchProfileIdentity|fetchAnthropicProfileIdentity|identityFromProfile" bin tests test package.json` returned no matches. |
| AC7 | PASS | `npm test` passed. |
| AC8 | PASS | This report records v3/v2 delta, account-safety reason, and vault auto-sync compensation. |

## Verification

- RED targeted tests failed before implementation:
  - `node --test tests/statusline-account.test.mjs` failed on injected no-network identity lookup.
  - `node --test tests/claude-account-scripts.test.mjs` failed on legacy identity shape.
- GREEN targeted tests:
  - `node --test tests/statusline-account.test.mjs tests/claude-account-scripts.test.mjs` -> 9/9 PASS.
- Full baseline:
  - `npm test` -> PASS.
- E2E smoke:
  - Temp `claude` shim rotated credentials before the 8s sync: first sync PASS.
  - 60s sync loop with manual token rotation: vault + marker PASS.
  - Temp resolver A/B: PASS.
- Grep:
  - Old profile symbols in `bin/tests/test/package.json`: 0 matches.
  - PowerShell account scripts: no `Invoke-RestMethod` / `Invoke-WebRequest`.

## Commits and push

jianmu-ipc:
- `37e22ec` test: 覆盖 statusline v3 零 profile API
- `250b9ac` fix: statusline v3 移除 profile API
- push: `origin/master` updated `e2475f4..250b9ac`

harness:
- `a846976` docs: 同步 statusline v3 零 profile API
- push: `origin/main` updated `81b4bb0..a846976`
- Note: harness main working tree had pre-existing unrelated dirty files, so the harness sync commit was made from a clean worktree to avoid staging unrelated edits.

## Account-safety response

老板担忧是账号封禁风险。v3 的账号识别路径完全本地化，状态栏与账号 helper 不再调用 Anthropic profile API。token rotation 的准确性由 vault auto-sync 补偿：Claude 刷新 `.credentials.json` 后，后台 8s/60s sync 会把 OAuth 字段和 marker fingerprint 原子追平。

EXIT 0
