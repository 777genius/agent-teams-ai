import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLinuxWarmProcess } from '../dist/process/LinuxWarmProcess.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createHostTeamLifecycleComposition } from '../dist/composition/createHostTeamLifecycleComposition.js';
import { createOwnerScopedTeamPurge } from '../dist/adapters/lifecycle/OwnerScopedTeamPurge.js';
import { digest } from '../dist/team/identity.js';
import type { TestContext } from 'node:test';
import type { LinuxWarmNativeApi } from '../dist/process/LinuxWarmProcess.js';
import type { HostedTeamDefinition } from '../dist/team-registry/definition.js';
import type { HostedTeam } from '../dist/composition/RuntimeTeamCoordinator.js';
import type { ProcessCommandReceipt, RegistrarBinding } from '../dist/process/registeredProcessContracts.js';

const registrar: RegistrarBinding = { backendId: 'TEST-owner', teamId: 'TEST-team-id',
  runId: 'TEST-run', memberId: 'TEST-lead', generation: '1' };
function warmFixture(t: TestContext, timers = true) {
  if (timers) t.mock.timers.enable({ apis: ['setTimeout'] });
  type Handle = { pid: number; root: boolean; closed: boolean };
  const state = new Map<number, 'same-live' | 'absent' | 'unknown' | 'throw'>();
  const handles: Handle[] = [];
  let observations = 0, signals = 0, current = true;
  const identity = (pid: number) => ({ pid, sessionId: 1000, pidNamespaceId: '4026531836',
    bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  function capture(pid: number, root: boolean) {
    const handle = { pid, root, closed: false }; handles.push(handle);
    state.set(pid, 'same-live');
    return { ...identity(pid), handle };
  }
  const native: LinuxWarmNativeApi = {
    captureWarmRoot: pid => capture(pid, true),
    captureWarmDescendant: (_root, pid) => capture(pid, false),
    readWarmRootExecutable() { throw new Error('TEST not an executable proof'); },
    observeWarm(raw) {
      observations++;
      const handle = raw as Handle;
      assert.equal(handle.closed, false, 'only the original still-open handle can be observed');
      const value = state.get(handle.pid);
      if (value === 'throw') throw new Error('TEST native observation unavailable');
      return value ?? 'unknown';
    },
    signalWarm(raw) {
      const handle = raw as Handle; assert.equal(handle.closed, false); signals++; return 0;
    },
    closeWarm(raw) {
      const handle = raw as Handle;
      assert.equal(handle.closed, false, 'release each original native descriptor once');
      handle.closed = true;
    },
  };
  const custody = createLinuxWarmProcess(native, () => { if (!current) throw new Error('TEST stale owner'); });
  const child = new ChildProcess(); // Synthetic ChildProcess identity; no agent or OS process is launched.
  Object.defineProperty(child, 'pid', { value: 1000 });
  const source = custody.captureRoot(child, () => current);
  t.after(() => { if (!handles[0]!.closed) child.emit('exit', 0, null); });
  return { custody, source, child, state, handles,
    counts: () => ({ observations, signals }), current: (value: boolean) => { current = value; } };
}

test('bounded warm sweep releases only native-absent descriptors, including orphaned descendants, and keeps original proofs', t => {
  const f = warmFixture(t);
  const captures = Array.from({ length: 260 }, (_, index) => f.source.capture(2000 + index, registrar));
  for (const capture of captures) f.state.set(capture.target.pid, 'absent');
  f.state.set(2000, 'same-live'); f.state.set(2001, 'unknown'); f.state.set(2002, 'throw');
  f.child.emit('exit', 0, null);
  assert.equal(f.handles.filter(handle => !handle.root && handle.closed).length, 0,
    'the provider root exit proves nothing about its descendants');
  for (let batch = 0; batch < 3; batch++) {
    const before = f.counts().observations;
    t.mock.timers.tick(1000);
    assert.ok(f.counts().observations - before <= 128, 'one bounded native batch per tick');
  }
  assert.equal(f.handles.filter(handle => !handle.root && handle.closed).length, 257);
  assert.equal(f.custody.observe(captures[3]!), 'absent', 'natural terminal proof remains available');
  assert.equal(f.custody.observe(captures[0]!), 'same-live');
  assert.equal(f.custody.observe(captures[1]!), 'unknown');
  for (const pid of [2000, 2001, 2002]) f.state.set(pid, 'absent');
  t.mock.timers.tick(1000);
  assert.equal(f.handles.every(handle => handle.closed), true);
  const before = f.counts(); t.mock.timers.tick(100000);
  assert.deepEqual(f.counts(), before, 'no polling timer remains after all descriptors are released');
  assert.equal(f.handles.length, 261, 'sweeps never reopen a PID');
  assert.equal(f.counts().signals, 0);
});

test('warm absence acknowledgement is exact, already-absent only, and refuses foreign or stale authority', t => {
  const f = warmFixture(t), capture = f.source.capture(2000, registrar);
  f.custody.acknowledgeAbsence(capture);
  assert.equal(f.custody.observe(capture), 'same-live');
  f.state.set(2000, 'absent'); t.mock.timers.tick(1000);
  const changed = [
    { ...capture, ownerInstance: randomUUID() },
    { ...capture, captureKey: randomUUID() },
    { ...capture, registrar: { ...capture.registrar, teamId: 'TEST-other-team' } },
    { ...capture, target: { ...capture.target, pid: 2001 } },
  ];
  for (const foreign of changed) {
    f.custody.acknowledgeAbsence(foreign);
    assert.equal(f.custody.observe(foreign), 'unknown');
    assert.equal(f.custody.signal(foreign), 'refused');
    assert.equal(f.custody.observe(capture), 'absent');
  }
  f.current(false);
  assert.throws(() => f.custody.acknowledgeAbsence(capture), /stale owner/);
  f.current(true); assert.equal(f.custody.observe(capture), 'absent');
  f.custody.acknowledgeAbsence(capture); f.custody.acknowledgeAbsence(capture);
  assert.equal(f.custody.observe(capture), 'unknown');
  assert.equal(f.custody.signal(capture), 'refused');
  assert.equal(f.counts().signals, 0);
});

test('purged Team retirement is atomic, binding-scoped, and retains every unknown or live original', t => {
  const f = warmFixture(t), first = f.source.capture(2000, registrar), second = f.source.capture(2001, registrar);
  const foreign = f.source.capture(2002, { ...registrar, backendId: 'TEST-other-owner' });
  const otherTeam = f.source.capture(2003, { ...registrar, teamId: 'TEST-other-team' });
  f.state.set(2000, 'absent'); f.state.set(2001, 'unknown');
  assert.equal(f.custody.releaseTeam(registrar), false);
  assert.equal(f.custody.observe(first), 'absent', 'a partially absent Team does not lose any terminal metadata');
  assert.equal(f.custody.observe(second), 'unknown');
  assert.equal(f.handles.find(handle => handle.pid === 2001)!.closed, false);
  f.state.set(2001, 'same-live'); assert.equal(f.custody.releaseTeam(registrar), false);
  f.state.set(2001, 'absent');
  f.current(false); assert.equal(f.custody.releaseTeam(registrar), false);
  f.current(true); assert.equal(f.custody.observe(first), 'absent');
  assert.equal(f.custody.releaseTeam(registrar), true);
  assert.equal(f.custody.releaseTeam(registrar), true, 'cleanup is idempotent');
  assert.equal(f.custody.observe(first), 'unknown'); assert.equal(f.custody.observe(second), 'unknown');
  assert.equal(f.custody.observe(foreign), 'same-live'); assert.equal(f.custody.observe(otherTeam), 'same-live');
  assert.equal(f.counts().signals, 0);
});

test('more than 10000 sequential acknowledged Stops and purged Teams do not exhaust the warm owner lifetime', t => {
  const f = warmFixture(t);
  for (let index = 0; index < 10005; index++) {
    const capture = f.source.capture(2000 + index, registrar);
    f.state.set(capture.target.pid, 'absent');
    assert.equal(f.custody.observe(capture), 'absent');
    if (index % 2) assert.equal(f.custody.releaseTeam(registrar), true);
    else f.custody.acknowledgeAbsence(capture);
    assert.equal(f.custody.observe(capture), 'unknown');
  }
  assert.equal(f.handles.filter(handle => !handle.root && !handle.closed).length, 0);
  assert.equal(f.counts().signals, 0);
});

function teamFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-linux-warm-lifetime-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { principalId: 'human', owner: { ownerId: registrar.backendId, revision: 'TEST-revision',
    storageRoot: root, profileId: 'TEST-profile', protocolVersion: 1 as const, buildId: 'TEST-build',
    nodeSha256: '0'.repeat(64), hostEntrySha256: '0'.repeat(64) } };
  const definition = {
    binding: { backendId: registrar.backendId, teamId: registrar.teamId, teamName: 'TEST-team' },
    scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: registrar.teamId,
      runId: registrar.runId, memberId: 'human', generation: '1' },
    members: [{ memberId: registrar.memberId, name: 'lead', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'process.write'] }],
  } satisfies HostedTeamDefinition;
  const store = new TeamOwnerStore(root, definition.binding.teamName);
  const owner = createFilesystemTeamOwner({ root, store, binding: definition.binding,
    members: definition.members, grants: definition.grants });
  const team: HostedTeam = { definition, owner, connection: owner.connect('human'), operatorPrincipalId: 'human' };
  const teams = new Map([[definition.binding.teamId, team]]);
  return { root, profile, definition, store, owner, teams };
}

test('Stop persists original absence before acknowledgement, recovers failed acknowledgement, and keeps reads inert', t => {
  const f = warmFixture(t), team = teamFixture(t), capture = f.source.capture(2000, registrar);
  let acknowledgements = 0, failAck = true;
  const commands = team.owner.processCommands('human', { registrar: () => registrar, native: {
    capture: () => capture, observe: f.custody.observe, signal: f.custody.signal,
    acknowledgeAbsence(selected) {
      const saved = team.store.read<ProcessCommandReceipt>('commands/' + digest('TEST-stop') + '.json');
      assert.equal(saved?.state.phase, 'completed'); assert.equal(saved?.state.native, 'observed-absent');
      assert.deepEqual(saved?.capture, selected); acknowledgements++;
      if (failAck) throw new Error('TEST lost acknowledgement');
      f.custody.acknowledgeAbsence(selected);
    },
  } });
  commands.register('TEST-register', { pid: 2000, label: 'TEST service' });
  const row = commands.list()[0]!;
  commands.terminate('TEST-stop', row.processRef);
  f.state.set(2000, 'absent');
  const write = team.store.write.bind(team.store);
  const broken = t.mock.method(team.store, 'write', (path: string, value: unknown) => {
    if (path === 'commands/' + digest('TEST-stop') + '.json') throw new Error('TEST failed receipt durability');
    write(path, value);
  });
  assert.throws(() => commands.lookup('TEST-stop'), /failed receipt durability/);
  assert.equal(acknowledgements, 0); assert.equal(f.custody.observe(capture), 'absent');
  broken.mock.restore();
  assert.throws(() => commands.lookup('TEST-stop'), /lost acknowledgement/);
  assert.equal(acknowledgements, 1); assert.equal(f.custody.observe(capture), 'absent');
  const original = team.store.list('commands');
  commands.list(); commands.assertReleased();
  assert.deepEqual(team.store.list('commands'), original); assert.equal(acknowledgements, 1);
  failAck = false;
  const completed = commands.lookup('TEST-stop'); assert.equal(completed?.state.phase, 'completed');
  assert.equal(f.custody.observe(capture), 'unknown', 'only durable completed Stop releases warm terminal metadata');
  assert.deepEqual(commands.lookup('TEST-stop'), completed);
  assert.equal(commands.list()[0]?.observation, 'absent'); commands.assertReleased();
  assert.deepEqual(team.store.list('commands'), original, 'retries and reads preserve original journal bytes');
  assert.equal(f.counts().signals, 1, 'no repeated Stop or PID recapture');
});

test('natural warm history survives reads and failed purge, then actual durable Host purge retires it without a Stop', async t => {
  const f = warmFixture(t, false), team = teamFixture(t), capture = f.source.capture(2000, registrar);
  const commands = team.owner.processCommands('human', { registrar: () => registrar,
    native: { capture: () => capture, observe: f.custody.observe, signal: f.custody.signal } });
  commands.register('TEST-natural-register', { pid: 2000, label: 'TEST natural service' });
  f.state.set(2000, 'absent');
  const original = team.store.list('commands');
  assert.equal(commands.list()[0]?.observation, 'absent'); commands.assertReleased();
  assert.deepEqual(team.store.list('commands'), original, 'list/release observation never writes a natural Stop');
  let releases = 0;
  const lifecycle = createHostTeamLifecycleComposition({ profile: team.profile, teams: team.teams,
    runtime: () => undefined, importer: () => undefined, assertCurrent() {}, assertWriter() {}, isShuttingDown: () => false,
    processCustody: { observe: f.custody.observe, releaseTeam(binding) {
      const proof = lifecycle.storage.coordinator.readOwnerDeletionIntentSync('TEST-team', registrar.teamId);
      assert.equal(proof?.phase, 'deleted'); assert.equal(proof?.cleanupCompleted, true);
      assert.equal(existsSync(join(team.root, 'teams', 'TEST-team')), false);
      releases++; return f.custody.releaseTeam(binding);
    } },
  });
  lifecycle.stores.set(registrar.teamId, team.store);
  const state = team.owner.lifecycleCommands('human');
  state.execute({ commandId: 'TEST-trash', operation: 'trash', expectedRevision: state.view().revision });
  team.owner.lifecycleContinuation().settleCleanup('TEST-trash', () => {});
  const revision = state.view().revision;
  const boundary = lifecycle.storage.coordinator.commitPermanentDeletionBoundary.bind(lifecycle.storage.coordinator);
  lifecycle.storage.coordinator.commitPermanentDeletionBoundary = async () => { throw new Error('TEST purge interrupted'); };
  await assert.rejects(lifecycle.storage.purge(registrar.teamId, 'TEST-purge', revision), /purge interrupted/);
  assert.equal(f.custody.observe(capture), 'absent'); assert.equal(releases, 0);
  lifecycle.storage.coordinator.commitPermanentDeletionBoundary = boundary;
  const result = await lifecycle.storage.purge(registrar.teamId, 'TEST-purge', revision);
  assert.equal(result.phase, 'deleted'); assert.equal(releases, 1);
  assert.equal(f.custody.observe(capture), 'unknown'); assert.equal(f.counts().signals, 0);
  assert.equal(team.teams.has(registrar.teamId), false);
});

test('exact deleted purge replay retries private cleanup without replaying publication or filesystem work', async t => {
  const f = warmFixture(t, false), team = teamFixture(t), capture = f.source.capture(2000, registrar);
  f.state.set(2000, 'absent'); assert.equal(f.custody.observe(capture), 'absent');
  const lifecycle = createHostTeamLifecycleComposition({ profile: team.profile, teams: team.teams,
    runtime: () => undefined, importer: () => undefined, assertCurrent() {}, assertWriter() {}, isShuttingDown: () => false });
  lifecycle.stores.set(registrar.teamId, team.store);
  await lifecycle.storage.identity(registrar.teamId, 'human');
  const state = team.owner.lifecycleCommands('human');
  state.execute({ commandId: 'TEST-trash', operation: 'trash', expectedRevision: state.view().revision });
  team.owner.lifecycleContinuation().settleCleanup('TEST-trash', () => {});
  const revision = state.view().revision;
  let effects = 0, cleanup = 0;
  const purge = createOwnerScopedTeamPurge({ binding: team.definition.binding, capturedScope: team.definition.scope,
    store: team.store, roots: { teams: join(team.root, 'teams'), tasks: join(team.root, 'tasks'),
      appData: join(team.root, 'appData'), backups: join(team.root, 'backups') },
    lifecycle: team.owner.lifecycleContinuation(), principalId: 'human', coordinator: lifecycle.storage.coordinator,
    assertWriter() {}, authorizePurge() {}, assertReferencesReleased() {},
    releasePurgedReferences(intent) {
      cleanup++; assert.equal(intent.identityId, registrar.teamId);
      if (cleanup === 1) {
        f.current(false); assert.equal(f.custody.releaseTeam(registrar), false); f.current(true);
        throw new Error('TEST interrupted private cleanup');
      }
      else assert.equal(f.custody.releaseTeam(registrar), true);
    },
    onPurged() { effects++; throw new Error('TEST lost purge reply'); },
  });
  await assert.rejects(purge.purge('TEST-purge', revision), /lost purge reply/);
  assert.equal(effects, 1, 'failed private cleanup cannot prevent the once-only purge publication');
  assert.equal(f.custody.observe(capture), 'absent', 'uncertain cleanup retains the original proof');
  const intent = lifecycle.storage.coordinator.readOwnerDeletionIntentSync('TEST-team', registrar.teamId)!;
  assert.equal(intent.phase, 'deleted');
  const intentPath = join(team.root, 'backups', 'permanent-deletion-intents', 'TEST-team.json');
  const bytes = readFileSync(intentPath);
  t.mock.method(lifecycle.storage.coordinator, 'withPermanentDeletionTargetFence', async () => {
    assert.fail('deleted replay must not re-enter filesystem deletion');
  });
  assert.equal((await purge.purge('TEST-purge', revision)).transactionId, intent.transactionId);
  assert.equal(f.custody.observe(capture), 'unknown');
  assert.equal((await purge.continueOriginal(intent)).transactionId, intent.transactionId);
  assert.equal(cleanup, 3); assert.equal(effects, 1);
  assert.deepEqual(readFileSync(intentPath), bytes);
  await assert.rejects(purge.continueOriginal({ ...intent, transactionId: randomUUID() }));
  assert.equal(cleanup, 3); assert.equal(f.counts().signals, 0);
});
