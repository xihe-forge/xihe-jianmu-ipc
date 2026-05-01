import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSessionName } from '../lib/session-names.mjs';

test('validateSessionName accepts historical snake_case names', () => {
  assert.deepEqual(validateSessionName('yuheng_builder'), {
    ok: true,
    name: 'yuheng_builder',
  });
});

test('validateSessionName still rejects PID-based fallback names', () => {
  assert.deepEqual(validateSessionName('session-12345'), {
    ok: false,
    error: 'PID-based session names are not allowed',
  });
});

test('validateSessionName still rejects uppercase names with underscore', () => {
  assert.deepEqual(validateSessionName('AB_C'), {
    ok: false,
    error: 'session name must match [a-z0-9_-]+',
  });
});
