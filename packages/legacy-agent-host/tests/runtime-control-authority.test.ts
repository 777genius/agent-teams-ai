import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createRuntimeTeamLaunch } from '../dist/composition/createRuntimeTeamLaunch.js';
import { captureRuntimeControlAuthority, readDefaultFreshAllocationContinuation } from '../dist/composition/runtimeControlAuthority.js';
import { readCapturedProviderAuthority } from '../dist/composition/teamRoster.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { TeamLaunchRecord } from '../dist/team-launch/contracts.js';
import { fixture } from './native-member-actions-fixture.ts';

test('runtime control checks share one real Team lock and reread grant, binding and namespace each time', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const writer = acquireProfileWriterLease(f.root);
  const lock = join(f.store.directory, 'authority.lock');
  const team = join(f.root, 'teams', entry.team.definition.binding.teamName);
  let writerChecks = 0, publications = 0, namespaceTraversals = 0;
  const tokens: string[] = [];
  const current = captureRuntimeControlAuthority({ entry, principalId: entry.profile.principalId,
    assertWriter() {
      writerChecks++;
      assert.equal(fs.existsSync(lock), false, 'writer fence must precede the Team lock');
      writer.assertCurrent();
    }, isSealed: () => false });
  const link = fs.linkSync, directories = fs.readdirSync;
  const read = TeamOwnerStore.prototype.read;
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (args[1] === lock) publications++;
    return link(...args);
  });
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === team) namespaceTraversals++;
    return directories(...args);
  });
  t.mock.method(TeamOwnerStore.prototype, 'read', function<T>(this: TeamOwnerStore, name: string): T | undefined {
    if (this.directory === f.store.directory && name === 'state.json') {
      const [pid, , token] = fs.readFileSync(lock, 'utf8').split('\n');
      assert.equal(pid, String(process.pid));
      assert.match(token!, /^[a-f0-9-]{36}$/);
      tokens.push(token!);
    }
    return (read<T>).call(this, name);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  try {
    current();
    assert.equal(writerChecks, 1);
    assert.equal(publications, 1, 'grant revision and current control share one physical lock publication');
    assert.equal(tokens.length, 3, 'both original grant reads and original binding state read remain fresh');
    assert.equal(new Set(tokens).size, 1, 'all original reads retain the same canonical lock token');
    assert.equal(namespaceTraversals, 3, 'nested control still validates the original namespace');
    assert.equal(fs.existsSync(lock), false);
    const previous = tokens[0]; tokens.length = 0;
    await Promise.resolve();
    current();
    assert.equal(publications, 2);
    assert.equal(tokens.length, 3);
    assert.equal(new Set(tokens).size, 1);
    assert.notEqual(tokens[0], previous, 'a later check acquires a new original lock');
    assert.equal(namespaceTraversals, 6);
    assert.equal(fs.existsSync(lock), false);
    f.store.fenced(() => {
      const state = f.store.read<OwnerState>('state.json')!;
      state.members = state.members.filter(member => member.name !== 'alice');
      f.store.write('state.json', state);
    });
    tokens.length = 0;
    assert.throws(current, { code: 'forbidden' }, 'fresh stored roster refuses a removed runtime member');
    assert.equal(tokens.length, 3);
    assert.equal(fs.existsSync(lock), false);
  } finally { writer.release(); }
});

test('runtime control retains writer, sealed, immutable binding and actual grant refusals before allocation', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const original = entry.binding;
  const writer = acquireProfileWriterLease(f.root);
  let sealed = false, writerFailure: Error | undefined;
  const current = captureRuntimeControlAuthority({ entry, principalId: entry.profile.principalId,
    assertWriter() { if (writerFailure) throw writerFailure; writer.assertCurrent(); },
    isSealed: () => sealed });
  try {
    current();
    const fences = t.mock.method(TeamOwnerStore.prototype, 'fenced');
    const before = fences.mock.callCount();
    writerFailure = new Error('TEST original writer refusal');
    assert.throws(current, error => error === writerFailure);
    writerFailure = undefined;
    sealed = true; assert.throws(current, { code: 'forbidden' }); sealed = false;
    entry.binding = { ...original, generation: 'TEST-replacement' };
    assert.throws(current, { code: 'forbidden' }); entry.binding = original;
    assert.equal(fences.mock.callCount(), before, 'existing early refusals cannot publish a Team lock');
    f.human.revoke(entry.profile.principalId);
    assert.throws(current, { code: 'forbidden' }, 'current persisted grant revocation cannot be cached away');
  } finally { writer.release(); }
});

test('runtime control rejects a changed grant revision even when control permissions remain valid', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const current = captureRuntimeControlAuthority({ entry, principalId: entry.profile.principalId,
    assertWriter() {}, isSealed: () => false });
  current();
  f.store.fenced(() => {
    const state = f.store.read<OwnerState>('state.json')!;
    const grant = state.grants.find(value => value.principalId === entry.profile.principalId)!;
    grant.revision = (grant.revision ?? 1) + 1;
    f.store.write('state.json', state);
  });
  assert.equal(f.owner.authorizeRuntimeAccess(entry.profile.principalId, entry.binding, 'control'), true);
  assert.throws(current, { code: 'forbidden' });
});

async function defaultLaunch(t: TestContext) {
  const f = await fixture(t, false), entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  // Replace the helper's unused synthetic launch with the real aggregate composition.
  f.launch.seal();
  f.store.fenced(() => fs.unlinkSync(join(f.store.directory, `launches/${runtimeDigest('TEST-run')}.json`)));
  const writer = acquireProfileWriterLease(f.root), lock = join(f.store.directory, 'authority.lock');
  let writerFailure: Error | undefined, sealed = false, retained: (() => void) | undefined;
  const assertWriter = () => { if (writerFailure) throw writerFailure; writer.assertCurrent(); };
  const open = f.runtime.openSession;
  t.mock.method(f.runtime, 'openSession', function(this: typeof f.runtime,
    input: Parameters<typeof open>[0], authority?: () => void) {
    retained = authority;
    return open.call(this, input, authority);
  });
  const launch = createRuntimeTeamLaunch({ root: f.root, team: f.team, entries: [...f.entries.values()],
    principalId: 'profile-admin', hostIncarnation: 'TEST-host', runtime: f.runtime,
    isCurrent: () => true, isSealed: () => sealed, assertWriter,
    trackOpening: pending => pending, onProgress() {} });
  const dispose = () => { try { launch.seal(); } finally { writer.release(); } };
  try {
    await launch.startMember('A');
    assert.ok(retained, 'default start must pass its captured authority to the real Runtime owner');
    assert.ok(f.opened.includes('A:1'), 'only the fixture controlled Driver is allocated');
    const current = retained;
    const prior = captureRuntimeControlAuthority({ entry, principalId: 'profile-admin', assertWriter,
      isSealed: () => sealed });
    return { ...f, entry, lock, current, dispose, actualLaunch: launch, assertWriter,
      baseline: () => { f.team.owner.assertExecutionAllowed('profile-admin'); prior(); },
      failWriter: (value: Error | undefined) => { writerFailure = value; },
      setSealed: (value: boolean) => { sealed = value; } };
  } catch (error) { dispose(); throw error; }
}

function observeDefaultAuthority(t: TestContext, f: Awaited<ReturnType<typeof defaultLaunch>>) {
  let observing = false, afterExecution: (() => void) | undefined;
  const observed = { publications: [] as string[], tokens: [] as string[], namespaceReads: 0, checks: [] as string[] };
  const link = fs.linkSync, directories = fs.readdirSync, read = TeamOwnerStore.prototype.read;
  const execution = f.owner.assertExecutionAllowed, control = f.owner.authorizeRuntimeAccess;
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (observing && String(args[1]).endsWith('authority.lock')) observed.publications.push(String(args[1]));
    return link(...args);
  });
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (observing && args[0] === join(f.root, 'teams', f.team.definition.binding.teamName)) observed.namespaceReads++;
    return directories(...args);
  });
  t.mock.method(TeamOwnerStore.prototype, 'read', function<T>(this: TeamOwnerStore, name: string): T | undefined {
    if (observing && this.directory === f.store.directory && name === 'state.json') {
      const [pid, , token] = fs.readFileSync(f.lock, 'utf8').split('\n');
      assert.equal(pid, String(process.pid)); assert.match(token!, /^[a-f0-9-]{36}$/);
      observed.tokens.push(token!);
    }
    return (read<T>).call(this, name);
  });
  t.mock.method(f.owner, 'assertExecutionAllowed', function(this: typeof f.owner, principalId: string) {
    if (observing) observed.checks.push(`execution:${principalId}`);
    execution.call(this, principalId);
    if (observing) afterExecution?.();
  });
  t.mock.method(f.owner, 'authorizeRuntimeAccess', function(this: typeof f.owner, ...args: Parameters<typeof control>) {
    if (observing) observed.checks.push(`control:${args[0]}:${args[2]}`);
    return control.apply(this, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    afterExecution: (effect: (() => void) | undefined) => { afterExecution = effect; },
    measure(action: () => void) {
      observed.publications.length = 0; observed.tokens.length = 0; observed.checks.length = 0; observed.namespaceReads = 0;
      observing = true;
      try { action(); return structuredClone(observed); }
      finally { observing = false; assert.equal(fs.existsSync(f.lock), false, 'original lock must be released'); }
    },
  };
}

test('default launch authority shares one original Team token while keeping both checks and every state read', async t => {
  const f = await defaultLaunch(t), observe = observeDefaultAuthority(t, f);
  try {
    const before = observe.measure(f.baseline), current = observe.measure(f.current);
    assert.deepEqual(before.publications, [f.lock, f.lock], 'the exact prior two-check callback publishes twice');
    assert.deepEqual(current.publications, [f.lock], 'the actual default start callback shares one physical lock');
    assert.equal(new Set(before.tokens).size, 2); assert.equal(new Set(current.tokens).size, 1);
    assert.deepEqual(before.checks, ['execution:profile-admin', 'control:profile-admin:control']);
    assert.deepEqual(current.checks, before.checks, 'original actor and execution-before-control order remain');
    assert.equal(before.tokens.length, 5);
    assert.equal(current.tokens.length, before.tokens.length + 1, 'all five original reads plus the outer grant read');
    assert.equal(current.namespaceReads, before.namespaceReads, 'nested namespace checks are not removed');
    await Promise.resolve();
    const later = observe.measure(f.current);
    assert.deepEqual(later.publications, [f.lock]);
    assert.equal(later.tokens.length, current.tokens.length);
    assert.notEqual(later.tokens[0], current.tokens[0], 'no token is retained across invocations');
    f.store.fenced(() => {
      const state = f.store.read<OwnerState>('state.json')!;
      state.members = state.members.filter(member => member.memberId !== f.entry.binding.memberId);
      f.store.write('state.json', state);
    });
    const refused = observe.measure(() => assert.throws(f.current, { code: 'forbidden' }));
    assert.deepEqual(refused.checks, before.checks, 'control must reread the removed original member');
  } finally { f.dispose(); }
});

test('default launch authority retains the captured Team owner, writer, lifecycle, admin and original grant epoch', async t => {
  const f = await defaultLaunch(t), foreign = await fixture(t), observe = observeDefaultAuthority(t, f);
  const originalTeam = f.entry.team, originalOwner = f.team.owner, binding = f.entry.binding;
  const saved = f.store.fenced(() => f.store.read<OwnerState>('state.json')!);
  const restore = () => f.store.fenced(() => f.store.write('state.json', saved));
  try {
    for (const change of [
      () => { f.entry.team = { ...originalTeam }; },
      () => { f.team.owner = foreign.owner; },
    ]) {
      change();
      try {
        const refused = observe.measure(() => assert.throws(f.current, { code: 'forbidden' }));
        assert.deepEqual(refused.publications, [], 'a replacement cannot publish either Team lock');
        assert.deepEqual(refused.checks, []);
      } finally { f.entry.team = originalTeam; f.team.owner = originalOwner; }
    }
    const failure = new Error('TEST original writer refusal');
    f.failWriter(failure);
    const writer = observe.measure(() => assert.throws(f.current, error => error === failure));
    assert.deepEqual(writer.publications, []); f.failWriter(undefined);
    f.setSealed(true);
    observe.measure(() => assert.throws(f.current, { code: 'forbidden' })); f.setSealed(false);
    f.entry.binding = { ...binding, generation: 'TEST-replacement' };
    observe.measure(() => assert.throws(f.current, { code: 'forbidden' })); f.entry.binding = binding;
    const changes: [string, (state: OwnerState) => void, 'forbidden' | 'hold'][] = [
      ['admin', state => { state.grants.find(grant => grant.principalId === 'profile-admin')!.permissions = ['read']; }, 'forbidden'],
      ['lifecycle', state => { state.lifecycle = { cleanupCommandId: 'TEST-pending', cleanupPending: true }; }, 'hold'],
      ['epoch', state => { const grant = state.grants.find(grant => grant.principalId === 'profile-admin')!; grant.revision = (grant.revision ?? 1) + 1; }, 'forbidden'],
    ];
    for (const [name, change, code] of changes) {
      const state = structuredClone(saved); change(state);
      f.store.fenced(() => f.store.write('state.json', state));
      const refused = observe.measure(() => assert.throws(f.current, { code }, name));
      assert.deepEqual(refused.checks, ['execution:profile-admin'], `${name} cannot reach control`);
      restore(); observe.measure(f.current);
    }
  } finally {
    f.entry.team = originalTeam; f.team.owner = originalOwner; f.entry.binding = binding;
    f.failWriter(undefined); f.setSealed(false); restore(); f.dispose();
  }
});

test('default launch authority still refuses namespace replacement between its original checks',
  { skip: process.platform === 'win32' }, async t => {
    const f = await defaultLaunch(t), observe = observeDefaultAuthority(t, f);
    const changed = join(f.root, 'teams', f.team.definition.binding.teamName, 'TEST-foreign-link');
    try {
      observe.afterExecution(() => fs.symlinkSync(f.root, changed, 'dir'));
      const refused = observe.measure(() => assert.throws(f.current, { code: 'hold' }));
      assert.deepEqual(refused.publications, [f.lock]);
      assert.deepEqual(refused.checks, ['execution:profile-admin']);
      fs.rmSync(changed); observe.afterExecution(undefined);
      observe.measure(f.current);
    } finally { fs.rmSync(changed, { force: true }); f.dispose(); }
  });

test('only the actual default fresh callback retains its original owner, source and binding provenance', async t => {
  const f = await defaultLaunch(t), observe = observeDefaultAuthority(t, f);
  const continuation = readDefaultFreshAllocationContinuation(f.current, f.entry);
  assert.ok(continuation, 'the real plain openSession branch supplies nominal provenance');
  const originalTeam = f.entry.team, originalOwner = f.team.owner, originalBinding = f.entry.binding;
  const originalDefinition = f.team.definition, originalConfig = f.entry.config;
  const selection = { binding: originalBinding, generation: f.entry.profile.generation,
    configurationDigest: runtimeDigest(f.entry.profile), baseConfigurationDigest: runtimeDigest(f.entry.baseProfile) };
  const checkpoint = { commandId: 'TEST-original', reference: 'TEST-checkpoint', sourceBinding: originalBinding };
  const current = () => continuation(originalOwner, originalBinding);
  try {
    assert.equal(readDefaultFreshAllocationContinuation(() => f.current(), f.entry), undefined,
      'an unregistered delegating callback cannot borrow inherited authority');
    assert.equal(readDefaultFreshAllocationContinuation(Object.assign(() => {}, { entry: f.entry, team: f.team }), f.entry), undefined,
      'public properties cannot fabricate nominal provenance');
    const plain = observe.measure(f.current);
    const arbitraryArgument = observe.measure(() => Reflect.apply(f.current, undefined, [{}]));
    assert.equal(plain.namespaceReads, 5);
    assert.equal(arbitraryArgument.namespaceReads, plain.namespaceReads, 'a caller cannot select the private inherited mode');
    const changed: [string, () => void, () => void][] = [
      ['entry Team', () => { f.entry.team = { ...originalTeam }; }, () => { f.entry.team = originalTeam; }],
      ['owner', () => { f.team.owner = Object.create(originalOwner) as typeof originalOwner; }, () => { f.team.owner = originalOwner; }],
      ['binding', () => { f.entry.binding = { ...originalBinding, generation: 'TEST-replaced' }; }, () => { f.entry.binding = originalBinding; }],
      ['capture', () => { f.team.capture = { TEST: 'changed-source' }; }, () => { delete f.team.capture; }],
      ['configuration revision', () => { f.team.configurationRevision = 'TEST-replaced'; }, () => { delete f.team.configurationRevision; }],
      ['launch', () => { f.team.launchId = 'TEST-replaced'; }, () => { delete f.team.launchId; }],
      ['definition', () => { f.team.definition = { ...originalDefinition, scope: { ...originalDefinition.scope, runId: 'TEST-replaced' } }; },
        () => { f.team.definition = originalDefinition; }],
      ['checkpoint request', () => { f.entry.config = { ...originalConfig, checkpointRef: 'TEST-checkpoint' }; },
        () => { f.entry.config = originalConfig; }],
      ['selected restore', () => { f.entry.selection = { ...selection, restore: checkpoint }; },
        () => { delete f.entry.selection; }],
      ['checkpoint source', () => { f.entry.selection = { ...selection, checkpointSource: { ...checkpoint,
        attemptId: 'TEST-attempt', hostIncarnation: 'TEST-host', baseConfigurationDigest: selection.baseConfigurationDigest } }; },
        () => { delete f.entry.selection; }],
      ['live roster capture', () => { const hash = runtimeDigest('TEST-live-source'); f.entry.liveRosterCapture = {
        schemaVersion: 1, commandId: 'TEST-live', requestDigest: hash, sourceCaptureDigest: hash,
        expectedRevision: hash, launchId: 'TEST-run', sourceCwd: f.root, savedSettings: { cwd: f.root }, leadProvider: 'anthropic',
        member: { memberId: f.entry.profile.memberId, name: 'alice', role: 'member', settings: {} },
        templateDigest: hash, previous: null, workspace: f.root,
        mcpRecipeReference: { memberId: f.entry.profile.memberId, digest: hash }, recipeDigest: hash,
        configurationDigest: selection.configurationDigest, runtimeGeneration: f.entry.profile.generation,
      }; }, () => { delete f.entry.liveRosterCapture; }],
    ];
    for (const [name, change, restore] of changed) {
      change();
      try {
        const refused = observe.measure(() => assert.throws(current, { code: 'forbidden' }, name));
        assert.deepEqual(refused.publications, [], name + ' cannot publish any allocation lock');
        assert.deepEqual(refused.checks, [], name + ' cannot reach execution or control');
      } finally { restore(); }
    }
    const another = readDefaultFreshAllocationContinuation(f.current, { ...f.entry });
    assert.ok(another, 'known but mismatched provenance must refuse, never become a generic fallback');
    observe.measure(() => assert.throws(() => another(originalOwner, originalBinding), { code: 'forbidden' }));
    observe.measure(() => assert.throws(() => continuation(originalOwner, { ...originalBinding, memberId: 'TEST-other' }), { code: 'forbidden' }));
    const pair = observe.measure(() => assert.equal(readCapturedProviderAuthority(f.team,
      f.entry.profile.principalId, f.entry.binding, continuation), 'current'));
    assert.deepEqual(pair.publications, [f.lock]); assert.equal(pair.namespaceReads, 8);
    assert.equal(pair.tokens.length, 7); assert.equal(new Set(pair.tokens).size, 1);
    f.entry.selection = selection;
    try {
      const ordinary = observe.measure(() => assert.equal(readCapturedProviderAuthority(f.team,
        f.entry.profile.principalId, f.entry.binding, continuation), 'current'));
      assert.equal(ordinary.namespaceReads, 8); assert.equal(ordinary.tokens.length, 7);
      assert.deepEqual(ordinary.publications, [f.lock], 'ordinary launch selection remains eligible');
    } finally { delete f.entry.selection; }
  } finally { f.dispose(); }
});

test('a real shared Team release failure preserves its exact error and cannot admit a later native action', async t => {
  const f = await defaultLaunch(t), observe = observeDefaultAuthority(t, f);
  const continuation = readDefaultFreshAllocationContinuation(f.current, f.entry);
  assert.ok(continuation);
  const original = Error('TEST original Team release failure'), unlink = fs.unlinkSync;
  let armed = false, releases = 0, laterActions = 0, allocationCalls = 0;
  const release = t.mock.method(fs, 'unlinkSync', (...args: Parameters<typeof fs.unlinkSync>) => {
    const result = unlink(...args);
    if (armed && args[0] === f.lock) { releases++; throw original; }
    return result;
  });
  syncBuiltinESMExports();
  try {
    armed = true;
    const refused = observe.measure(() => assert.throws(() => {
      readCapturedProviderAuthority(f.team, f.entry.profile.principalId, f.entry.binding, (owner, binding) => {
        allocationCalls++; continuation(owner, binding);
      });
      laterActions++;
    }, error => error === original));
    armed = false;
    assert.deepEqual(refused.publications, [f.lock]); assert.equal(refused.namespaceReads, 8);
    assert.equal(refused.tokens.length, 7); assert.equal(allocationCalls, 1);
    assert.equal(releases, 1); assert.equal(laterActions, 0);
    assert.equal(fs.existsSync(f.lock), false, 'the fault follows the original physical unlink');
  } finally { armed = false; release.mock.restore(); syncBuiltinESMExports(); f.dispose(); }
});

test('the actual selected restore branch keeps its original allocation callback outside the fresh registry', async t => {
  const f = await defaultLaunch(t), entry = f.entry;
  let launch: ReturnType<typeof createRuntimeTeamLaunch> | undefined;
  try {
    const stopped = Error('TEST stop at original restore boundary');
    const closed = await f.runtime.stopSession(entry.binding);
    assert.equal(closed.phase, 'closed'); assert.equal(closed.custody, 'released');
    const record = f.store.fenced(() => f.store.read<TeamLaunchRecord>(`launches/${runtimeDigest('TEST-run')}.json`)!);
    const previous = record.definition.members.find(member => member.memberId === entry.profile.memberId)!;
    const profile = { ...entry.profile, generation: entry.profile.generation + 1 };
    const selected = f.actualLaunch.selectRestore({ commandId: 'TEST-original-restore', member: { ...previous,
      binding: { ...entry.binding, generation: 'TEST-selected-restore' }, runtimeGeneration: profile.generation,
      configurationDigest: runtimeDigest(profile),
      restore: { commandId: 'TEST-original-restore', reference: 'cp1-' + runtimeDigest('TEST-checkpoint'), sourceBinding: entry.binding },
    } }, () => {}); // Controlled checkpoint verifier; this test stops before Runtime restore or provider work.
    assert.ok(selected.binding); assert.ok(selected.restore);
    entry.binding = selected.binding; entry.delivery = { ...entry.delivery, generation: selected.binding.generation };
    entry.profile = profile; entry.config = { ...entry.config, generation: profile.generation };
    entry.selection = { binding: selected.binding, generation: profile.generation,
      configurationDigest: selected.configurationDigest!, baseConfigurationDigest: selected.baseConfigurationDigest!,
      restore: selected.restore };
    let restoreCalls = 0, freshCalls = 0, checked = false, verificationFailure: unknown;
    t.mock.method(f.runtime, 'restoreSession', async (_input: Parameters<typeof f.runtime.restoreSession>[0], authority?: () => void) => {
      restoreCalls++;
      try {
        assert.ok(authority);
        assert.equal(readDefaultFreshAllocationContinuation(authority, entry), undefined,
          'the original restore callback is never marked as the plain fresh branch');
        authority(); checked = true;
      } catch (error) { verificationFailure = error; throw error; }
      throw stopped;
    });
    t.mock.method(f.runtime, 'openSession', async () => { freshCalls++; throw Error('TEST unexpected fresh open'); });
    launch = createRuntimeTeamLaunch({ root: f.root, team: f.team, entries: [...f.entries.values()],
      principalId: 'profile-admin', hostIncarnation: 'TEST-host', runtime: f.runtime,
      isCurrent: () => true, isSealed: () => false, assertWriter: f.assertWriter,
      trackOpening: pending => pending, onProgress() {} });
    const opening = launch.startMember('A'); assert.ok(opening);
    await opening; // The existing launch owner deliberately settles failed open attempts without rejection.
    if (verificationFailure) throw verificationFailure;
    assert.equal(checked, true); assert.equal(restoreCalls, 1); assert.equal(freshCalls, 0);
    assert.equal(fs.existsSync(join(f.store.directory, 'authority.lock')), false);
  } finally { try { launch?.seal(); } finally { f.dispose(); } }
});
