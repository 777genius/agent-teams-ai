import assert from 'node:assert/strict';
import type { UiCdpPort } from './desktop-team-ui-smoke.ts';
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
export async function runDesktopBackendBridgeProof(
  cdp: UiCdpPort,
  options: {
    handleId: string;
    root: string;
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  const { evidence } = options;
  const operations = evidence.operations as unknown[];
  const invoke = async (
    operation: string,
    commandId: string,
    payload: unknown,
    handleId = options.handleId
  ) => {
    options.assertOwnedRenderer();
    const request = { handle: { handleId }, commandId, operation, payload };
    const result = object(
      await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${JSON.stringify(request)})`)
    );
    assert.equal(
      JSON.stringify(result).includes(options.root),
      false,
      'safe renderer projection contains no private paths'
    );
    operations.push({ operation, commandId, handleId, result });
    return result;
  };
  const createPayload = { subject: 'TEST desktop bridge task', owner: 'alice' };
  const create = await invoke('task.create', 'TEST-create', createPayload);
  assert.equal(create.ok, true);
  const created = object(create.value);
  assert.equal(created.phase, 'completed');
  const taskId = object(created.task).id;
  assert.equal(typeof taskId, 'string');
  assert.deepEqual(await invoke('task.create', 'TEST-create', createPayload), create);
  assert.deepEqual(await invoke('command.lookup', 'TEST-create', {}), create);
  assert.deepEqual(await invoke('task.create', 'TEST-create', { subject: 'different intent' }), {
    ok: false,
    code: 'conflict',
    outcome: 'rejected',
  });
  for (const [operation, commandId, payload] of [
    [
      'task.update',
      'TEST-update',
      {
        taskId,
        subject: 'TEST updated through preload',
        description: 'TEST isolated backend bridge proof',
      },
    ],
    [
      'task.comment',
      'TEST-comment',
      { taskId, text: 'TEST comment through actual main Host transport' },
    ],
    ['task.lifecycle', 'TEST-start', { taskId, action: 'start' }],
    ['task.lifecycle', 'TEST-complete', { taskId, action: 'complete' }],
  ] as const) {
    const result = await invoke(operation, commandId, payload);
    assert.equal(result.ok, true);
    assert.equal(object(result.value).phase, 'completed');
    assert.deepEqual(await invoke(operation, commandId, payload), result);
  }
  const listed = await invoke('tasks.list', 'TEST-list', {});
  assert.equal(listed.ok, true);
  assert.ok(Array.isArray(listed.value));
  assert.equal(listed.value.length, 1);
  const task = object(listed.value[0]);
  assert.equal(task.id, taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.owner, 'alice');
  assert.equal(task.subject, 'TEST updated through preload');
  assert.ok(Array.isArray(task.comments));
  assert.equal(task.comments.length, 1);
  assert.equal(object(task.comments[0]).author, 'user');
  const forged = await invoke(
    'task.create',
    'TEST-forged',
    { subject: 'must never dispatch' },
    'TEST-forged-handle'
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.outcome, 'not-dispatched');
  const afterForged = await invoke('tasks.list', 'TEST-list-after-forged', {});
  assert.deepEqual(afterForged, listed, 'forged handle never falls back to another owner');
}
