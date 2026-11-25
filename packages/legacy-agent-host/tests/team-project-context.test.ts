import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectTeamFixture, openProjectTeamFixture } from './projectTeamFixture.ts';
import type { OwnerState } from '../dist/team/ownerState.js';

test('readonly project navigation never materializes a history or substitutes shared mode', t => {
  const f = projectTeamFixture(t), logical = f.create().record, target = f.target(logical);
  assert.deepEqual(f.contexts.read(target, {}), { kind: 'team-project-context', histories: [], view: { mode: 'per_project', state: 'needs_project' } });
  assert.equal(f.contexts.read(target, { projectPath: f.project }).view.state, 'empty');
  assert.equal(f.registry.list(f.contextId).teams.length, 1);
  assert.throws(() => f.contexts.assertLaunchAllowed(target), { code: 'forbidden' });
});

test('project prepare publishes only the exact original owner child and readonly alias relation', t => {
  const f = projectTeamFixture(t), logical = f.create().record;
  const value = f.prepare(logical, 'TEST-launch');
  const child = f.child(logical), target = f.target(child);
  assert.equal(value.view.state, 'ready');
  assert.equal(value.prepared?.executionHandleId, child.binding.handleId);
  assert.equal(child.projectContext?.logicalHandleId, logical.binding.handleId);
  assert.equal(child.projectContext?.logicalTeamId, logical.teamId);
  assert.equal(child.projectContext?.projectPath, f.project);
  assert.equal(child.contextId, logical.contextId);
  assert.equal(child.projectContextMode, 'shared');
  assert.equal(f.contexts.read(target, {}).view.state, 'redirect');
  assert.throws(() => f.contexts.assertDefinitionAdmission(target), { code: 'forbidden' });
  assert.doesNotThrow(() => f.contexts.assertLaunchAllowed(target));
  assert.equal(f.contexts.readLaunchSource(target, { logicalHandleId: logical.binding.handleId, commandId: 'TEST-launch' }).roster.commandId,
    value.prepared?.rosterCommandId);
});

test('a new folder creates separate history while both registry children retain exact parent', t => {
  const f = projectTeamFixture(t), logical = f.create().record, second = join(f.root, 'TEST-second');
  mkdirSync(second); f.prepare(logical, 'TEST-first'); f.prepare(logical, 'TEST-second', second);
  const a = f.child(logical), b = f.child(logical, second);
  assert.notEqual(a.teamId, b.teamId); assert.notEqual(a.projectContext!.workContextId, b.projectContext!.workContextId);
  assert.equal(f.contexts.read(f.target(logical), {}).histories.length, 2);
  assert.equal(a.projectContext!.logicalTeamId, b.projectContext!.logicalTeamId);
  assert.notEqual(f.teams.get(a.teamId)!.connection.readRoster().members[1]!.memberId,
    f.teams.get(b.teamId)!.connection.readRoster().members[1]!.memberId);
});

test('missing folder remains a readonly empty view but cannot admit prepare or a schedule', t => {
  const f = projectTeamFixture(t), logical = f.create().record, missing = join(f.root, 'TEST-missing');
  assert.equal(f.contexts.read(f.target(logical), { projectPath: missing }).view.state, 'empty');
  assert.throws(() => f.prepare(logical, 'TEST-launch', missing));
  assert.throws(() => f.contexts.read(f.target(logical), { projectPath: missing, scheduleAdmission: true }));
  assert.equal(f.registry.list(f.contextId).teams.length, 1);
});

test('same prepare command cannot be rebound to another project or launch options', t => {
  const f = projectTeamFixture(t), logical = f.create().record, target = f.target(logical), second = join(f.root, 'TEST-second');
  mkdirSync(second); f.prepare(logical, 'TEST-launch');
  assert.throws(() => f.prepare(logical, 'TEST-launch', second), { code: 'conflict' });
  assert.throws(() => f.contexts.prepare(target, 'TEST-launch', { projectPath: f.project,
    expectedRevision: target.team.connection.readRoster().revision, launchSettings: { skipPermissions: false } }), { code: 'conflict' });
  assert.equal(f.registry.list(f.contextId).teams.length, 2);
});

test('cold original retry restores the same history and preparation receipt without another child', t => {
  const f = projectTeamFixture(t), logical = f.create().record, original = f.prepare(logical, 'TEST-launch');
  const record = f.child(logical); f.close();
  const cold = openProjectTeamFixture(f.root);
  try {
    assert.deepEqual(cold.prepare(logical, 'TEST-launch'), original);
    assert.deepEqual(cold.child(logical), record);
    assert.equal(cold.registry.list(cold.contextId).teams.length, 2);
  } finally { cold.close(); }
});

test('selected live history remains schedulable while a different live history closes admission', t => {
  const f = projectTeamFixture(t), logical = f.create().record, second = join(f.root, 'TEST-second');
  mkdirSync(second); f.prepare(logical, 'TEST-first'); f.prepare(logical, 'TEST-second', second);
  const a = f.child(logical), b = f.child(logical, second);
  f.live.add(a.teamId);
  assert.equal(f.contexts.read(f.target(logical), { projectPath: f.project, scheduleAdmission: true }).view.state, 'ready');
  assert.throws(() => f.contexts.read(f.target(logical), { projectPath: second, scheduleAdmission: true }), { code: 'hold' });
  assert.throws(() => f.contexts.assertLaunchAllowed(f.target(b)), { code: 'hold' });
  f.live.delete(a.teamId); f.live.add(b.teamId);
  assert.throws(() => f.contexts.read(f.target(logical), { projectPath: f.project, scheduleAdmission: true }), { code: 'hold' });
  f.live.delete(b.teamId);
  const lifecycle = f.target(a).team.owner.lifecycleCommands(f.principalId);
  lifecycle.execute({ commandId: 'TEST-trash-selected', operation: 'trash', expectedRevision: lifecycle.view().revision });
  assert.equal(f.contexts.read(f.target(logical), { projectPath: f.project }).view.state, 'ready');
  assert.throws(() => f.contexts.read(f.target(logical), { projectPath: f.project, scheduleAdmission: true }), { code: 'hold' });
});

test('an already captured launch keeps fresh prepare and sibling launch out until its await completes', async t => {
  const f = projectTeamFixture(t), logical = f.create().record; f.prepare(logical, 'TEST-launch');
  let release!: () => void;
  const running = f.contexts.withLaunch(f.target(f.child(logical)), () => new Promise<void>(resolve => { release = resolve; }));
  assert.throws(() => f.prepare(logical, 'TEST-new-launch'), { code: 'hold' });
  await assert.rejects(f.contexts.withLaunch(f.target(f.child(logical)), async () => {}), { code: 'hold' });
  release(); await running;
});

test('lost child roster ACK recovers the original retained child and does not issue its effect again', t => {
  const f = projectTeamFixture(t), logical = f.create().record; f.prepare(logical, 'TEST-initial');
  const child = f.teams.get(f.child(logical).teamId)!, connection = child.connection;
  let writes = 0;
  child.connection = { ...connection, replaceRoster(input) { writes++; connection.replaceRoster(input); throw new Error('TEST lost ACK'); } };
  assert.throws(() => f.prepare(logical, 'TEST-unknown'), /lost ACK/);
  assert.equal(f.prepare(logical, 'TEST-unknown').view.state, 'ready');
  assert.equal(writes, 1);
});

test('original prepare retry must finish review synchronization before claiming ready, including a running replay', t => {
  let fail = true, calls = 0;
  const f = projectTeamFixture(t, { synchronizeHistory() { calls++; if (fail) throw new Error('TEST policy unavailable'); } });
  const logical = f.create().record;
  assert.throws(() => f.prepare(logical, 'TEST-launch'), /policy unavailable/);
  const child = f.child(logical); f.live.add(child.teamId);
  assert.throws(() => f.prepare(logical, 'TEST-launch'), /policy unavailable/);
  fail = false;
  assert.equal(f.prepare(logical, 'TEST-launch').view.state, 'ready');
  assert.equal(calls, 3);
});

test('definition model choices change by original CAS while project permissions and CLI flags remain local', t => {
  const f = projectTeamFixture(t), logical = f.create('TEST-logical', 'per_project',
    { providerId: 'anthropic', model: 'TEST-old', skipPermissions: true, worktree: 'TEST-initial', extraCliArgs: '--TEST-old' }).record;
  const target = f.target(logical), before = target.team.connection.readRoster().revision;
  const input = { projectPath: f.project, expectedRevision: before, launchSettings: {
    providerId: 'codex' as const, model: 'TEST-new', skipPermissions: false, worktree: 'TEST-local', extraCliArgs: null } };
  const prepared = f.contexts.prepare(target, 'TEST-selected', input);
  const root = target.team.connection.readRoster(), child = f.teams.get(f.child(logical).teamId)!.connection.readRoster();
  assert.notEqual(root.revision, before); assert.equal(prepared.prepared?.sourceRevision, root.revision);
  assert.equal(root.savedSettings!.providerId, 'codex'); assert.equal(root.savedSettings!.skipPermissions, true);
  assert.equal(child.savedSettings!.skipPermissions, false); assert.equal(child.savedSettings!.worktree, 'TEST-local');
  assert.equal(child.savedSettings!.extraCliArgs, undefined);
  assert.deepEqual(f.contexts.prepare(target, 'TEST-selected', input), prepared);
  assert.throws(() => f.contexts.prepare(target, 'TEST-selected', { ...input, launchSettings: { ...input.launchSettings, model: 'TEST-other' } }), { code: 'conflict' });
});

test('later definition projection retains the existing project flags and changed authored source closes old launch', async t => {
  const f = projectTeamFixture(t), logical = f.create('TEST-logical', 'per_project', { skipPermissions: true }).record;
  const target = f.target(logical), original = target.team.connection.readRoster();
  f.contexts.prepare(target, 'TEST-first', { projectPath: f.project, expectedRevision: original.revision,
    launchSettings: { skipPermissions: false, worktree: 'TEST-local' } });
  const child = f.child(logical), roster = target.team.connection.readRoster();
  target.team.connection.replaceRoster({ commandId: 'TEST-authored', expectedRevision: roster.revision,
    members: [{ name: 'alice', role: 'Writer' }], savedSettings: roster.savedSettings });
  assert.throws(() => f.contexts.assertLaunchAllowed(f.target(child)), { code: 'conflict' });
  f.prepare(logical, 'TEST-refresh');
  const after = f.teams.get(child.teamId)!.connection.readRoster();
  assert.equal(after.savedSettings!.skipPermissions, false); assert.equal(after.savedSettings!.worktree, 'TEST-local');
  assert.equal(after.members[1]!.settings.role, 'Writer');
  assert.doesNotThrow(() => f.contexts.assertLaunchAllowed(f.target(child)));
});

test('logical original authority revocation closes an already prepared child launch and readiness transfer', t => {
  const f = projectTeamFixture(t), logical = f.create().record; f.prepare(logical, 'TEST-launch');
  const target = f.target(f.child(logical)), store = f.stores.get(logical.teamId)!;
  store.fenced(() => {
    const state = store.read<OwnerState>('state.json')!;
    state.grants.find(row => row.principalId === f.principalId)!.revoked = true;
    store.write('state.json', state);
  });
  assert.throws(() => f.contexts.assertLaunchAllowed(target));
  assert.throws(() => f.contexts.readLaunchSource(target, { logicalHandleId: logical.binding.handleId, commandId: 'TEST-launch' }));
});

test('definition fanout uses one root command and live authored edits preserve child member identities', async t => {
  const f = projectTeamFixture(t), logical = f.create().record; f.prepare(logical, 'TEST-launch');
  const target = f.target(logical), child = f.child(logical), before = f.teams.get(child.teamId)!.connection.readRoster();
  f.live.add(child.teamId);
  const source = target.team.connection.readRoster();
  const payload = { expectedRevision: source.revision, members: [{ name: 'alice', role: 'Writer' }],
    savedSettings: { ...source.savedSettings!, language: 'ru', prompt: 'TEST new authored' } };
  const response = await f.definitions.execute(target, { teamId: logical.teamId, commandId: 'TEST-edit', method: 'team.roster.replace',
    payload, binding: { ...logical.binding, owner: f.profile.owner }, conversation: { phase: 'capture', remainingMs: 10000 } });
  assert.equal(response?.ok, true);
  const after = f.teams.get(child.teamId)!.connection.readRoster();
  assert.equal(after.members[1]!.memberId, before.members[1]!.memberId);
  assert.equal(after.members[1]!.settings.role, 'Writer'); assert.equal(after.savedSettings!.language, 'ru');
  assert.equal(f.definitions.lookup(target, 'TEST-edit', payload)?.commandId, 'TEST-edit');
});

test('a pending original definition journal cannot acknowledge its already committed logical receipt', async t => {
  let dispatches = 0;
  const f = projectTeamFixture(t, { async executeLive() { dispatches++; return { ok: false, code: 'hold', outcome: 'unknown' }; } });
  const logical = f.create().record; f.prepare(logical, 'TEST-launch');
  const child = f.child(logical);
  const target = f.target(logical), source = target.team.connection.readRoster();
  const input = { teamId: logical.teamId, commandId: 'TEST-edit', method: 'team.roster.replace' as const,
    payload: { expectedRevision: source.revision, members: [{ name: 'alice', model: 'TEST-new' }] },
    binding: { ...logical.binding, owner: f.profile.owner }, conversation: { phase: 'capture' as const, remainingMs: 10000 } };
  assert.equal((await f.definitions.execute(target, input))?.ok, false);
  assert.ok(target.team.connection.lookupRoster('TEST-edit'));
  assert.equal(f.definitions.lookup(target, 'TEST-edit', input.payload), null);
  assert.equal((await f.definitions.execute(target, input))?.ok, false);
  assert.equal(dispatches, 1, 'same original cold-style capture cannot dispatch an unknown child again');
  assert.throws(() => f.contexts.assertLaunchAllowed(f.target(child)), { code: 'hold' });
  assert.throws(() => f.contexts.assertProductMutation(f.target(child)), { code: 'hold' });
});

test('source proof cannot be replaced with another logical parent or guessed preparation command', t => {
  const f = projectTeamFixture(t), logical = f.create().record, other = f.create('TEST-other').record;
  f.prepare(logical, 'TEST-launch'); const child = f.target(f.child(logical));
  assert.throws(() => f.contexts.readLaunchSource(child, { logicalHandleId: other.binding.handleId, commandId: 'TEST-launch' }));
  assert.throws(() => f.contexts.readLaunchSource(child, { logicalHandleId: logical.binding.handleId, commandId: 'TEST-other-command' }));
});

test('trash retains readonly project history while new launch, schedule, readiness and delivery remain closed', t => {
  const f = projectTeamFixture(t), logical = f.create().record;
  f.prepare(logical, 'TEST-launch'); const child = f.child(logical), target = f.target(logical);
  const lifecycle = target.team.owner.lifecycleCommands(f.principalId);
  lifecycle.execute({ commandId: 'TEST-trash', operation: 'trash', expectedRevision: lifecycle.view().revision });
  const read = f.contexts.read(target, { projectPath: f.project });
  assert.equal(read.view.state, 'ready'); assert.equal(read.histories.length, 1);
  assert.throws(() => f.contexts.assertLaunchAllowed(f.target(child)), { code: 'hold' });
  assert.throws(() => f.contexts.assertProductMutation(f.target(child)), { code: 'hold' });
  assert.throws(() => f.prepare(logical, 'TEST-later'), { code: 'hold' });
  assert.throws(() => f.contexts.read(target, { projectPath: f.project, scheduleAdmission: true }), { code: 'hold' });
  assert.throws(() => f.contexts.readLaunchSource(f.target(child), { logicalHandleId: logical.binding.handleId, commandId: 'TEST-launch' }), { code: 'hold' });
  const other = f.create('TEST-other', 'shared').record;
  assert.throws(() => f.contexts.assertCrossTeamPair(f.target(child).team, f.target(other).team), { code: 'hold' });
});

test('a physical project history may read its original roster receipt but never author another replacement', async t => {
  const f = projectTeamFixture(t), logical = f.create().record;
  const prepared = f.prepare(logical, 'TEST-launch'), child = f.child(logical), target = f.target(child);
  const source = f.contexts.readLaunchSource(target, { logicalHandleId: logical.binding.handleId, commandId: 'TEST-launch' });
  const input = { teamId: child.teamId, commandId: prepared.prepared!.rosterCommandId, method: 'team.roster.lookup' as const,
    payload: { expected: source.roster.expected }, binding: { ...child.binding, owner: f.profile.owner }, conversation: { phase: 'read' as const } };
  assert.equal(await f.definitions.execute(target, input), undefined, 'original child ledger retains the read');
  assert.ok(target.team.connection.lookupRoster(input.commandId, source.roster.expected));
  await assert.rejects(f.definitions.execute(target, { ...input, method: 'team.roster.replace', payload: source.roster.expected,
    conversation: { phase: 'capture', remainingMs: 10000 } }), { code: 'forbidden' });
});

test('retained exact histories stay readable when saved parent mode is shared, without granting fresh child launch', t => {
  const f = projectTeamFixture(t), logical = f.create().record;
  f.prepare(logical, 'TEST-launch'); const child = f.child(logical), target = f.target(logical);
  const source = target.team.connection.readRoster();
  target.team.connection.replaceRoster({ commandId: 'TEST-saved-shared', expectedRevision: source.revision,
    members: source.members.filter(row => row.role !== 'lead').map(row => ({ name: row.name, ...row.settings })),
    savedSettings: { ...source.savedSettings!, projectContextMode: 'shared' } });
  const read = f.contexts.read(target, {});
  assert.equal(read.view.mode, 'shared'); assert.equal(read.histories.length, 1);
  assert.equal(f.contexts.read(f.target(child), {}).view.state, 'redirect');
  assert.throws(() => f.contexts.assertLaunchAllowed(f.target(child)), { code: 'forbidden' });
  assert.throws(() => f.contexts.assertProductMutation(f.target(child)), { code: 'forbidden' });
  f.live.add(child.teamId);
  assert.throws(() => f.contexts.assertLaunchAllowed(target), { code: 'hold' });
});
