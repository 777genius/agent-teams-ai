import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { FileTeamRegistryStore } from '../dist/adapters/team-registry/FileTeamRegistryStore.js';
import { admitRegistryTeamNamespace } from '../dist/adapters/team-registry/admitRegistryTeamNamespace.js';
import { TeamRegistry } from '../dist/team-registry/TeamRegistry.js';
import { TeamPermanentDeletionCoordinator } from '../dist/adapters/lifecycle/TeamPermanentDeletionCoordinator.js';
import { createOwnerLifecycleIdentity } from '../dist/adapters/lifecycle/createOwnerLifecycleIdentity.js';
import { createOwnerScopedTeamPurge } from '../dist/adapters/lifecycle/OwnerScopedTeamPurge.js';
import { createTeamLifecycleRetirement } from '../dist/composition/createTeamLifecycleRetirement.js';
import type { HostedTeamDefinition } from '../dist/team-registry/definition.js';

test('cold static admission and original dynamic registry preserve deletion without recreating data; only original current captured scope can read proof', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-cold-lifecycle-retirement-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = { teams: join(root, 'teams'), tasks: join(root, 'tasks'), appData: join(root, 'appData'), backups: join(root, 'backups') };
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
  const coordinator = new TeamPermanentDeletionCoordinator({ awaitInitialization: async () => {}, isInitialized: () => true,
    isShuttingDown: () => false, withTeamMutex: async (_name, operation) => operation(), registry: () => ({}),
    loadManifest: async () => null, saveManifest: async () => {}, saveRegistryEntry: async () => {} }, roots);
  await coordinator.initialize();
  const hostOwner = { ownerId: 'TEST-owner', profileId: 'TEST-profile' };
  let current = true, bootstraps = 0;
  const retirement = createTeamLifecycleRetirement({ owner: hostOwner, principalId: 'human', coordinator,
    assertCurrent() { if (!current) throw new Error('TEST-profile-revoked'); } });
  let captured: { definition: HostedTeamDefinition; store: TeamOwnerStore; owner: ReturnType<typeof createFilesystemTeamOwner> } | undefined;
  const registryOptions = {
    ownerId: 'TEST-owner', profileId: 'TEST-profile', principalId: 'human', contextIds: ['TEST-context'], staticTeams: [],
    store: new FileTeamRegistryStore(root, () => {}), assertWriter() {}, isRetired: retirement.isRetired,
    admit: (definition: HostedTeamDefinition, fresh: boolean, published: boolean) => admitRegistryTeamNamespace(root, definition.binding, fresh, published),
    attach(definition: HostedTeamDefinition) {
      bootstraps++;
      const store = new TeamOwnerStore(root, definition.binding.teamName);
      const owner = createFilesystemTeamOwner({ root, store, binding: definition.binding,
        members: definition.members.map(({ memberId, name, role, delivery, settings }) => ({ memberId, name, role,
          ...(delivery ? { delivery } : {}), ...(settings === undefined ? {} : { settings }) })),
        grants: definition.grants.map(({ principalId, memberName, permissions, revoked }) => ({ principalId, memberName, permissions,
          ...(revoked === undefined ? {} : { revoked }) })),
        ...(definition.savedSettings ? { savedSettings: definition.savedSettings } : {}) });
      captured = { definition, store, owner };
    },
  };
  const registry = new TeamRegistry(registryOptions);
  const payload = { contextId: 'TEST-context', teamName: 'TEST-dynamic-team', savedSettings: { cwd: root, prompt: 'TEST', color: 'blue' }, members: [] };
  registry.create('TEST-create-original', payload);
  assert.ok(captured);
  const original = captured;
  const identity = createOwnerLifecycleIdentity({ store: original.store, binding: original.definition.binding, coordinator, assertWriter() {},
    withReadAuthority: operation => original.owner.withLaunchAuthority('human', 'read', operation) });
  await identity.publish();
  const lifecycle = original.owner.lifecycleCommands('human');
  lifecycle.execute({ commandId: 'TEST-trash', operation: 'trash', expectedRevision: lifecycle.view().revision });
  original.owner.lifecycleContinuation().settleCleanup('TEST-trash', receipt => { assert.equal(receipt.targets.length + receipt.runtimeBindings.length, 0); });
  const revision = lifecycle.view().revision;
  const purge = createOwnerScopedTeamPurge({ binding: original.definition.binding, capturedScope: original.definition.scope, store: original.store, roots, lifecycle: original.owner.lifecycleContinuation(), principalId: 'human', coordinator,
    assertWriter() {}, authorizePurge: () => original.owner.withLaunchAuthority('human', 'control', () => {}), assertReferencesReleased() {}, onPurged: () => retirement.retainPurged(original.definition) });
  await purge.purge('TEST-purge', revision);
  const namespace = join(roots.teams, original.definition.binding.teamName);
  assert.equal(existsSync(namespace), false);
  await coordinator.initialize();
  // This is the exact pre-attach guard for a static profile; no owner/store constructor runs.
  assert.equal(retirement.isRetired(original.definition), true);
  new TeamRegistry(registryOptions).restore();
  assert.equal(bootstraps, 1);
  assert.equal(existsSync(namespace), false);
  assert.deepEqual(registry.list('TEST-context').teams.map(row => row.teamId), [original.definition.binding.teamId], 'Main retains original routing metadata; lifecycle display read filters its retired scope');
  const envelope = { owner: hostOwner, scope: original.definition.scope };
  assert.equal((await retirement.lookup(envelope, 'TEST-purge', revision))?.phase, 'deleted');
  await assert.rejects(retirement.lookup({ ...envelope, scope: { ...original.definition.scope, projectId: 'different-context' } }, 'TEST-purge', revision));
  await assert.rejects(retirement.lookup({ ...envelope, owner: { ...hostOwner, profileId: 'different-profile' } }, 'TEST-purge', revision));
  registry.create('TEST-create-neighbor', { ...payload, teamName: 'TEST-neighbor' });
  assert.equal(bootstraps, 2, 'unrelated Team remains usable');
  current = false;
  await assert.rejects(retirement.lookup(envelope, 'TEST-purge', revision), /profile-revoked/);
  assert.equal(existsSync(namespace), false);
});
