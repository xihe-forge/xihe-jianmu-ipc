import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, stopHub, httpRequest, TEST_TIMEOUT } from '../helpers/hub-fixture.mjs';

test('PATCH /tasks/:id accepts in_progress and list can filter it', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'task-in-progress-status' });
  try {
    const created = await httpRequest(hub.port, {
      method: 'POST',
      path: '/task',
      json: {
        from: 'agent-bind-red',
        to: 'agent-bind-red',
        title: 'restore active task',
        description: 'created by CC TaskCreate hook',
      },
    });
    assert.equal(created.statusCode, 201);

    const taskId = created.body.taskId;
    const patched = await httpRequest(hub.port, {
      method: 'PATCH',
      path: `/tasks/${encodeURIComponent(taskId)}`,
      json: { status: 'in_progress' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.body.task.status, 'in_progress');

    const listed = await httpRequest(hub.port, {
      method: 'GET',
      path: '/tasks?agent=agent-bind-red&status=in_progress&limit=10',
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.body.tasks.some((task) => task.id === taskId));
  } finally {
    await stopHub(hub);
  }
});
