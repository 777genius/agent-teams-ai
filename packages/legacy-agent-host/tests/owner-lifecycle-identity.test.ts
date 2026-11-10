import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamPermanentDeletionCoordinator } from '../dist/adapters/lifecycle/TeamPermanentDeletionCoordinator.js';
import { createOwnerLifecycleIdentity } from '../dist/adapters/lifecycle/createOwnerLifecycleIdentity.js';
import type { TeamGrant } from '../dist/team/contracts.js';
async function fixture(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-lifecycle-identity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' }, store = new TeamOwnerStore(root, binding.teamName);
  const owner = createFilesystemTeamOwner({ root, binding, store, members: [{ memberId: 'lead', name: 'team-lead', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin'] }] });
  const roots = { teams: join(root, 'teams'), tasks: join(root, 'tasks'), appData: join(root, 'appData'), backups: join(root, 'backups') };
  for (const directory of Object.values(roots)) mkdirSync(directory, { recursive: true });
  const coordinator = new TeamPermanentDeletionCoordinator({ awaitInitialization: async () => {}, isInitialized: () => true,
    isShuttingDown: () => false, withTeamMutex: async (_name, operation) => operation(), registry: () => ({}),
    loadManifest: async () => null, saveManifest: async () => {}, saveRegistryEntry: async () => {} }, roots);
  await coordinator.initialize();
  const identity = createOwnerLifecycleIdentity({ store, binding, coordinator, assertWriter() {},
    withReadAuthority: operation => owner.withLaunchAuthority('human', 'read', operation) });
  return { owner, store, identity, binding };
}
test('fixed retained Team identity is published once; canonical identity read/commit preserves the actual principal fence', async t => {
  const f = await fixture(t);
  await f.identity.publish();
  assert.equal(f.store.read<Record<string, unknown>>('../config.json')!._backupIdentityId, f.binding.teamId);
  assert.deepEqual(await f.identity.readCurrent('TEST-team'), { status: 'identified', identityId: f.binding.teamId });
  let commits = 0;
  assert.deepEqual(await f.identity.withCurrent('TEST-team', f.binding.teamId, () => ++commits), { current: true, value: 1 });
  f.store.fenced(() => { const state = f.store.read<{ grants: TeamGrant[] }>('state.json')!; state.grants[0]!.revoked = true; f.store.write('state.json', state); });
  await assert.rejects(f.identity.withCurrent('TEST-team', f.binding.teamId, () => ++commits));
  assert.equal(commits, 1);
});
test('replacement marker is neither adopted nor overwritten, and trash blocks new-work qualification without concealing identity', async t => {
  const f = await fixture(t);
  await f.identity.publish();
  const lifecycle = f.owner.lifecycleCommands('human');
  lifecycle.execute({ commandId: 'TEST-trash', operation: 'trash', expectedRevision: lifecycle.view().revision });
  assert.throws(() => f.identity.assertWorkAllowed());
  assert.deepEqual(await f.identity.readCurrent('TEST-team'), { status: 'identified', identityId: f.binding.teamId });
  f.store.fenced(() => { const config = f.store.read<Record<string, unknown>>('../config.json')!; config._backupIdentityId = 'TEST-replacement'; f.store.write('../config.json', config); });
  await assert.rejects(f.identity.publish());
  assert.equal(f.store.read<Record<string, unknown>>('../config.json')!._backupIdentityId, 'TEST-replacement');
  assert.deepEqual(await f.identity.readCurrent('TEST-team'), { status: 'unavailable' });
  assert.deepEqual(await f.identity.withCurrent('TEST-team', 'TEST-replacement', () => 'must not commit'), { current: false, identity: { status: 'unavailable' } });
});

test('local async publication holds incarnation while each commit re-enters current viewer authority', async t => {
  const f = await fixture(t);
  await f.identity.publish();
  let commits = 0;
  assert.deepEqual(await f.identity.withCurrentPublication('TEST-team', f.binding.teamId, async assertCurrent => {
    await Promise.resolve(); assertCurrent(); return ++commits;
  }), { current: true, value: 1 });
  await assert.rejects(f.identity.withCurrentPublication('TEST-team', f.binding.teamId, async assertCurrent => {
    await Promise.resolve();
    f.store.fenced(() => { const state = f.store.read<{ grants: TeamGrant[] }>('state.json')!; state.grants[0]!.revoked = true; f.store.write('state.json', state); });
    assertCurrent(); return ++commits;
  }));
  assert.equal(commits, 1, 'no publication after original principal is revoked between read and commit');
});
test('async publication cannot commit after original marker replacement even before final check', async t => {
  const f = await fixture(t);
  await f.identity.publish();
  let commits = 0;
  await assert.rejects(f.identity.withCurrentPublication('TEST-team', f.binding.teamId, async assertCurrent => {
    await Promise.resolve();
    f.store.fenced(() => { const config = f.store.read<Record<string, unknown>>('../config.json')!; config._backupIdentityId = 'TEST-replaced'; f.store.write('../config.json', config); });
    assertCurrent(); return ++commits;
  }));
  assert.equal(commits, 0);
});
