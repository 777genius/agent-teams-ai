import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createHostTeamLifecycleComposition } from '../dist/composition/createHostTeamLifecycleComposition.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';
import type { JsonValue } from '../dist/index.js';
import type { HostedTeam } from '../dist/composition/RuntimeTeamCoordinator.js';
import type { HostedTeamDefinition } from '../dist/team-registry/definition.js';

function fixture(t: TestContext, existingRoot?: string, principalId = 'human') {
  const root = existingRoot ?? realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-lifecycle-composition-')));
  if (!existingRoot) t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { principalId, owner: { ownerId: 'TEST-owner', revision: 'TEST-revision', storageRoot: root,
    profileId: 'TEST-profile', protocolVersion: 1 as const, buildId: 'TEST-build', nodeSha256: '0'.repeat(64), hostEntrySha256: '0'.repeat(64) } };
  const definition: HostedTeamDefinition = {
    binding: { backendId: profile.owner.ownerId, teamId: 'TEST-team-id', teamName: 'TEST-team' },
    scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: 'TEST-team-id', runId: 'TEST-run', memberId: 'human', generation: '1' },
    members: [{ memberId: 'lead-id', name: 'lead', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'task.write', 'message.write'] },
      { principalId: 'native-lead', memberName: 'lead', permissions: ['read', 'message.write'] }],
  };
  const store = new TeamOwnerStore(root, definition.binding.teamName);
  const owner = createFilesystemTeamOwner({ root, store, binding: definition.binding,
    members: [{ memberId: 'lead-id', name: 'lead', role: 'lead' }], grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'task.write', 'message.write'] },
      { principalId: 'native-lead', memberName: 'lead', permissions: ['read', 'message.write'] }], });
  const teams = new Map<string, HostedTeam>();
  const team: HostedTeam = { definition, owner, connection: owner.connect('human'), operatorPrincipalId: 'human' };
  teams.set(definition.binding.teamId, team);
  let sealed = false;
  const lifecycle = createHostTeamLifecycleComposition({ profile, teams, runtime: () => undefined, importer: () => undefined,
    assertCurrent() { if (sealed) throw new TeamOwnerError('hold'); }, assertWriter() {}, isShuttingDown: () => sealed });
  lifecycle.stores.set(definition.binding.teamId, store);
  const envelope = (commandId: string, payload: JsonValue) => ({ commandId, binding: { schemaVersion: 1, handleId: 'TEST-handle', owner: profile.owner, scope: definition.scope }, payload });
  async function call(method: string, commandId: string, payload: JsonValue): Promise<Record<string, unknown>> {
    const handler = lifecycle.methods[method]; assert.ok(handler);
    const result = await handler.handle(envelope(commandId, payload), { requestId: commandId, signal: new AbortController().signal });
    assert.ok(result && typeof result === 'object' && !Array.isArray(result)); return result;
  }
  return { root, profile, definition, owner, store, teams, lifecycle, call, seal: () => { sealed = true; } };
}
const object = (value: unknown): Record<string, unknown> => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; };

test('WorkSync identity uses the exact injected store and actual principal; no human fallback', async t => {
  const f = fixture(t), teamId = f.definition.binding.teamId;
  await assert.rejects(f.lifecycle.storage.identity(teamId, 'not-a-grant'));
  const identity = await f.lifecycle.storage.identity(teamId, 'native-lead');
  assert.deepEqual((await identity.readCurrent('TEST-team')).status, 'identified');
  identity.assertWorkAllowed();
  const config = JSON.parse(readFileSync(join(f.root, 'teams/TEST-team/config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config._backupIdentityId, teamId);
  assert.equal(f.lifecycle.storage.resources(teamId).store, f.store);
  const before = f.store.read('state.json');
  const current = await identity.withCurrentPublication('TEST-team', teamId, async assertCurrent => { assertCurrent(); return 'TEST-fixed-publication'; });
  assert.equal(current.current, true); assert.deepEqual(f.store.read('state.json'), before);
});

test('product-only empty queue is readable and original zero-native trash settles without fabricated Runtime proof', async t => {
  const f = fixture(t);
  const queued = await f.call('team.queue.read', 'TEST-empty-queue', { member: 'lead' });
  assert.equal(queued.ok, true);
  const before = f.owner.lifecycleCommands('human').view();
  const changed = await f.call('team.lifecycle.change', 'TEST-trash', { expectedRevision: before.revision, action: 'trash' });
  assert.equal(changed.ok, true);
  const view = await f.call('team.lifecycle.read', 'TEST-read', {});
  assert.equal(object(view.value).cleanupPending, false);
  const captured = f.owner.lifecycleContinuation().capturedCleanup('TEST-trash');
  assert.deepEqual(captured.runtimeBindings, []); assert.deepEqual(captured.targets, []);
  const restored = await f.call('team.lifecycle.change', 'TEST-restore', { expectedRevision: f.owner.lifecycleCommands('human').view().revision, action: 'restore' });
  assert.equal(restored.ok, true);
  assert.equal(f.owner.lifecycleCommands('human').view().deletedAt, null);
});

test('final backup after ingress seal uses original writer; missing original store reports held Team IDs', async t => {
  const f = fixture(t);
  await f.lifecycle.storage.identity(f.definition.binding.teamId, 'native-lead');
  f.seal(); await f.lifecycle.shutdown();
  assert.equal(existsSync(join(f.root, 'backups/teams/TEST-team/manifest.json')), true);
  f.lifecycle.stores.delete(f.definition.binding.teamId);
  await assert.rejects(f.lifecycle.shutdown(), error => {
    assert.deepEqual(object(error).heldTeamIds, ['TEST-team-id']); return true;
  });
});

test('actual TeamHost publishes lifecycle routes and drains singleton storage before releasing its original lease', async t => {
  const f = fixture(t), input = new PassThrough(), output = new PassThrough();
  const host = createTeamHost({ schemaVersion: 1, ...f.profile, teams: [f.definition] }, { input, output });
  const lines = createInterface({ input: output }), frames = lines[Symbol.asyncIterator]();
  try {
    assert.ok(host.handshake.capabilities.includes('team.lifecycle.read'));
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 'TEST-handshake', method: 'host.handshake', params: { protocolVersion: 1 } }) + '\n');
    const handshake = await frames.next(); assert.equal(handshake.done, false);
    assert.equal(object(JSON.parse(handshake.value!) as unknown).id, 'TEST-handshake');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 'TEST-read', method: 'team.lifecycle.read', params: {
      commandId: 'TEST-read', binding: { schemaVersion: 1, handleId: 'TEST-handle', owner: f.profile.owner, scope: f.definition.scope }, payload: {},
    } }) + '\n');
    const frame = await frames.next(); assert.equal(frame.done, false);
    assert.equal(object(object(JSON.parse(frame.value!) as unknown).result).ok, true);
  } finally {
    const closed = await host.dispose(); lines.close(); assert.equal(closed.cleanup, 'completed');
  }
  assert.equal(existsSync(join(f.root, 'backups/teams/TEST-team/manifest.json')), true);
  const lease = acquireProfileWriterLease(f.root); lease.assertCurrent(); lease.release();
});


test('first product-only purge publishes the exact owner identity before preparing deletion without prior backup or WorkSync', async t => {
  const f = fixture(t), name = f.definition.binding.teamName;
  const configPath = join(f.root, 'teams', name, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(config._backupIdentityId, undefined);
  await f.call('team.lifecycle.change', 'TEST-trash-first-purge', { expectedRevision: f.owner.lifecycleCommands('human').view().revision, action: 'trash' });
  const revision = f.owner.lifecycleCommands('human').view().revision;
  const purged = await f.call('team.lifecycle.purge', 'TEST-first-purge', { expectedRevision: revision });
  assert.equal(purged.ok, true);
  assert.equal(object(purged.value).phase, 'deleted');
  assert.equal(existsSync(join(f.root, 'teams', name)), false);
  const intent = f.lifecycle.storage.coordinator.readOwnerDeletionIntentSync(name, f.definition.binding.teamId);
  assert.equal(intent?.identityId, f.definition.binding.teamId);
  assert.equal(intent?.ownerRequest?.commandId, 'TEST-first-purge');
  assert.equal(intent?.cleanupCompleted, true);
});

test('cold prepared purge read is inert, publishes only original retry coordinates, and explicit retry completes the same transaction', async t => {
  const f = fixture(t), name = f.definition.binding.teamName;
  await f.lifecycle.storage.identity(f.definition.binding.teamId, 'human');
  await f.call('team.lifecycle.change', 'TEST-trash-before-crash', { expectedRevision: f.owner.lifecycleCommands('human').view().revision, action: 'trash' });
  const revision = f.owner.lifecycleCommands('human').view().revision;
  // Simulate process loss after durable prepare, before the original destructive boundary.
  f.lifecycle.storage.coordinator.commitPermanentDeletionBoundary = async () => { throw new Error('TEST-crash-after-prepare'); };
  const failed = await f.call('team.lifecycle.purge', 'TEST-original-purge', { expectedRevision: revision });
  assert.deepEqual(failed, { ok: false, code: 'hold', outcome: 'unknown' });
  const intentPath = join(f.root, 'backups', 'permanent-deletion-intents', encodeURIComponent(name) + '.json');
  const preparedBytes = readFileSync(intentPath);
  const prepared = JSON.parse(preparedBytes.toString()) as Record<string, unknown>;
  assert.equal(prepared.phase, 'prepared');
  f.seal();
  const viewer = fixture(t, f.root, 'native-lead');
  const viewerRead = await viewer.call('team.lifecycle.read', 'TEST-other-principal-read', {});
  assert.equal(viewerRead.ok, true);
  assert.equal(object(viewerRead.value).pendingPurge, undefined, 'original command is private to its captured principal');
  const cold = fixture(t, f.root);
  const read = await cold.call('team.lifecycle.read', 'TEST-cold-read', {});
  assert.deepEqual(object(read.value).pendingPurge, { commandId: 'TEST-original-purge', expectedRevision: revision });
  await cold.lifecycle.storage.initialize();
  assert.deepEqual(readFileSync(intentPath), preparedBytes, 'cold initialization and read must not cross or rewrite prepared intent');
  assert.equal(existsSync(join(f.root, 'teams', name)), true);
  const restore = await cold.call('team.lifecycle.change', 'TEST-no-restore-takeover', { expectedRevision: revision, action: 'restore' });
  assert.equal(restore.ok, false);
  const replacementCommand = await cold.call('team.lifecycle.purge', 'TEST-new-purge-must-not-take-over', { expectedRevision: revision });
  assert.equal(replacementCommand.ok, false);
  assert.deepEqual(readFileSync(intentPath), preparedBytes, 'new command cannot replace prepared original');
  const resumed = await cold.call('team.lifecycle.purge', 'TEST-original-purge', { expectedRevision: revision });
  assert.equal(resumed.ok, true);
  assert.equal(object(resumed.value).transactionId, prepared.transactionId);
  assert.equal(existsSync(join(f.root, 'teams', name)), false);
  const lookup = await cold.call('team.lifecycle.purge.lookup', 'TEST-original-purge', { expected: { expectedRevision: revision } });
  assert.equal(lookup.ok, true);
  assert.equal(object(lookup.value).transactionId, prepared.transactionId);
  assert.equal(object(lookup.value).phase, 'deleted');
});
