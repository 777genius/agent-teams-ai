import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createRuntimeTeamLaunch } from '../dist/composition/createRuntimeTeamLaunch.js';
import { captureRuntimeControlAuthority } from '../dist/composition/runtimeControlAuthority.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import type { OwnerState } from '../dist/team/ownerState.js';
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
    return { ...f, entry, lock, current, dispose,
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
