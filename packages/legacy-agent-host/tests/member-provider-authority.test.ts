import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { captureMemberProviderAuthority } from '../dist/composition/captureMemberProviderAuthority.js';
import { assertCapturedRosterCurrent, readCapturedProviderAuthority } from '../dist/composition/teamRoster.js';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { FileTeamRuntimeBindings } from '../dist/adapters/team/FileTeamRuntimeBindings.js';
import { emptySession } from '../dist/runtime/sessionState.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { captureNativeInputAuthority } from '../dist/composition/captureNativeInputAuthority.js';
import { fixture } from './native-member-actions-fixture.ts';
import { nativeMcpFixture } from './nativeCreationFixture.ts';
import type { OwnerState } from '../dist/team/ownerState.js';

test('closed provider authority reads one fresh state with three namespace traversals and keeps original refusals', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const team = entry.team;
  const writer = acquireProfileWriterLease(f.root);
  const authorityLock = join(f.store.directory, 'authority.lock');
  let lockPublications = 0, currentChecks = 0, closedChecks = 0, preludeChecks = 0, runtimeReads = 0;
  let stateReads = 0, namespaceTraversals = 0;
  const link = fs.linkSync, read = fs.readFileSync, directories = fs.readdirSync;
  const statePath = join(f.store.directory, 'state.json'), teamPath = join(f.root, 'teams', team.definition.binding.teamName);
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (args[1] === authorityLock) lockPublications++;
    return link(...args);
  });
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === statePath) stateReads++;
    return read(...args);
  });
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === teamPath) namespaceTraversals++;
    return directories(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const options = {
    entry, request: entry.config, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    assertWriter: writer.assertCurrent,
    assertCurrent() {
      currentChecks++;
      writer.assertCurrent();
      assertCapturedRosterCurrent(entry.team, entry.profile.principalId);
      assert.equal(f.owner.authorizeMemberBinding(entry.binding, 'dispatch'), true);
    },
    readRuntime() { runtimeReads++; assert.fail('Current authority must not acquire the Runtime fence'); },
  };
  const legacy = captureMemberProviderAuthority(options);
  const authority = captureMemberProviderAuthority({ ...options,
    beforeTeamAuthority() {
      preludeChecks++;
      assert.equal(fs.existsSync(authorityLock), false, 'the production prelude precedes the closed Team fence');
      writer.assertCurrent();
    },
    assertProviderAuthority() {
      closedChecks++;
      writer.assertCurrent();
      return readCapturedProviderAuthority(entry.team, entry.profile.principalId, entry.binding);
    },
  });
  try {
    assert.equal(legacy.isCurrent(), true);
    const baseline = { lockPublications, namespaceTraversals, stateReads };
    assert.deepEqual(baseline, { lockPublications: 1, namespaceTraversals: 6, stateReads: 7 });
    lockPublications = currentChecks = stateReads = namespaceTraversals = 0;
    assert.equal(authority.isCurrent(), true);
    const closed = { lockPublications, namespaceTraversals, stateReads };
    assert.deepEqual(closed, { lockPublications: 1, namespaceTraversals: 3, stateReads: 1 });
    t.diagnostic(JSON.stringify({ baseline, closed }));
    assert.equal(currentChecks, 0, 'qualified native lineage does not enter the legacy fallback');
    assert.equal(closedChecks, 1);
    assert.equal(preludeChecks, 1, 'the closed native path retains the production availability prelude');
    assert.equal(runtimeReads, 0);
    await Promise.resolve();
    assert.equal(authority.isCurrent(), true);
    assert.equal(lockPublications, 2, 'a later check obtains fresh authority');
    assert.equal(stateReads, 2);
    assert.equal(namespaceTraversals, 6);

    const beforeReplacement = lockPublications, beforeCallbacks = closedChecks;
    entry.team = { ...team };
    try {
      assert.equal(authority.isCurrent(), false);
      assert.equal(lockPublications, beforeReplacement);
      assert.equal(closedChecks, beforeCallbacks, 'changed Team cannot invoke a foreign authority callback');
    } finally { entry.team = team; }

    const retainedRoot = f.root + '-original';
    fs.renameSync(f.root, retainedRoot);
    try {
      // A complete directory shape would let a namespace-only guard acquire a
      // new lock. The original writer identity must refuse before that write.
      fs.mkdirSync(f.store.directory, { recursive: true, mode: 0o700 });
      assert.equal(authority.isCurrent(), false);
      assert.equal(lockPublications, beforeReplacement);
      assert.equal(closedChecks, beforeCallbacks);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
      fs.renameSync(retainedRoot, f.root);
    }

    f.human.revoke(entry.profile.principalId);
    const beforeRevokedCheck = lockPublications;
    assert.equal(authority.isCurrent(), false, 'the next check observes the actual persisted grant revocation');
    assert.equal(lockPublications, beforeRevokedCheck + 1);
    assert.equal(runtimeReads, 0);
    assert.equal(currentChecks, 0, 'revoked authority cannot select a legacy fallback');
  } finally {
    writer.release();
  }
});

test('restored provider authority binds the complete open request and keeps current fences', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const originalConfig = entry.config;
  const request = { ...entry.config, checkpointRef: 'TEST-exact-checkpoint' };
  const record = emptySession(entry.binding, 'TEST-profile', 'TEST-host');
  record.config = structuredClone(request);
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  record.phase = 'opening'; record.custody = 'unknown';
  let attached = false, allocationChecks = 0;
  const directory = join(f.root, 'teams', entry.team.definition.binding.teamName, '.host-owner');
  const lockPath = join(directory, 'authority.lock'), tokens: string[] = [];
  const originalRead = TeamOwnerStore.prototype.read;
  // Controlled authority proof: observe the real owner reads and canonical lock, without changing either.
  function observeRead<T>(this: TeamOwnerStore, name: string): T | undefined {
    if (this.directory === directory && name === 'state.json') {
      const [pid, , token] = readFileSync(lockPath, 'utf8').split('\n');
      assert.equal(pid, String(process.pid));
      assert.ok(token);
      assert.match(token, /^[a-f0-9-]{36}$/);
      tokens.push(token);
    }
    return (originalRead<T>).call(this, name);
  }
  t.mock.method(TeamOwnerStore.prototype, 'read', observeRead);
  const fences = t.mock.method(TeamOwnerStore.prototype, 'fenced');
  let currentFailure: Error | undefined;
  const authority = captureMemberProviderAuthority({
    entry, request, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    assertAllocation() { allocationChecks++; },
    assertCurrent() { if (currentFailure) throw currentFailure; },
    readRuntime: () => ({ record, attached }),
  });
  authority.assertCurrent();
  assert.ok(tokens.length >= 3, 'original admit state and both original control state reads are reached');
  assert.equal(new Set(tokens).size, 1, 'all original pair reads share one still-held canonical token');
  const firstToken = tokens[0]!;
  assert.equal(existsSync(lockPath), false, 'the original lock is released before this guard returns');
  tokens.length = 0;
  authority.assertCurrent();
  assert.ok(tokens.length >= 3);
  assert.equal(new Set(tokens).size, 1);
  assert.notEqual(tokens[0], firstToken, 'a later guard does not retain the prior lock or authority');
  assert.equal(existsSync(lockPath), false);
  tokens.length = 0;
  const fencesBeforeRefusal = fences.mock.callCount();
  currentFailure = new Error('TEST-original-current-refusal');
  assert.throws(() => authority.assertCurrent(), error => error === currentFailure);
  assert.equal(fences.mock.callCount(), fencesBeforeRefusal, 'original current refusal precedes Team fence entry');
  assert.equal(tokens.length, 0, 'original coordinator/current refusal precedes pair lock/state IO');
  assert.equal(existsSync(lockPath), false);
  currentFailure = undefined;
  assert.equal(authority.canAllocate(), true, 'exact checkpoint-bearing opening remains allocatable');
  assert.equal(allocationChecks, 1);
  record.config = { ...request, checkpointRef: 'TEST-other-checkpoint' };
  assert.equal(authority.canAllocate(), false, 'checkpoint identity remains fenced');
  record.config = structuredClone(request);
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: entry.config });
  assert.equal(authority.canAllocate(), false, 'base profile fingerprint cannot replace full request');
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  record.hostIncarnation = 'TEST-other-host'; assert.equal(authority.canAllocate(), false);
  record.hostIncarnation = 'TEST-host';
  record.phase = 'allocated'; record.custody = 'owned'; record.sessionRef = 'TEST-restored-session'; attached = true;
  authority.assertAllocatedCurrent();
  record.sealed = true; assert.equal(authority.canAllocate(), false); record.sealed = false;
  request.checkpointRef = 'TEST-mutated-caller';
  record.config = structuredClone(request);
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  assert.equal(authority.canAllocate(), false, 'caller mutation cannot replace captured request identity');
  request.checkpointRef = 'TEST-exact-checkpoint';
  record.config = structuredClone(request); record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  tokens.length = 0;
  const fencesBeforeMutation = fences.mock.callCount();
  entry.config = { ...entry.config, configRevision: 'TEST-replaced-entry' };
  assert.equal(authority.canAllocate(), false, 'immutable entry configuration remains fenced separately');
  assert.equal(fences.mock.callCount(), fencesBeforeMutation, 'immutable refusal precedes Team fence entry');
  assert.equal(tokens.length, 0, 'immutable entry refusal still precedes the final pair');
  assert.equal(existsSync(lockPath), false);
  entry.config = originalConfig;

  let preludeFailure: Error | undefined, innerFailure: Error | undefined;
  let preludeChecks = 0, currentChecks = 0, groupedRuntimeReads = 0;
  const guardTokens: string[] = [];
  const grouped = captureMemberProviderAuthority({
    entry, request, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    beforeTeamAuthority() {
      preludeChecks++;
      assert.equal(existsSync(lockPath), false, 'writer/availability prelude precedes the new Team fence');
      if (preludeFailure) throw preludeFailure;
    },
    assertCurrent() {
      currentChecks++;
      const token = readFileSync(lockPath, 'utf8').split('\n')[2];
      assert.ok(token);
      guardTokens.push(token);
      if (innerFailure) throw innerFailure;
      assert.equal(f.owner.authorizeMemberBinding(entry.binding, 'dispatch'), true);
    },
    readRuntime() { groupedRuntimeReads++; return { record, attached }; },
  });
  tokens.length = 0;
  grouped.assertCurrent();
  assert.equal(preludeChecks, 1); assert.equal(currentChecks, 1);
  assert.ok(tokens.length >= 4, 'the full current guard and unchanged final pair both read real state');
  assert.equal(new Set([...guardTokens, ...tokens]).size, 1, 'the full guard and pair share the held token');
  const groupedFirstToken = guardTokens[0]!;
  assert.equal(existsSync(lockPath), false);
  tokens.length = 0; guardTokens.length = 0;
  grouped.assertCurrent();
  assert.equal(preludeChecks, 2); assert.equal(currentChecks, 2);
  assert.equal(new Set([...guardTokens, ...tokens]).size, 1);
  assert.notEqual(guardTokens[0], groupedFirstToken, 'the next full guard acquires fresh authority');
  assert.equal(existsSync(lockPath), false);
  tokens.length = 0; guardTokens.length = 0;
  const fencesBeforePrelude = fences.mock.callCount();
  preludeFailure = new Error('TEST-writer-or-capture-refusal');
  assert.throws(() => grouped.assertCurrent(), error => error === preludeFailure);
  assert.equal(fences.mock.callCount(), fencesBeforePrelude);
  assert.equal(currentChecks, 2, 'a refused prelude cannot enter the full guard');
  assert.equal(tokens.length, 0); assert.equal(guardTokens.length, 0);
  assert.equal(existsSync(lockPath), false);
  preludeFailure = undefined;
  innerFailure = new Error('TEST-original-inner-current-refusal');
  assert.throws(() => grouped.assertCurrent(), error => error === innerFailure);
  assert.equal(guardTokens.length, 1);
  assert.equal(tokens.length, 0, 'an inner exception still short-circuits the original final pair');
  assert.equal(existsSync(lockPath), false, 'the original finally releases a refused grouped guard');
  innerFailure = undefined;
  const fencesBeforeWrongAction = fences.mock.callCount();
  let wrongActionCallbacks = 0;
  for (const action of ['read', 'control'] as const) {
    assert.equal(f.owner.authorizeRuntimeAccess(entry.profile.principalId, entry.binding, action,
      () => { wrongActionCallbacks++; }), false);
  }
  assert.equal(wrongActionCallbacks, 0);
  assert.equal(fences.mock.callCount(), fencesBeforeWrongAction);
  assert.equal(tokens.length, 0, 'read/control cannot acquire the provider-only composition callback');
  assert.equal(groupedRuntimeReads, 0, 'grouping ends before any original Runtime lookup');
  assert.equal(existsSync(lockPath), false);

  // An admitted member and an actor allowed to control it are separate original conditions.
  let refusedRuntimeReads = 0;
  const asPrincipal = (principalId: string) => captureMemberProviderAuthority({
    entry: { ...entry, profile: { ...entry.profile, principalId } },
    request, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    assertCurrent() {},
    readRuntime() { refusedRuntimeReads++; return { record, attached }; },
  });
  const other = [...f.entries.values()].find(value => value.binding.memberId === 'B')!;
  assert.equal(f.owner.authorizeMemberBinding(entry.binding, 'admit'), true);
  const foreignPrincipal = asPrincipal(other.profile.principalId);
  tokens.length = 0;
  assert.equal(foreignPrincipal.canAllocate(), false, 'admission does not grant another member control');
  assert.ok(tokens.length >= 3, 'the admitted member reaches the original principal control read');
  assert.equal(new Set(tokens).size, 1);
  assert.equal(refusedRuntimeReads, 0);
  assert.equal(existsSync(lockPath), false, 'control refusal releases the original outer lock');

  const admin = asPrincipal('profile-admin');
  f.owner.connect('profile-admin').revoke(entry.profile.principalId);
  f.owner.connect('profile-admin').revoke('TEST-other-A-grant');
  assert.equal(f.owner.authorizeRuntimeAccess('profile-admin', entry.binding, 'control'), true);
  tokens.length = 0;
  assert.equal(admin.canAllocate(), false, 'admin control cannot replace the original member admission');
  assert.ok(tokens.length > 0);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(refusedRuntimeReads, 0);
  assert.equal(authority.canAllocate(), false, 'later guards observe original revocation without a cache');
  assert.equal(allocationChecks, 1, 'refused pair checks never hand off a new allocation');
  assert.equal(existsSync(lockPath), false, 'admission refusal also releases its original lock');
});


test('restored native input keeps the full checkpoint-bearing request identity', async (t) => {
  const f = await fixture(t);
  const snapshot = f.runtime.readSession(f.lead.binding);
  const record = structuredClone(snapshot.record!);
  const request = { ...f.lead.config, checkpointRef: 'TEST-exact-checkpoint' };
  record.config = structuredClone(request);
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  const capture = (config: typeof f.lead.config) => captureNativeInputAuthority({
    binding: f.lead.binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config,
    readRuntime: () => ({ record, attached: snapshot.attached }),
    captureTeam: (raw) => f.owner.captureNativeMcpAuthority('native-L', f.lead.binding, raw, true),
    assertCurrent() {},
  });
  assert.throws(() => capture(f.lead.config), /hold/, 'base member recipe omits the checkpoint identity');
  const source = capture(request);
  source.assertCurrent();
  record.config = { ...request, checkpointRef: 'TEST-other-checkpoint' };
  assert.throws(() => source.assertCurrent(), /hold/, 'restored native input cannot cross checkpoint identity');
});

test('only validated legacy roster applicability can fall back after all common authority checks', async (t) => {
  const f = await fixture(t), entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  entry.profile = { ...entry.profile, principalId: 'profile-admin' };
  // A legacy captured roster without delivery metadata still has the same saved settings.
  for (const member of entry.team.definition.members) delete member.delivery;
  const writer = acquireProfileWriterLease(f.root);
  let fallbacks = 0;
  const authority = captureMemberProviderAuthority({
    entry, request: entry.config, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    assertWriter: writer.assertCurrent,
    assertProviderAuthority: () => readCapturedProviderAuthority(entry.team, entry.profile.principalId, entry.binding),
    assertCurrent() {
      fallbacks++;
      assertCapturedRosterCurrent(entry.team, entry.profile.principalId);
      assert.equal(f.owner.authorizeMemberBinding(entry.binding, 'dispatch'), true);
    },
    readRuntime() { assert.fail('No Runtime lookup in a provider authority check'); },
  });
  const original = f.store.read<OwnerState>('state.json')!;
  const faults: [string, (state: OwnerState) => void][] = [
    ['revoked principal', state => { state.grants.find(grant => grant.principalId === 'profile-admin')!.revoked = true; }],
    ['revoked member grants', state => { for (const grant of state.grants.filter(grant => grant.memberName === 'alice')) grant.revoked = true; }],
    ['principal without member control', state => { state.grants.find(grant => grant.principalId === 'profile-admin')!.permissions = ['read']; }],
    ['pending cleanup', state => { state.lifecycle = { cleanupCommandId: 'TEST-pending-cleanup', cleanupPending: true }; }],
    ['malformed roster history', state => { state.rosterCommands = [{ commandId: 'TEST-invalid-roster', principalId: 'human', fingerprint: 'invalid', revision: 'a'.repeat(64) }]; }],
  ];
  try {
    assert.equal(authority.isCurrent(), true);
    assert.equal(fallbacks, 1, 'the original full fallback still supports this legacy capture');
    for (const [name, mutate] of faults) {
      const changed = structuredClone(original);
      mutate(changed);
      f.store.fenced(() => f.store.write('state.json', changed));
      try {
        assert.equal(authority.isCurrent(), false, name);
        assert.equal(fallbacks, 1, `${name} cannot become unavailable native lineage`);
      } finally {
        f.store.fenced(() => f.store.write('state.json', original));
      }
    }
    assert.throws(() => readCapturedProviderAuthority(entry.team, entry.profile.principalId,
      { ...entry.binding, generation: 'TEST-foreign-generation' }), /forbidden/);
    assert.equal(authority.isCurrent(), true, 'a later call freshly revalidates the restored original state');
    assert.equal(fallbacks, 2);
  } finally { writer.release(); }
});

test('both live workAllowed reads remain independent and final namespace validation refuses a late alias', async (t) => {
  const f = await fixture(t), entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const writer = acquireProfileWriterLease(f.root);
  const current = FileTeamRuntimeBindings.prototype.current;
  let targetReads = 0, denyAt = 0, injectAlias = false, fallbacks = 0;
  const outside = join(f.root, 'TEST-outside-namespace'), alias = join(f.root, 'teams', entry.team.definition.binding.teamName, 'TEST-late-alias');
  fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'canary'), 'TEST untouched');
  t.mock.method(FileTeamRuntimeBindings.prototype, 'current', function (this: FileTeamRuntimeBindings, ...args: Parameters<typeof current>) {
    const selected = current.apply(this, args);
    if (args[0].memberId === entry.binding.memberId) {
      targetReads++;
      if (injectAlias && targetReads === 3)
        fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      if (targetReads === denyAt) {
        assert.ok(selected);
        return { ...selected, workAllowed: false };
      }
    }
    return selected;
  });
  const authority = captureMemberProviderAuthority({
    entry, request: entry.config, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    assertWriter: writer.assertCurrent,
    assertProviderAuthority: () => readCapturedProviderAuthority(entry.team, entry.profile.principalId, entry.binding),
    assertCurrent() { fallbacks++; assert.fail('This native roster has no legacy fallback'); },
    readRuntime() { assert.fail('Current authority cannot read Runtime'); },
  });
  try {
    assert.equal(authority.isCurrent(), true);
    assert.equal(targetReads, 3, 'one delivery projection plus separate dispatch and admit binding reads');
    for (const deniedRead of [2, 3]) {
      targetReads = 0; denyAt = deniedRead;
      assert.equal(authority.isCurrent(), false);
      assert.equal(targetReads, deniedRead, 'each original workAllowed cut can independently refuse');
    }
    targetReads = 0; denyAt = 0; injectAlias = true;
    assert.equal(authority.isCurrent(), false, 'the final nested fence detects mutation after live binding policy');
    assert.equal(targetReads, 3);
    assert.equal(fallbacks, 0);
    assert.equal(fs.readFileSync(join(outside, 'canary'), 'utf8'), 'TEST untouched');
    fs.unlinkSync(alias);
    injectAlias = false; targetReads = 0;
    assert.equal(authority.isCurrent(), true, 'no poisoned result or authorization is retained between calls');
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    writer.release();
  }
});

test('closed currentness follows an original additive roster receipt without replacing an existing member', (t) => {
  const f = nativeMcpFixture(t), before = f.store.read<OwnerState>('state.json')!;
  const member = structuredClone(before.members[0]!);
  const expectedRevision = f.human.readRoster().revision;
  const read = () => f.owner.capturedProviderAuthority('native-connection', f.source, expectedRevision, member, before.savedSettings);
  assert.equal(read(), 'current');
  const source = captureNativeInputAuthority(f.options);
  const added = f.owner.nativeRoster.nativeCreation().begin(source, {
    commandId: 'TEST-closed-authority-addition', expectedRosterRevision: expectedRevision,
    member: { name: 'bob', providerId: 'anthropic', model: 'TEST-model', role: 'TEST additional worker' },
  });
  assert.equal(added.fresh, true);
  assert.equal(read(), 'current');
  const after = f.store.read<OwnerState>('state.json')!;
  assert.deepEqual(after.members[0], member);
  assert.equal(after.members.length, before.members.length + 1);
  assert.notEqual(f.human.readRoster().revision, expectedRevision);
  after.rosterCommands![0]!.fingerprint = 'TEST-corrupt-history';
  f.store.fenced(() => f.store.write('state.json', after));
  assert.throws(read, /hold/, 'malformed additive history is not a legacy-applicability result');
});

test('immutable provider entries and denied or unexpected aggregate results cannot enter fallback', async (t) => {
  const f = await fixture(t), entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const writer = acquireProfileWriterLease(f.root);
  let checks = 0, fallbacks = 0, mode: 'current' | 'deny' | 'unexpected' = 'current';
  const authority = captureMemberProviderAuthority({
    entry, request: entry.config, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    assertWriter: writer.assertCurrent,
    assertProviderAuthority() {
      checks++;
      if (mode === 'deny') throw Error('TEST-original-denial');
      if (mode === 'unexpected') return 'TEST-invalid-result' as unknown as 'current';
      return readCapturedProviderAuthority(entry.team, entry.profile.principalId, entry.binding);
    },
    assertCurrent() { fallbacks++; },
    readRuntime() { assert.fail('No Runtime lookup while checking captured entry identity'); },
  });
  const original = { binding: entry.binding, delivery: entry.delivery, profile: entry.profile, config: entry.config };
  const replacements = [
    { binding: { ...entry.binding, generation: 'TEST-foreign' } },
    { delivery: { ...entry.delivery, runId: 'TEST-foreign' } },
    { profile: { ...entry.profile, principalId: 'profile-admin' } },
    { profile: { ...entry.profile, model: 'TEST-foreign' } },
    { config: { ...entry.config, configRevision: 'TEST-foreign' } },
  ];
  try {
    for (const replacement of replacements) {
      Object.assign(entry, replacement);
      assert.equal(authority.isCurrent(), false);
      assert.equal(checks, 0, 'immutable entry checks precede any Team aggregate hook');
      Object.assign(entry, original);
    }
    mode = 'deny'; assert.throws(authority.assertCurrent, /TEST-original-denial/);
    mode = 'unexpected'; assert.throws(authority.assertCurrent, /forbidden/);
    assert.equal(fallbacks, 0);
    mode = 'current'; assert.equal(authority.isCurrent(), true);
    assert.equal(fallbacks, 0);
  } finally { Object.assign(entry, original); writer.release(); }
});

test('a prepared original lifecycle command refuses currentness before its state publication', async (t) => {
  const f = await fixture(t), entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const before = f.store.read<OwnerState>('state.json')!;
  const lifecycle = f.owner.lifecycleCommands('human');
  const input = { commandId: 'TEST-pending-lifecycle', operation: 'trash' as const, expectedRevision: lifecycle.view().revision };
  const write = TeamOwnerStore.prototype.write;
  const fault = t.mock.method(TeamOwnerStore.prototype, 'write', function (this: TeamOwnerStore, name: string, value: unknown) {
    if (name === 'state.json' && (value as OwnerState).lifecycle?.cleanupCommandId === input.commandId)
      throw Error('TEST-state-publication-cut');
    return write.call(this, name, value);
  });
  assert.throws(() => lifecycle.execute(input), /TEST-state-publication-cut/);
  fault.mock.restore();
  assert.deepEqual(f.store.read<OwnerState>('state.json'), before);
  const pending = f.store.list<{ family?: string; phase?: string; commandId?: string }>('commands')
    .find(row => row.commandId === input.commandId);
  assert.equal(pending?.family, 'lifecycle'); assert.equal(pending.phase, 'prepared');
  assert.throws(() => readCapturedProviderAuthority(entry.team, entry.profile.principalId, entry.binding), /forbidden/);
});
