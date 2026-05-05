import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
  TEST_TIMEOUT,
} from '../helpers/hub-fixture.mjs';

test('agent-bound tasks survive same-name session rebind and exclude completed tasks', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'task-agent-rebind-lifecycle' });
  let first = null;
  let second = null;
  try {
    first = await connectSession(hub.port, 'agent-bind-life');

    const pending = await httpRequest(hub.port, {
      method: 'POST',
      path: '/task',
      json: { from: 'agent-bind-life', to: 'agent-bind-life', title: 'pending task' },
    });
    const active = await httpRequest(hub.port, {
      method: 'POST',
      path: '/task',
      json: { from: 'agent-bind-life', to: 'agent-bind-life', title: 'active task' },
    });
    const done = await httpRequest(hub.port, {
      method: 'POST',
      path: '/task',
      json: { from: 'agent-bind-life', to: 'agent-bind-life', title: 'done task' },
    });
    assert.equal(pending.statusCode, 201);
    assert.equal(active.statusCode, 201);
    assert.equal(done.statusCode, 201);

    await httpRequest(hub.port, {
      method: 'PATCH',
      path: `/tasks/${encodeURIComponent(active.body.taskId)}`,
      json: { status: 'in_progress' },
    });
    await httpRequest(hub.port, {
      method: 'PATCH',
      path: `/tasks/${encodeURIComponent(done.body.taskId)}`,
      json: { status: 'completed' },
    });

    await closeWebSocket(first);
    first = null;
    second = await connectSession(hub.port, 'agent-bind-life', { force: true });

    const listed = await httpRequest(hub.port, {
      method: 'GET',
      path: '/tasks?agent=agent-bind-life&limit=10',
    });
    assert.equal(listed.statusCode, 200);
    const restorable = listed.body.tasks.filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status));
    assert.deepEqual(
      restorable.map((task) => task.title).sort(),
      ['active task', 'pending task'],
    );
  } finally {
    await closeWebSocket(first);
    await closeWebSocket(second);
    await stopHub(hub);
  }
});
