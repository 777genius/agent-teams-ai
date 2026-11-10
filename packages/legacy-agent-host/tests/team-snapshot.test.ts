import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerError } from '../dist/team/contracts.js';

test('snapshot reads persisted authority/roster/tasks/kanban and only permitted inboxes', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-snapshot-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    root,
    binding: { backendId: 'TEST-A', teamId: 'TEST-team', teamName: 'test-team' },
    members: [{ memberId: 'alice', name: 'alice', role: 'member' as const }],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'admin', 'task.write'] as ('read' | 'admin' | 'task.write')[],
      },
      { principalId: 'alice', memberName: 'alice', permissions: ['read'] as 'read'[] },
    ],
  };
  const owner = createFilesystemTeamOwner(options);
  const human = owner.connect('human');
  human.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'actual task' },
  });
  mkdirSync(join(root, 'teams/test-team/inboxes'), { recursive: true });
  for (const name of ['alice', 'user'])
    writeFileSync(
      join(root, 'teams/test-team/inboxes', `${name}.json`),
      JSON.stringify([{ from: 'user', text: name, timestamp: '2026-01-01', read: false }])
    );
  const alice = owner.connect('alice');
  const own = alice.readSnapshot() as Record<string, unknown>;
  assert.equal((own.messages as { text: string }[]).length, 1);
  assert.equal((own.messages as { text: string }[])[0]!.text, 'alice');
  assert.equal(((human.readSnapshot() as Record<string, unknown>).messages as unknown[]).length, 2);
  assert.equal(((human.readSnapshot() as Record<string, unknown>).tasks as unknown[]).length, 1);
  const reopened = createFilesystemTeamOwner({ ...options, members: [] });
  assert.equal(
    ((reopened.connect('human').readSnapshot() as Record<string, unknown>).members as unknown[])
      .length,
    1
  );
  human.revoke('alice');
  assert.throws(
    () => alice.readSnapshot(),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden'
  );
  assert.equal(JSON.stringify(human.readSnapshot()).includes('principalId'), false);
});
