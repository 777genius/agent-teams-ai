import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { captureMemberProviderAuthority } from '../dist/composition/captureMemberProviderAuthority.js';
import { emptySession } from '../dist/runtime/sessionState.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { captureNativeInputAuthority } from '../dist/composition/captureNativeInputAuthority.js';
import { fixture } from './native-member-actions-fixture.ts';

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
