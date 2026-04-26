import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkEventBroadcaster } from '../lib/network-events.mjs';

test('broadcastNetworkDown: payload 严格符合 ADR 五字段', async () => {
  let deliveredTopic = null;
  let deliveredPayload = null;
  const broadcaster = createNetworkEventBroadcaster({
    router: {
      broadcastToTopic(topic, payload) {
        deliveredTopic = topic;
        deliveredPayload = payload;
        return ['session-a', 'session-b'];
      },
    },
    db: {
      listSuspendedSessions() {
        throw new Error('should not be called');
      },
      clearSuspendedSessions() {
        throw new Error('should not be called');
      },
    },
    now: () => 1776516090000,
  });

  const result = await broadcaster.broadcastNetworkDown({
    failing: ['cliproxy', 'anthropic'],
    since: 1776516000000,
  });

  assert.equal(deliveredTopic, 'network-down');
  assert.deepEqual(Object.keys(deliveredPayload).sort(), ['failing', 'since', 'triggeredBy', 'ts', 'type']);
  assert.deepEqual(deliveredPayload, {
    type: 'network-down',
    triggeredBy: 'watchdog',
    failing: ['cliproxy', 'anthropic'],
    since: 1776516000000,
    ts: 1776516090000,
  });
  assert.equal(result.broadcastTo, 2);
  assert.deepEqual(result.subscribers, ['session-a', 'session-b']);
});

test('broadcastNetworkUp: 只广播 suspended session 名单并在广播后清表', async () => {
  const callOrder = [];
  let deliveredTopic = null;
  let deliveredPayload = null;
  const broadcaster = createNetworkEventBroadcaster({
    router: {
      broadcastToTopic(topic, payload) {
        callOrder.push('broadcast');
        deliveredTopic = topic;
        deliveredPayload = payload;
        return ['wake-a'];
      },
    },
    db: {
      listSuspendedSessions() {
        callOrder.push('list');
        return [
          {
            name: 'houtu_builder',
            reason: 'network down',
            task_description: 'resume task A',
            suspended_at: 1776516000000,
            suspended_by: 'self',
          },
          {
            name: 'taiwei_builder',
            reason: 'dns failure',
            task_description: 'resume task B',
            suspended_at: 1776516005000,
            suspended_by: 'watchdog',
          },
        ];
      },
      clearSuspendedSessions() {
        callOrder.push('clear');
        return ['houtu_builder', 'taiwei_builder'];
      },
    },
    now: () => 1776516690000,
  });

  const result = await broadcaster.broadcastNetworkUp({
    recoveredAfter: 600000,
  });

  assert.deepEqual(callOrder, ['list', 'broadcast', 'clear']);
  assert.equal(deliveredTopic, 'network-up');
  assert.deepEqual(Object.keys(deliveredPayload).sort(), ['recoveredAfter', 'suspendedSessions', 'triggeredBy', 'ts', 'type']);
  assert.deepEqual(deliveredPayload, {
    type: 'network-up',
    triggeredBy: 'watchdog',
    recoveredAfter: 600000,
    suspendedSessions: ['houtu_builder', 'taiwei_builder'],
    ts: 1776516690000,
  });
  assert.equal(result.broadcastTo, 1);
  assert.deepEqual(result.subscribers, ['wake-a']);
  assert.deepEqual(result.clearedSessions, ['houtu_builder', 'taiwei_builder']);
});

test('T-ADR-006-V03-STEP9 broadcastNetworkUp filters suspended sessions by reason', async () => {
  const broadcaster = createNetworkEventBroadcaster({
    router: {
      broadcastToTopic() {
        return ['wake-a'];
      },
    },
    db: {
      listSuspendedSessions() {
        return [
          { name: 'network-a', reason: 'stuck-network' },
          { name: 'rate-a', reason: 'stuck-rate-limited' },
          { name: 'manual-a', reason: 'manual' },
        ];
      },
      clearSuspendedSessions(reason) {
        assert.equal(reason, 'stuck-rate-limited');
        return ['rate-a'];
      },
    },
    now: () => 1776516690000,
  });

  const result = await broadcaster.broadcastNetworkUp({ reason: 'stuck-rate-limited' });

  assert.deepEqual(result.payload.reason, 'stuck-rate-limited');
  assert.deepEqual(result.payload.suspendedSessions, ['rate-a']);
  assert.deepEqual(result.clearedSessions, ['rate-a']);
});
