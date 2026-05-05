# jianmu sessions cleanup suite

Date: 2026-05-05 16:52 +0800
Ship-tier: e2e-full

## openclaw cleanup reference

Reference path: `D:/workspace/ai/opensource/openclaw/docs/cli/sessions.md`.

Observed semantics:
- `openclaw sessions cleanup --dry-run` previews cleanup without writing.
- `--enforce` applies maintenance.
- `--fix-missing` removes entries with missing transcript files.
- Text mode shows a per-session action table; JSON mode emits structured counts.
- Scope flags choose agent/store/all-agents, and cleanup is session-store/transcript focused.

jianmu adapted the semantics to `sessions_history`: name deletion, sessionId deletion, ended/last_seen aging, orphan transcript cleanup, dry-run/enforce and JSON/table output. It does not copy openclaw store internals.

## Four-layer design

SQL/db:
- Added `deleteSessionsByName`, `deleteSessionById`, `findSessionsOlderThan`, `deleteSessionsOlderThan`, `findOrphanSessions`, `listSessionsHistory`, and `cleanupSessionsHistory`.
- Public cleanup excludes `session_id LIKE 'pending-%'`.
- `deleteSessionsByName` deletes `lineage.child_name` and `sessions_history.name` in one transaction.

HTTP:
- Added loopback-only `DELETE /sessions-history/:sessionId`.
- Added loopback-only `DELETE /sessions-history?name=...`.
- Added loopback-only `POST /sessions-history/cleanup`.
- Extended `GET /sessions-history` to support list without a required name.

CLI:
- Added `jianmu sessions list [--name xxx] [--limit 20] [--json]`.
- Added `jianmu sessions cleanup` with `--dry-run`, `--enforce`, `--name`, `--older-than Nd/Nh/Nm`, `--orphan`, `--yes`, and `--json`.
- Text output uses Action / SessionId / Name / SpawnAt / Reason.

Feishu:
- Parses `清理 session 列表` / `session 列表`.
- Parses `清理 session <name>` and `清理 session N 天前` as approval requests.
- Sends cleanup approval work to `jianmu-pm`.
- The ordinary Feishu command path does not execute DELETE; only the confirmation card action posts enforce cleanup.

## AC truth

- AC1: PASS. Real Hub + temp DB + `jianmu sessions cleanup --dry-run --json` returned count/candidates and did not delete.
- AC2: PASS. Real Hub + temp DB + `jianmu sessions cleanup --name taiwei-test --enforce --json` deleted 2 rows; follow-up SQL count for `taiwei-test` was 0.
- AC3: PASS. Real Hub + temp DB + `jianmu sessions cleanup --older-than 30d --dry-run --json` and `--enforce --json` both returned count 2 in the shared fixture; enforce removed the old ended rows.
- AC4: PASS. Real Hub + temp DB + `jianmu sessions cleanup --orphan --enforce --json` deleted 1 missing transcript row.
- AC5: PASS. `tests/http-sessions-history-cleanup.test.mjs` covers loopback success and non-loopback 403.
- AC6: PASS. `清理 session xxx` parses to `sessions_cleanup_request`; `feishu-bridge.mjs` dispatches approval to `jianmu-pm` and does not call DELETE directly.
- AC7: PASS. First `npm test` hit a flaky `tests/integration/zombie-rebind.test.mjs` timing failure; isolated rerun passed; second full `npm test` passed.
- AC8: PASS. `tests/e2e/sessions-history-cleanup-lifecycle.test.mjs` inserts fake rows, runs real cleanup, verifies only the live real row remains and the pending placeholder survives.
- AC9: PASS. DB cleanup excludes `pending-*`; existing sessions_history handoff test plus AC8 verify pending placeholder safety.

## Commits

- `57800ef` feat(db): sessions_history granular cleanup SQL
- `549df7f` feat(hub): add sessions_history cleanup endpoints
- `07bb28a` feat(cli): add jianmu sessions cleanup commands
- `70e6f36` feat(feishu): require approval for session cleanup
- `f2886c1` test: add sessions_history cleanup lifecycle e2e

## Verification

- `node --test tests/sessions-history-cleanup.test.mjs`: PASS
- `node --test tests/http-sessions-history-cleanup.test.mjs`: PASS
- `node --test tests/command-parser.test.mjs tests/console-cards.test.mjs`: PASS
- `node --test tests/sessions-history.test.mjs`: PASS
- `node --test tests/e2e/sessions-history-cleanup-lifecycle.test.mjs`: PASS
- Real Hub + CLI temp DB AC1-AC4 script: PASS
- `npm test`: PASS on second full run

Push status: PASS, `master` pushed to `github-xihe:xihe-forge/xihe-jianmu-ipc.git` (`ee793d1..f2886c1`).

EXIT 0
