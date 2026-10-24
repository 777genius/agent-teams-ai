import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';

test('nested synchronous same-store Team guards and cause reads retain outer authority lock', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-nested-fence-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new TeamOwnerStore(root, 'test-fence');
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-fence' };
  const delivery = { ...binding, runId: 'TEST-run', memberId: 'worker-id', generation: '1' };
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    store,
    members: [{ name: 'worker', memberId: 'worker-id', role: 'member', delivery }],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      {
        principalId: 'worker-principal',
        memberName: 'worker',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
  });
  const connection = owner.connect('human');
  const task = connection.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'TEST fence', owner: 'worker' },
  });
  const start = connection.execute({
    commandId: 'TEST-start',
    operation: 'task.start',
    payload: { taskId: task.effects.taskId, notification: 'user' },
  });
  const pending = connection.pendingDeliveries();
  const intent = pending.find((row) => row.commandId === start.commandId);
  const assignment = pending.find((row) => row.commandId === task.commandId);
  assert.ok(intent, 'exact original Task-start delivery exists');
  assert.ok(assignment, 'assigned-create delivery remains distinct');
  owner.withLaunchAuthority('human', 'read', () => {
    assert.equal(owner.authorizeMemberBinding(delivery, 'dispatch'), true);
    assert.equal(owner.lookupTaskStartCause('worker-principal', assignment), null);
    const cause = owner.lookupTaskStartCause('worker-principal', intent);
    assert.ok(cause);
    assert.equal(cause.taskId, task.effects.taskId);
    assert.equal(cause.taskStartCommandId, start.commandId);
    store.fenced(() => store.write('TEST-nested.json', { captured: true }));
  });
  assert.deepEqual(store.read('TEST-nested.json'), { captured: true });
  assert.throws(() =>
    store.fenced(() => {
      throw new Error('TEST interrupted');
    })
  );
  assert.equal(
    store.fenced(() => true),
    true,
    'exception restores nesting state'
  );
  const state = store.read<{ grants: { principalId: string; revoked?: boolean }[] }>('state.json')!;
  state.grants.find((grant) => grant.principalId === 'human')!.revoked = true;
  store.fenced(() => store.write('state.json', state));
  assert.throws(
    () => owner.withLaunchAuthority('human', 'read', () => true),
    'fresh outer admission observes revocation'
  );
});

test('a second store instance cannot reuse another store held canonical lock', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-cross-store-fence-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new TeamOwnerStore(root, 'test-fence');
  const second = new TeamOwnerStore(root, 'test-fence');
  first.fenced(() =>
    assert.throws(() => second.fenced(() => second.write('TEST-forbidden.json', true)))
  );
  assert.equal(first.read('TEST-forbidden.json'), undefined);
  assert.equal(
    second.fenced(() => true),
    true,
    'outer lock released after denied cross-store nesting'
  );
});
