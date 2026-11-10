import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { OwnerBackupResourceAccess } from '../dist/adapters/lifecycle/OwnerBackupResourceAccess.js';
function fixture(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-owner-backup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const owner = createFilesystemTeamOwner({ root, binding, store, members: [{ memberId: 'TEST-lead', name: 'team-lead', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] }] });
  const api = owner.connect('human');
  const receipt = api.execute({ commandId: 'TEST-create', operation: 'task.create', payload: { subject: 'original task' } });
  const taskId = (receipt.result as { id: string }).id;
  const path = `tasks/${binding.teamName}/${taskId}.json`;
  const backup = new OwnerBackupResourceAccess(store, binding);
  return { root, store, owner, api, path, taskId, backup };
}
test('missing Task resource restores its proven current bytes without replaying original handler or notifications', t => {
  const f = fixture(t), captured = f.backup.capture(f.path);
  const commands = f.store.list('commands');
  unlinkSync(join(f.root, f.path));
  assert.equal(f.backup.restoreMissing(f.path, captured.bytes, captured.proof), 'restored');
  assert.deepEqual(readFileSync(join(f.root, f.path)), captured.bytes);
  assert.deepEqual(f.store.list('commands'), commands);
});
test('completed deletion defeats an older backup even when Task destination is missing; neighboring Task commands remain usable', t => {
  const f = fixture(t), captured = f.backup.capture(f.path);
  const receipt = f.api.execute({ commandId: 'TEST-delete', operation: 'task.lifecycle', payload: { taskId: f.taskId, action: 'delete' } });
  unlinkSync(join(f.root, f.path));
  assert.equal(f.backup.restoreMissing(f.path, captured.bytes, captured.proof), 'held');
  assert.equal(f.api.lookup('TEST-delete')!.fingerprint, receipt.fingerprint);
  assert.equal(f.api.execute({ commandId: 'TEST-neighbor', operation: 'task.create', payload: { subject: 'neighbor' } }).phase, 'completed');
});
test('newer completed update is never overwritten or resurrected from older backup bytes', t => {
  const f = fixture(t), captured = f.backup.capture(f.path);
  f.api.execute({ commandId: 'TEST-update', operation: 'task.update', payload: { taskId: f.taskId, description: 'newer update' } });
  const current = readFileSync(join(f.root, f.path));
  assert.equal(f.backup.restoreMissing(f.path, captured.bytes, captured.proof), 'current');
  assert.deepEqual(readFileSync(join(f.root, f.path)), current);
  unlinkSync(join(f.root, f.path));
  assert.equal(f.backup.restoreMissing(f.path, captured.bytes, captured.proof), 'held');
  assert.equal(f.backup.restoreMissing(f.path, Buffer.from('corrupt'), captured.proof), 'held');
});
