import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeMcpFixture } from './nativeCreationFixture.ts';
import { captureNativeInputAuthority } from '../dist/composition/captureNativeInputAuthority.js';
import { TeamRosterTransitions } from '../dist/team/TeamRosterTransitions.js';
import { createNativeMemberCreation } from '../dist/composition/createNativeMemberCreation.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';
import { runtimeDigest, normalizeBinding } from '../dist/runtime/identity.js';
import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { nativeAdditionDefinition } from '../dist/team-launch/nativeLaunchAddition.js';
import { nativeRosterSuccessor } from '../dist/team/nativeRosterSuccessor.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { NativeMemberCreationInput } from '../dist/team/nativeMemberCreationContracts.js';

function setup(t: { after(fn: () => void): void }, role: 'lead' | 'member' = 'lead') {
  const native = nativeMcpFixture(t, role),
    store = native.store;
  const roster = new TeamRosterTransitions({
    binding: native.binding,
    store,
    state: () => {
      const state = store.read<OwnerState>('state.json');
      assert.ok(state);
      return state;
    },
    authorize: (principal, permission) =>
      native.owner.withLaunchAuthority(
        principal,
        permission === 'admin' ? 'control' : 'read',
        () => {
          const grant = store
            .read<OwnerState>('state.json')!
            .grants.find((row) => row.principalId === principal);
          assert.ok(grant);
          return grant;
        }
      ),
    assertEditable() {
      throw new Error('must not stop or replace peers');
    },
    invalidate() {},
  });
  const input: NativeMemberCreationInput = {
    commandId: 'TEST-add-member',
    expectedRosterRevision: roster.read('human').revision,
    member: {
      name: 'bob',
      providerId: 'anthropic',
      model: 'TEST-configured-model',
      role: 'Implement the assigned work',
    },
  };
  const source = () => captureNativeInputAuthority(native.options);
  const selection = (memberId: string) => ({
    principalId: 'TEST-new-native-principal',
    configurationDigest: 'a'.repeat(64),
    delivery: {
      ...native.source,
      teamName: native.binding.teamName,
      memberId,
      generation: '1',
    },
  });
  return {
    native,
    store,
    roster,
    owner: roster.nativeCreation(),
    input,
    source,
    selection,
  };
}

test('actual lead DO publishes original expected member before preflight; peers/outbox preserved and cold duplicate never reallocates', async (t) => {
  const f = setup(t),
    authority = f.source();
  const stateBefore = f.store.read<OwnerState>('state.json')!;
  const peer = structuredClone(stateBefore.members[0]),
    grant = structuredClone(stateBefore.grants);
  const outboxBefore = f.store.list('outbox');
  let preflight = 0,
    allocation = 0,
    reminders = 0;
  const runtime = {
    async prepare(_input: NativeMemberCreationInput, expected: { memberId: string }) {
      preflight++;
      const current = f.store.read<OwnerState>('state.json')!;
      assert.equal(current.members.find((row) => row.memberId === expected.memberId)?.name, 'bob');
      assert.equal(current.rosterCommands?.[0]?.nativeCreation?.phase, 'prepared');
      return f.selection(expected.memberId);
    },
    expected() {},
    selection: (captured: ReturnType<typeof f.selection>) => captured,
    async install(captured: ReturnType<typeof f.selection>, current: () => void) {
      current();
      allocation++;
      const state = f.store.read<OwnerState>('state.json')!;
      assert.equal(state.rosterCommands?.[0]?.nativeCreation?.phase, 'configured');
      assert.equal(
        state.members.find((row) => row.memberId === captured.delivery.memberId)?.delivery?.runId,
        authority.team.source.runId
      );
    },
    remindPeers() {
      reminders++;
    },
  };
  const usecase = createNativeMemberCreation({
    owner: f.owner,
    runtime,
    assertCurrent() {},
  });
  const result = await usecase.add(authority, f.input);
  assert.equal(result.phase, 'completed');
  assert.equal(result.name, 'bob');
  const state = f.store.read<OwnerState>('state.json')!;
  assert.deepEqual(state.members[0], peer);
  assert.deepEqual(state.grants.slice(0, grant.length), grant);
  assert.deepEqual(f.store.list('outbox'), outboxBefore);
  assert.equal(state.grants.at(-1)?.permissions.includes('admin'), false);
  // Same actual Team files, reconstructed owner: no fresh command or effect on lost reply.
  const reopened = setupOwner(f);
  assert.deepEqual(
    await createNativeMemberCreation({
      owner: reopened,
      runtime,
      assertCurrent() {},
    }).add(authority, f.input),
    result
  );
  assert.deepEqual([preflight, allocation, reminders], [1, 1, 1]);
  assert.deepEqual(reopened.lookup(authority, f.input), result);
});

function setupOwner(f: ReturnType<typeof setup>) {
  return new TeamRosterTransitions({
    binding: f.native.binding,
    store: f.store,
    state: () => f.store.read<OwnerState>('state.json')!,
    authorize() {
      throw new Error('native creation must use actual source authority');
    },
    assertEditable() {
      throw new Error('must not stop peers');
    },
    invalidate() {},
  }).nativeCreation();
}

test('stale roster, nonlead, ASK, wrong source and revoked grant refuse before expected membership/native allocation', async (t) => {
  const f = setup(t),
    before = readFileSync(join(f.store.directory, 'state.json'));
  assert.throws(() =>
    f.owner.begin(f.source(), {
      ...f.input,
      expectedRosterRevision: 'b'.repeat(64),
    })
  );
  assert.deepEqual(readFileSync(join(f.store.directory, 'state.json')), before);
  const current = f.source();
  assert.throws(() =>
    f.owner.begin(
      {
        ...current,
        team: {
          ...current.team,
          source: { ...current.team.source, memberId: 'wrong-member' },
        },
      },
      f.input
    )
  );
  const ask = f.native.input('ask');
  f.native.record = {
    ...f.native.record,
    inputs: [
      {
        intent: ask,
        fingerprint: deliveryFingerprint(ask),
        operationRef: 'TEST-ask-operation',
        phase: 'consumed',
      },
    ],
  };
  assert.throws(f.source);
  const member = setup(t, 'member');
  assert.throws(() => member.owner.begin(member.source(), member.input));
  const original = setup(t),
    source = original.source();
  const state = original.store.read<OwnerState>('state.json')!;
  state.grants.find((row) => row.principalId === source.team.principalId)!.revoked = true;
  original.store.fenced(() => original.store.write('state.json', state));
  assert.throws(() => original.owner.begin(source, original.input));
  assert.equal(original.store.read<OwnerState>('state.json')!.members.length, 1);
});

test('interruption after persisted expected member retains original prepared receipt; duplicate is query-only', async (t) => {
  const f = setup(t),
    source = f.source();
  const first = f.owner.begin(source, f.input);
  assert.equal(first.fresh, true);
  const cold = setupOwner(f);
  let effects = 0;
  const runtime = {
    async prepare() {
      effects++;
      throw new Error('must never allocate');
    },
    expected() {},
    selection() {
      throw new Error('unreachable');
    },
    async install() {
      effects++;
    },
    remindPeers() {
      effects++;
    },
  };
  const value = await createNativeMemberCreation({
    owner: cold,
    runtime,
    assertCurrent() {},
  }).add(source, f.input);
  assert.equal(value.phase, 'prepared');
  assert.equal(effects, 0);
  assert.throws(() =>
    cold.begin(source, {
      ...f.input,
      member: { ...f.input.member, model: 'changed' },
    })
  );
  assert.equal(cold.lookup(source, f.input)?.memberId, first.value.memberId);
});

test('source revocation during real asynchronous preflight never publishes a new native grant or allocates', async (t) => {
  const f = setup(t),
    source = f.source();
  let allocations = 0;
  const runtime = {
    async prepare(_input: NativeMemberCreationInput, expected: { memberId: string }) {
      await Promise.resolve();
      const state = f.store.read<OwnerState>('state.json')!;
      state.grants.find((row) => row.principalId === source.team.principalId)!.revision!++;
      f.store.fenced(() => f.store.write('state.json', state));
      return f.selection(expected.memberId);
    },
    expected() {},
    selection: (captured: ReturnType<typeof f.selection>) => captured,
    async install() {
      allocations++;
    },
    remindPeers() {},
  };
  await assert.rejects(
    createNativeMemberCreation({
      owner: f.owner,
      runtime,
      assertCurrent() {},
    }).add(source, f.input)
  );
  assert.equal(allocations, 0);
  const state = f.store.read<OwnerState>('state.json')!;
  assert.equal(state.members.find((row) => row.name === 'bob')?.delivery, undefined);
  assert.equal(
    state.grants.some((row) => row.principalId === 'TEST-new-native-principal'),
    false
  );
  assert.equal(state.rosterCommands?.[0]?.nativeCreation?.phase, 'prepared');
});

test('same original launch persists only the added target before allocation; cold metadata and duplicate never open it again', async (t) => {
  const f = setup(t),
    source = f.source(),
    baseMember = f.store.read<OwnerState>('state.json')!.members[0]!;
  const admission = f.owner.begin(source, f.input),
    selection = f.selection(admission.value.memberId);
  const definition = {
    launchId: f.native.source.runId,
    rosterRevision: 'TEST-original-launch-revision',
    members: [
      {
        memberId: f.native.source.memberId,
        binding: f.native.source,
        configurationDigest: 'b'.repeat(64),
        contextDigest: 'c'.repeat(64),
        configRevision: 'TEST-original-config',
        skipped: false,
        timeoutMs: 1000,
      },
    ],
  };
  let allocations = 0;
  const path = `launches/${runtimeDigest(definition.launchId)}.json`;
  const runtime = {
    read() {
      return { attached: false, nativeReady: false };
    },
    async open(memberId: string, guard?: () => void) {
      guard?.();
      allocations++;
      const record =
        f.store.read<import('../dist/team-launch/contracts.js').TeamLaunchRecord>(path)!;
      assert.equal(
        record.definition.members.some((row) => row.memberId === memberId),
        true
      );
      assert.equal(
        record.members.find((row) => row.memberId === memberId)?.attempts[0]?.claimed,
        true
      );
      assert.equal(record.nativeAdditions?.[0]?.commandId, f.input.commandId);
    },
  };
  const authorized = <T>(_action: 'read' | 'control', operation: () => T): T =>
    f.owner.withConfigured(source, f.input, operation);
  const options = {
    definition,
    hostIncarnation: 'TEST-original-host',
    store: f.store,
    authorized,
    runtime,
  };
  const launch = new TeamLaunchOwner(options);
  const record = f.store.read<import('../dist/team-launch/contracts.js').TeamLaunchRecord>(path)!;
  record.startCommandId = 'TEST-original-start';
  record.startedAtMs = 0;
  f.store.fenced(() => f.store.write(path, record));
  const peerAttempt = structuredClone(record.members[0]),
    peerExpected = structuredClone(record.definition.members[0]);
  const input = {
    commandId: f.input.commandId,
    inputAuthority: source.fingerprint,
    rosterRevision: admission.value.revision,
    member: {
      memberId: selection.delivery.memberId,
      binding: normalizeBinding(selection.delivery),
      configurationDigest: 'a'.repeat(64),
      contextDigest: 'd'.repeat(64),
      configRevision: 'TEST-new-config',
      skipped: false,
      timeoutMs: 1000,
    },
    capture: {
      memberId: selection.delivery.memberId,
      model: f.input.member.model!,
    },
  };
  assert.equal(
    launch.appendExpectedNativeMember(input, (operation) =>
      f.owner.withPrepared(source, f.input, operation)
    ),
    true
  );
  f.owner.configure(source, f.input, selection);
  assert.equal(allocations, 0);
  assert.deepEqual(
    f.store.read<import('../dist/team-launch/contracts.js').TeamLaunchRecord>(path)!.members[0],
    peerAttempt
  );
  assert.deepEqual(
    f.store.read<import('../dist/team-launch/contracts.js').TeamLaunchRecord>(path)!.definition
      .members[0],
    peerExpected
  );
  assert.equal(
    nativeRosterSuccessor(
      f.store.read<OwnerState>('state.json')!,
      f.input.expectedRosterRevision,
      baseMember,
      f.store.read<OwnerState>('state.json')!.savedSettings
    ),
    true,
    'legitimate additive membership preserves peer capture'
  );
  await launch.startMember(
    selection.delivery.memberId,
    () => {
      f.owner.withConfigured(source, f.input, () => {});
    },
    f.input.commandId
  );
  assert.equal(
    launch.appendExpectedNativeMember(input, (operation) =>
      f.owner.withConfigured(source, f.input, operation)
    ),
    false
  );
  const retained = f.store.read<import('../dist/team-launch/contracts.js').TeamLaunchRecord>(path)!;
  const coldDefinition = nativeAdditionDefinition(definition, retained);
  const cold = new TeamLaunchOwner({ ...options, definition: coldDefinition });
  assert.equal(cold.read().expected, 2);
  assert.equal(allocations, 1, 'cold construction/read cannot replay opening');
  cold.seal();
  launch.seal();
  const changed = f.store.read<OwnerState>('state.json')!;
  changed.members[0]!.settings = { role: 'Different human-configured role' };
  changed.rosterVersion!++;
  assert.equal(
    nativeRosterSuccessor(
      changed,
      f.input.expectedRosterRevision,
      baseMember,
      changed.savedSettings
    ),
    false
  );
});
