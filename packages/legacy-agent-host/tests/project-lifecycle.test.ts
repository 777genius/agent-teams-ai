import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHostTeamLifecycleComposition } from '../dist/composition/createHostTeamLifecycleComposition.js';
import { HostProjectTeamLifecycle } from '../dist/team-project-context/HostProjectTeamLifecycle.js';
import { assertProjectLifecycleIdle } from '../dist/team-project-context/projectLifecyclePlan.js';
import { projectTeamFixture, openProjectTeamFixture } from './projectTeamFixture.ts';

function lifecycle(f: ReturnType<typeof openProjectTeamFixture>) {
  const composition = createHostTeamLifecycleComposition({ profile: f.profile, teams: f.teams,
    registry: () => f.registry, runtime: () => undefined, importer: () => undefined,
    assertCurrent: () => f.lease.assertCurrent(), assertWriter: () => f.lease.assertCurrent(), isShuttingDown: () => false });
  for (const [id, store] of f.stores) composition.stores.set(id, store);
  const pending = new Set<string>(), releaseHeld = new Set<string>();
  const project = new HostProjectTeamLifecycle({ profile: f.profile, teams: f.teams, stores: composition.stores,
    registry: () => f.registry, storage: composition.storage, retirement: composition.retirement,
    assertCurrent: () => f.lease.assertCurrent(),
    async afterTrash(team, commandId) {
      if (pending.has(team.definition.binding.teamId)) throw new Error('TEST original cleanup held');
      team.owner.lifecycleContinuation().settleCleanup(commandId, receipt => {
        assert.deepEqual(receipt.runtimeBindings, []); assert.deepEqual(receipt.targets, []);
      });
    },
    async preparePurge(teamId) {
      if (releaseHeld.has(teamId)) throw new Error('TEST original Stop barrier');
      f.teams.get(teamId)!.owner.processCommands(f.principalId, { assertCurrent: () => f.lease.assertCurrent() }).assertReleased();
    },
  });
  return { ...composition, project, pending, releaseHeld };
}
function family(t: Parameters<typeof projectTeamFixture>[0]) {
  const f = projectTeamFixture(t), logical = f.create().record;
  f.prepare(logical, 'TEST-project-one');
  const other = join(f.root, 'TEST-other'); mkdirSync(other);
  f.prepare(logical, 'TEST-project-two', other);
  const children = f.registry.list(f.contextId).teams.filter(row => row.projectContext)
    .sort((a, b) => a.binding.handleId.localeCompare(b.binding.handleId));
  return { ...f, logical, children, selected: f.target(logical), lifecycle: lifecycle(f) };
}

test('logical trash and restore include every child; alias mutation cannot split the family', async t => {
  const f = family(t), api = f.lifecycle.project;
  await assert.rejects(api.change(f.target(f.children[0]!), 'TEST-alias-trash', {
    action: 'trash', expectedRevision: api.read(f.target(f.children[0]!)).revision }));
  const trash = await api.change(f.selected, 'TEST-trash', { action: 'trash', expectedRevision: api.read(f.selected).revision });
  assert.equal(trash.cleanupPending, true, 'original trash receipt retains its captured cleanup debt');
  assert.equal(api.read(f.selected).cleanupPending, false, 'fresh aggregate confirms every original cleanup settled');
  for (const row of [f.logical, ...f.children]) assert.ok(api.read(f.target(row)).deletedAt);
  const restore = await api.change(f.selected, 'TEST-restore', { action: 'restore', expectedRevision: api.read(f.selected).revision });
  assert.equal(restore.deletedAt, null);
  for (const row of [f.logical, ...f.children]) assert.equal(api.read(f.target(row)).deletedAt, null);
});

test('aggregate original ACK and lookup retain a child cleanup debt even when the logical parent is clean', async t => {
  const f = family(t), api = f.lifecycle.project;
  f.lifecycle.pending.add(f.children[0]!.teamId);
  const expected = { action: 'trash' as const, expectedRevision: api.read(f.selected).revision };
  const receipt = await api.change(f.selected, 'TEST-with-debt', expected);
  assert.equal(f.selected.team.owner.lifecycleCommands(f.principalId).view().cleanupPending, false);
  assert.equal(receipt.cleanupPending, true);
  assert.equal(api.lookup(f.selected, 'TEST-with-debt', expected)?.cleanupPending, true);
  await assert.rejects(api.purge(f.selected, 'TEST-refuse-purge-debt', api.read(f.selected).revision));
  for (const row of [f.logical, ...f.children]) assert.equal(existsSync(join(f.root, 'teams', row.teamName)), true);
});

test('cold interrupted trash exposes original coordinates without effects; only that command may finish it', async t => {
  const f = family(t), api = f.lifecycle.project;
  const change = f.lifecycle.storage.changeLifecycle.bind(f.lifecycle.storage);
  f.lifecycle.storage.changeLifecycle = async (teamId, command) => {
    if (teamId === f.children[1]!.teamId) throw new Error('TEST interrupted fanout');
    return await change(teamId, command);
  };
  const expected = { action: 'trash' as const, expectedRevision: api.read(f.selected).revision };
  await assert.rejects(api.change(f.selected, 'TEST-original-trash', expected));
  assert.deepEqual(api.read(f.selected).pendingChange, { commandId: 'TEST-original-trash', ...expected });
  assert.equal(api.lookup(f.selected, 'TEST-original-trash', expected), null);
  const original = f.stores.get(f.logical.teamId)!.read('project-lifecycle/current.json');
  await assert.rejects(api.change(f.selected, 'TEST-replacement-trash', expected));
  f.close();
  const cold = openProjectTeamFixture(f.root), restored = lifecycle(cold);
  try {
    const selected = cold.target(f.logical);
    assert.deepEqual(restored.project.read(selected).pendingChange, { commandId: 'TEST-original-trash', ...expected });
    assert.equal(restored.project.lookup(selected, 'TEST-original-trash', expected), null);
    assert.deepEqual(cold.stores.get(f.logical.teamId)!.read('project-lifecycle/current.json'), original);
    assert.equal((await restored.project.change(selected, 'TEST-original-trash', expected)).cleanupPending, true);
    assert.equal(restored.project.read(selected).cleanupPending, false);
    assert.doesNotThrow(() => assertProjectLifecycleIdle(cold.stores.get(f.logical.teamId)!));
  } finally { cold.close(); }
});

test('all original Stop barriers precede the first physical purge, then children are removed before the logical owner', async t => {
  const f = family(t), api = f.lifecycle.project;
  await api.change(f.selected, 'TEST-trash-purge', { action: 'trash', expectedRevision: api.read(f.selected).revision });
  const revision = api.read(f.selected).revision;
  f.lifecycle.releaseHeld.add(f.children[1]!.teamId);
  await assert.rejects(api.purge(f.selected, 'TEST-original-purge', revision));
  for (const row of [f.logical, ...f.children]) assert.equal(existsSync(join(f.root, 'teams', row.teamName)), true);
  assert.deepEqual(api.read(f.selected).pendingPurge, { commandId: 'TEST-original-purge', expectedRevision: revision });
  f.lifecycle.releaseHeld.clear();
  const deleted: string[] = [], purge = f.lifecycle.storage.purge.bind(f.lifecycle.storage);
  f.lifecycle.storage.purge = async (...args) => { const result = await purge(...args); deleted.push(args[0]); return result; };
  const receipt = await api.purge(f.selected, 'TEST-original-purge', revision);
  assert.equal(receipt.phase, 'deleted');
  assert.deepEqual(deleted, [...f.children.map(row => row.teamId), f.logical.teamId]);
  for (const row of [f.logical, ...f.children]) assert.equal(existsSync(join(f.root, 'teams', row.teamName)), false);
  const original = await f.lifecycle.retirement.lookup({ owner: f.profile.owner, scope: f.logical.binding.scope }, 'TEST-original-purge', revision);
  assert.deepEqual(original, receipt, 'retired original receipt survives without rebuilding any deleted store');
});

test('settled predecessor plus interrupted atomic lifecycle publication resumes the exact new plan', async t => {
  const f = family(t), api = f.lifecycle.project, store = f.stores.get(f.logical.teamId)!;
  await api.change(f.selected, 'TEST-trash-settled', { action: 'trash', expectedRevision: api.read(f.selected).revision });
  const expected = { action: 'restore' as const, expectedRevision: api.read(f.selected).revision }, write = store.write.bind(store);
  store.write = (path, value) => { write(path, value); if (path === 'project-lifecycle/current.json' &&
    (value as { commandId?: string }).commandId === 'TEST-restore-original') throw new Error('TEST interrupted after atomic write'); };
  await assert.rejects(api.change(f.selected, 'TEST-restore-original', expected));
  store.write = write;
  f.close();
  const cold = openProjectTeamFixture(f.root), restored = lifecycle(cold);
  try {
    assert.deepEqual(restored.project.read(cold.target(f.logical)).pendingChange, { commandId: 'TEST-restore-original', ...expected });
    const result = await restored.project.change(cold.target(f.logical), 'TEST-restore-original', expected);
    assert.equal(result.deletedAt, null);
    for (const row of [f.logical, ...f.children]) assert.equal(restored.project.read(cold.target(row)).deletedAt, null);
  } finally { cold.close(); }
});
