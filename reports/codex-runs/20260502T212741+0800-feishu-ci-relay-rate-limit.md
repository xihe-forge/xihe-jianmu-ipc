# Feishu ci-relay rate limit backoff

## Summary

- EXIT: 0
- Scope: `lib/ci-relay.mjs`, `tests/ci-relay.test.mjs`
- Fix: Feishu list-unread-messages rate limit `15120000` now enters 5min polling backoff and resumes afterward.

## Before

- `data/hub.log` grep count for `[ci-relay] list unread messages failed: [15120000] hit rate limit, try again later`: 4
- Last observed lines:
  - `[ci-relay] list unread messages failed: [15120000] hit rate limit, try again later`
  - `[ci-relay] list unread messages failed: [15120000] hit rate limit, try again later`
  - `[ci-relay] list unread messages failed: [15120000] hit rate limit, try again later`
  - `[ci-relay] list unread messages failed: [15120000] hit rate limit, try again later`

## After

- Unit mock: `node --test tests\ci-relay.test.mjs` exit 0, 10/10 pass.
- Full baseline: `npm test` exit 0.
- Silent aggregate verification: `npm test` exit 0, pass_sum=875.
- Count note: repository baseline was 873/873; this change adds 2 focused `ci-relay` tests, so the post-change aggregate is 875/875.

## Dogfood Live Verify

- Mode: local HTTP mock Feishu API returning `{ code: 15120000, msg: "[15120000] hit rate limit, try again later" }`; actual `startCIRelay` interval polling, not dry-run.
- Result JSON: `{"requests":2,"duringBackoffRequests":1,"resumed":true}`
- Log truth:
  - `[ci-relay] list unread messages rate limited: [15120000] hit rate limit, try again later; entering 5min backoff at 2026-05-02T13:30:00.000Z; resumes at 2026-05-02T13:35:00.000Z`
  - `[ci-relay] resuming poll at 2026-05-02T13:35:00.000Z`

## Acceptance Criteria

- AC1: PASS. Added `RATE_LIMIT_ERROR_CODE = 15120000` and `RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000`.
- AC2: PASS. `pollMailbox` catches thrown/list response rate-limit errors and sets `backoffUntilMs = now + 5min`.
- AC3: PASS. Interval tick calls `pollMailbox`, which checks `backoffUntilMs`; it skips polling before expiry and resumes afterward.
- AC4: PASS. Logs include `entering 5min backoff at <ISO ts>; resumes at <ISO ts>` and `resuming poll at <ISO ts>`.
- AC5: PASS. Mock SDK test verifies no list polling during 5min backoff and recovery after expiry.
- AC6: PASS. Full `npm test` exit 0; aggregate 875/875 after adding 2 focused tests over the 873 baseline.
- AC7: PASS. Local mock Feishu API live verification shows backoff log and no polling during the backoff window.
