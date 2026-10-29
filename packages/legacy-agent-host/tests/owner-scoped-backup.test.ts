import { createTeamBackupComposition } from '../dist/composition/createTeamBackupComposition.js';
import { pruneDeletedTeamBackups } from '../dist/adapters/lifecycle/pruneDeletedTeamBackups.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamPermanentDeletionCoordinator } from '../dist/adapters/lifecycle/TeamPermanentDeletionCoordinator.js';
import { createOwnerLifecycleIdentity } from '../dist/adapters/lifecycle/createOwnerLifecycleIdentity.js';
import { createOwnerScopedTeamPurge } from '../dist/adapters/lifecycle/OwnerScopedTeamPurge.js';
import { OwnerScopedTeamBackup } from '../dist/adapters/lifecycle/OwnerScopedTeamBackup.js';
import { readBackupManifestStrictSync, getBackupManifestPath, writeBackupManifest } from '../dist/adapters/lifecycle/teamBackupManifest.js';
import { createOwnerBackupRegistry } from '../dist/adapters/lifecycle/createOwnerBackupRegistry.js';
import { createOwnerPurgeRequest } from '../dist/adapters/lifecycle/ownerPurgeRequest.js';
async function fixture(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-owner-scoped-backup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' }, store = new TeamOwnerStore(root, binding.teamName);
  const owner = createFilesystemTeamOwner({ root, binding, store, members: [{ memberId: 'lead', name: 'team-lead', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'task.write'] }] });
  const roots = { teams: join(root, 'teams'), tasks: join(root, 'tasks'), appData: join(root, 'appData'), backups: join(root, 'backups') };
  for (const directory of Object.values(roots)) mkdirSync(directory, { recursive: true });
  const backupDirectory = join(roots.backups, 'teams', binding.teamName);
  const registry = createOwnerBackupRegistry({ directory: roots.backups, assertWriter() {}, withSharedLock: (scope, operation) => coordinator.withSharedLock(scope, operation) });
  const coordinator = new TeamPermanentDeletionCoordinator({ awaitInitialization: async () => {}, isInitialized: () => true,
    isShuttingDown: () => false, withTeamMutex: async (_name, operation) => operation(), registry: registry.entries,
    loadManifest: async () => readBackupManifestStrictSync(getBackupManifestPath(backupDirectory), binding.teamName),
    saveManifest: async (_name, manifest) => writeBackupManifest(backupDirectory, manifest), saveRegistryEntry: async (_name, entry) => registry.publish(entry) }, roots);
  await registry.initialize();
  await coordinator.initialize();
  const identity = createOwnerLifecycleIdentity({ store, binding, coordinator, assertWriter() {}, withReadAuthority: operation => owner.withLaunchAuthority('human', 'read', operation) });
  await identity.publish();
  const backup = new OwnerScopedTeamBackup({ store, binding, roots, backupDirectory, assertWriter() {},
    publishRegistryEntry: registry.publish,
    withIdentityFence: operation => coordinator.withTeamIdentityFence(binding.teamName, operation), assertPublicationCurrent: identity.assertProductPublicationCurrent });
  const api = owner.connect('human'), receipt = api.execute({ commandId: 'TEST-create', operation: 'task.create', payload: { subject: 'original task' } });
  const taskId = (receipt.result as { id: string }).id;
  return { root, store, owner, api, roots, backup, registry, coordinator, identity, taskId, taskPath: join(root, 'tasks', binding.teamName, `${taskId}.json`) };
}
test('existing backup manifest and canonical resource proof restore missing product files without replacing control state', async t => {
  const f = await fixture(t), controls = f.store.read('state.json'), commands = f.store.list('commands');
  assert.deepEqual((await f.backup.snapshot()).held, []);
  assert.equal(f.registry.entries()['TEST-team']!.identityId, 'TEST-team-id');
  unlinkSync(f.taskPath);
  unlinkSync(join(f.root, 'teams/TEST-team/config.json'));
  const result = await f.backup.restoreMissing();
  assert.equal(result.restored, 2);
  assert.deepEqual(result.held, []);
  assert.deepEqual(f.store.read('state.json'), controls);
  assert.deepEqual(f.store.list('commands'), commands);
});
test('actual completed delete/update defeat old backup per resource and deletion boundary fences further backup publication', async t => {
  const f = await fixture(t);
  await f.backup.snapshot();
  f.api.execute({ commandId: 'TEST-delete', operation: 'task.lifecycle', payload: { taskId: f.taskId, action: 'delete' } });
  unlinkSync(f.taskPath);
  assert.ok((await f.backup.restoreMissing()).held.includes(`tasks/${f.taskId}.json`));
  const next = f.api.execute({ commandId: 'TEST-neighbor', operation: 'task.create', payload: { subject: 'neighbor stays usable' } });
  assert.equal(next.phase, 'completed');
  const intent = await f.coordinator.beginPermanentDeletion('TEST-team');
  await f.coordinator.commitPermanentDeletionBoundary(intent);
  await assert.rejects(f.backup.snapshot());
  await assert.rejects(f.backup.restoreMissing());
});

test('original physical purge refuses retained references, then uses the same deletion proof and never restores deleted bytes', async t => {
  const f = await fixture(t);
  await f.backup.snapshot();
  const lifecycle = f.owner.lifecycleCommands('human');
  lifecycle.execute({ commandId: 'TEST-trash-before-purge', operation: 'trash', expectedRevision: lifecycle.view().revision });
  f.owner.lifecycleContinuation().settleCleanup('TEST-trash-before-purge', receipt => {
    assert.equal(receipt.targets.length, 0); assert.equal(receipt.runtimeBindings.length, 0);
  });
  let debt = true, purged = 0;
  const purge = createOwnerScopedTeamPurge({ binding: { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' },
    capturedScope: { projectId: 'TEST-context' }, store: f.store, roots: f.roots, lifecycle: f.owner.lifecycleContinuation(), principalId: 'human', coordinator: f.coordinator,
    assertWriter() {}, authorizePurge: () => f.owner.withLaunchAuthority('human', 'control', () => {}),
    assertReferencesReleased() { if (debt) throw new Error('TEST-retained-reference'); }, onPurged() { purged++; } });
  await assert.rejects(purge.purge('TEST-purge-command', lifecycle.view().revision), /retained-reference/);
  assert.equal(existsSync(f.taskPath), true); assert.equal(purged, 0);
  debt = false;
  assert.equal((await purge.purge('TEST-purge-command', lifecycle.view().revision)).deleted, true);
  assert.equal(existsSync(f.taskPath), false);
  assert.equal(existsSync(join(f.roots.teams, 'TEST-team/.host-owner/state.json')), false);
  assert.equal(f.registry.entries()['TEST-team']!.status, 'deleted_by_user');
  assert.equal(purged, 1);
  await assert.rejects(f.backup.restoreMissing());
});

test('physical target replacement is retained across purge failure and original recovery cannot bypass its identity proof', async t => {
  const f = await fixture(t), lifecycle = f.owner.lifecycleCommands('human');
  lifecycle.execute({ commandId: 'TEST-trash-replacement', operation: 'trash', expectedRevision: lifecycle.view().revision });
  f.owner.lifecycleContinuation().settleCleanup('TEST-trash-replacement', receipt => { assert.equal(receipt.targets.length + receipt.runtimeBindings.length, 0); });
  const oldTasks = join(f.root, 'TEST-original-task-debt'), taskNamespace = join(f.roots.tasks, 'TEST-team');
  let checks = 0;
  const purge = createOwnerScopedTeamPurge({ binding: { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' },
    capturedScope: { projectId: 'TEST-context' }, store: f.store, roots: f.roots, lifecycle: f.owner.lifecycleContinuation(), principalId: 'human', coordinator: f.coordinator,
    assertWriter() {}, authorizePurge: () => f.owner.withLaunchAuthority('human', 'control', () => {}),
    assertReferencesReleased() {
      if (++checks === 2) { renameSync(taskNamespace, oldTasks); mkdirSync(taskNamespace); writeFileSync(join(taskNamespace, 'TEST-replacement.json'), 'TEST-protected-replacement'); }
    }, onPurged() { assert.fail('replacement target cannot produce completed purge'); } });
  await assert.rejects(purge.purge('TEST-purge-command', lifecycle.view().revision));
  assert.equal(readFileSync(join(taskNamespace, 'TEST-replacement.json'), 'utf8'), 'TEST-protected-replacement');
  assert.equal(existsSync(join(oldTasks, `${f.taskId}.json`)), true);
  const original = (await f.coordinator.listPendingPermanentDeletions())[0]!;
  assert.equal(original.phase, 'deleting');
  await assert.rejects(purge.continueOriginal(original));
  assert.equal(readFileSync(join(taskNamespace, 'TEST-replacement.json'), 'utf8'), 'TEST-protected-replacement');
});

test('lost purge reply resolves only the original retained actor/CAS request after cold startup and removed Team data', async t => {
  const f = await fixture(t), binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const lifecycle = f.owner.lifecycleCommands('human');
  lifecycle.execute({ commandId: 'TEST-trash-cold', operation: 'trash', expectedRevision: lifecycle.view().revision });
  f.owner.lifecycleContinuation().settleCleanup('TEST-trash-cold', receipt => { assert.equal(receipt.targets.length + receipt.runtimeBindings.length, 0); });
  const revision = lifecycle.view().revision;
  let effects = 0;
  const purge = createOwnerScopedTeamPurge({ binding, capturedScope: { projectId: 'TEST-context' }, store: f.store, roots: f.roots, lifecycle: f.owner.lifecycleContinuation(), principalId: 'human', coordinator: f.coordinator,
    assertWriter() {}, authorizePurge: () => f.owner.withLaunchAuthority('human', 'control', () => {}),
    assertReferencesReleased() {}, onPurged() { effects++; throw new Error('TEST-lost-reply'); } });
  await assert.rejects(purge.purge('TEST-cold-purge', revision), /lost-reply/);
  assert.equal(existsSync(join(f.roots.teams, 'TEST-team')), false);
  await f.coordinator.initialize();
  const original = await purge.lookup('TEST-cold-purge', revision);
  assert.equal(original?.phase, 'deleted');
  assert.equal((await purge.purge('TEST-cold-purge', revision)).transactionId, original?.transactionId);
  assert.equal(effects, 1, 'exact retry returns original proof without repeating purge or publication');
  assert.equal(await purge.lookup('TEST-other-command', revision), null);
  assert.equal(await purge.lookup('TEST-cold-purge', '0'.repeat(64)), null);
  assert.equal(await f.coordinator.lookupOwnerPermanentDeletion(createOwnerPurgeRequest(binding, 'different-actor', 'TEST-cold-purge', revision, { projectId: 'TEST-context' })), null);
  assert.equal(await f.coordinator.lookupOwnerPermanentDeletion(createOwnerPurgeRequest(binding, 'human', 'TEST-cold-purge', revision, { projectId: 'TEST-ABA-context' })), null);
});

test('Host prepared purge retains original command across startup; legacy prepared intent keeps its rollback semantics', async t => {
  const f = await fixture(t), binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const request = createOwnerPurgeRequest(binding, 'human', 'TEST-prepared-purge', '0'.repeat(64), { projectId: 'TEST-context' });
  const intent = await f.coordinator.beginPermanentDeletion('TEST-team', { ownerRequest: request });
  await f.coordinator.initialize();
  assert.equal((await f.coordinator.lookupOwnerPermanentDeletion(request))?.transactionId, intent.transactionId);
  await assert.rejects(f.coordinator.beginPermanentDeletion('TEST-team', { ownerRequest: createOwnerPurgeRequest(binding, 'human', 'TEST-other', '0'.repeat(64), { projectId: 'TEST-context' }) }), /differs/);
  await f.coordinator.abortPreparedPermanentDeletion(intent);
  await f.coordinator.beginPermanentDeletion('TEST-team');
  await f.coordinator.initialize();
  assert.equal(await f.coordinator.lookupOwnerPermanentDeletion(request), null);
});

test('old backup retention holds referenced/debt artifacts and corrupt timestamps without blocking an unrelated owner backup', async t => {
  const f = await fixture(t);
  await f.backup.snapshot();
  const entry = { teamName: 'TEST-team', identityId: 'TEST-team-id', status: 'deleted_by_user' as const, deletedByUserAt: '2001-01-01T00:00:00.000Z', lastBackupAt: '2001-01-01T00:00:00.000Z' };
  const directory = join(f.roots.backups, 'teams/TEST-team');
  const manifest = readBackupManifestStrictSync(getBackupManifestPath(directory), 'TEST-team')!;
  await writeBackupManifest(directory, { ...manifest, status: 'deleted_by_user', deletedByUserAt: entry.deletedByUserAt }, { strict: true });
  await f.registry.publish(entry);
  let held = true;
  const options: Parameters<typeof pruneDeletedTeamBackups>[0] = { entries: f.registry.entries, directory: () => directory,
    withIdentityFence: (name: string, operation: () => Promise<boolean>) => f.coordinator.withTeamIdentityFence(name, operation),
    assertPrunable() { if (held) throw new Error('TEST-reference-debt'); },
    onPruned: async (_name, original) => f.registry.remove(original, () => {}), log() {} };
  assert.equal(await pruneDeletedTeamBackups(options), 0);
  assert.equal(existsSync(getBackupManifestPath(directory)), true);
  held = false;
  await f.registry.publish({ ...entry, deletedByUserAt: 'TEST-not-a-timestamp' });
  assert.equal(await pruneDeletedTeamBackups(options), 0);
  await f.registry.publish(entry);
  assert.equal(await pruneDeletedTeamBackups(options), 1);
  assert.equal(existsSync(directory), false);
});

test('final Host backup runs after ingress seal with the original owner/lease and includes latest completed Task outcomes', async t => {
  const f = await fixture(t);
  let sealed = false;
  const team = { owner: f.owner, definition: { scope: { projectId: 'TEST-context' }, binding: { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' } } };
  const storage = createTeamBackupComposition({ directories: f.roots, principalId: 'human', ownerId: 'TEST-owner',
    resources: teamId => { assert.equal(teamId, 'TEST-team-id'); return { team, store: f.store }; }, teamIds: () => ['TEST-team-id'],
    assertCurrent() { if (sealed) throw new Error('TEST ingress sealed'); }, assertWriter() {}, isShuttingDown: () => sealed,
    assertBackupPrunable() { assert.fail('active Team is not a deleted-retention candidate'); } });
  await storage.run('TEST-team-id', 'snapshot');
  const latest = f.api.execute({ commandId: 'TEST-final-task', operation: 'task.create', payload: { subject: 'latest original completed command' } });
  const latestId = (latest.result as { id: string }).id;
  sealed = true;
  await assert.rejects(storage.run('TEST-team-id', 'snapshot'), /ingress sealed/);
  assert.deepEqual(await storage.shutdown(), { heldTeamIds: [] });
  const manifest = readBackupManifestStrictSync(getBackupManifestPath(join(f.roots.backups, 'teams/TEST-team')), 'TEST-team')!;
  assert.ok(manifest.fileStats[`tasks/${latestId}.json`]);
  assert.ok(manifest.fileStats[`tasks/${f.taskId}.json`]);
});
