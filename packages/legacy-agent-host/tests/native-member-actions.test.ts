import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './native-member-actions-fixture.ts';
import { runtimeDigest as digest } from '../dist/runtime/identity.js';
import { executeNativeMemberAction } from '../dist/composition/executeNativeMemberAction.js';
import { captureNativeInputAuthority } from '../dist/composition/captureNativeInputAuthority.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
const field = (value: unknown, key: string): unknown => {
  assert.ok(value && typeof value === 'object' && key in value);
  return Reflect.get(value, key);
};
const tick = () => new Promise<void>((done) => setImmediate(done));
async function until(check: () => boolean) {
  for (let i = 0; i < 16; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail('Controlled original close did not begin');
}

test('actual native lead DO replaces only target generation using its own actor, even without profile-admin grant; same original never reallocates', async (t) => {
  const f = await fixture(t),
    request = f.request('TEST-native-restart');
  const peer = [...f.entries.values()].find((e) => e.binding.memberId === 'B')!;
  f.human.execute({
    commandId: 'TEST-peer-queued',
    operation: 'message.send',
    payload: { to: 'bob', text: 'Keep peer queued', actionMode: 'do' },
  });
  await f.runtime.admitDelivery(
    f.human.pendingDeliveries().find((row) => row.commandId === 'TEST-peer-queued')!
  );
  const before = structuredClone(f.runtime.readSession(peer.binding));
  const prepared = await f.call('prepare', request.commandId, request.body);
  assert.equal(field(prepared, 'stage'), 'prepared');
  f.human.revoke('profile-admin');
  const selected = await f.call('execute', request.commandId, request.body);
  assert.equal(field(selected, 'stage'), 'selected');
  assert.deepEqual(f.runtime.readSession(peer.binding), before);
  assert.equal(f.drivers.get('B:1')!.closed, 0);
  assert.deepEqual(f.opened, ['L:1', 'A:1', 'B:1', 'A:2']);
  assert.equal(f.drivers.get('A:1')!.closed, 1);
  const rows = f.store.read<{
    memberActions: { actor: { principalId: string; inputAuthority: string } }[];
  }>(`launches/${digest('TEST-run')}.json`)!;
  await assert.rejects(
    f.call('lookup', 'TEST-wrong-target', {
      launchId: 'TEST-run',
      memberId: 'B',
      originalCommandId: request.commandId,
    }),
    /conflict|forbidden/
  );
  assert.equal(rows.memberActions[0]!.actor.principalId, 'native-L');
  assert.equal(rows.memberActions[0]!.actor.inputAuthority, f.source.fingerprint);
  assert.equal(
    field(await f.call('execute', request.commandId, request.body), 'stage'),
    'selected'
  );
  assert.deepEqual(f.opened, ['L:1', 'A:1', 'B:1', 'A:2']);
  assert.equal(
    field(
      await f.call('lookup', 'TEST-read', {
        launchId: 'TEST-run',
        memberId: 'A',
        originalCommandId: request.commandId,
      }),
      'stage'
    ),
    'selected'
  );
});

test('DO changing to ASK during original cleanup leaves requested receipt and physical closure, never opens target or repeats Stop; original lookup is read-only', async (t) => {
  const f = await fixture(t),
    request = f.request('TEST-native-DO-ASK');
  let release!: () => void;
  const old = f.drivers.get('A:1')!;
  old.closeWait = new Promise<void>((done) => (release = done));
  await f.call('prepare', request.commandId, request.body);
  const pending = f.call('execute', request.commandId, request.body);
  const refusal = assert.rejects(pending, /forbidden|hold/);
  await until(() => old.closed === 1);
  await f.nextAsk();
  release();
  await refusal;
  assert.equal(old.closed, 1);
  assert.deepEqual(f.opened, ['L:1', 'A:1', 'B:1']);
  assert.equal(f.drivers.get('B:1')!.closed, 0);
  const original = await f.call('lookup', 'TEST-query', {
    launchId: 'TEST-run',
    memberId: 'A',
    originalCommandId: request.commandId,
  });
  assert.equal(field(original, 'stage'), 'requested');
  await assert.rejects(f.call('execute', request.commandId, request.body), /forbidden|hold/);
  assert.equal(old.closed, 1);
  assert.throws(
    () =>
      captureNativeInputAuthority({
        binding: f.lead.binding,
        profileId: 'TEST-profile',
        hostIncarnation: 'TEST-host',
        config: f.lead.config,
        readRuntime: () => f.runtime.readSession(f.lead.binding),
        captureTeam: (raw) =>
          f.owner.captureNativeMcpAuthority('native-L', f.lead.binding, raw, true),
        assertCurrent() {},
      }),
    /forbidden/
  );
});

test('source grant revoked across await cannot publish/open a successor or use profile authority for original lookup', async (t) => {
  const f = await fixture(t),
    request = f.request('TEST-native-revoked');
  let release!: () => void;
  const old = f.drivers.get('A:1')!;
  old.closeWait = new Promise<void>((done) => (release = done));
  await f.call('prepare', request.commandId, request.body);
  const refusal = assert.rejects(f.call('execute', request.commandId, request.body), /forbidden/);
  await until(() => old.closed === 1);
  f.human.revoke('native-L');
  release();
  await refusal;
  assert.equal(old.closed, 1);
  assert.equal(f.opened.length, 3);
  await assert.rejects(
    f.call('lookup', 'TEST-query', {
      launchId: 'TEST-run',
      memberId: 'A',
      originalCommandId: request.commandId,
    }),
    /forbidden/
  );
  assert.equal(f.drivers.get('B:1')!.closed, 0);
});

test('UNKNOWN target custody retains same requested original and duplicate native control is query-only; self/foreign/extra actor payload refuse', async (t) => {
  const f = await fixture(t),
    request = f.request('TEST-native-UNKNOWN');
  f.drivers.get('A:1')!.confirmed = false;
  await f.call('prepare', request.commandId, request.body);
  await assert.rejects(f.call('execute', request.commandId, request.body), /hold/);
  assert.equal(
    field(await f.call('execute', request.commandId, request.body), 'stage'),
    'requested'
  );
  assert.equal(f.drivers.get('A:1')!.closed, 1);
  assert.equal(f.opened.length, 3);
  await assert.rejects(
    f.call('prepare', 'TEST-self', { ...request.body, memberId: 'L' }),
    /forbidden/
  );
  await assert.rejects(
    f.call('prepare', 'TEST-foreign', { ...request.body, launchId: 'TEST-other-run' }),
    /forbidden/
  );
  await assert.rejects(
    f.call('prepare', 'TEST-forged', { ...request.body, principalId: 'profile-admin', mode: 'do' })
  );
  assert.equal(f.drivers.get('L:1')!.closed, 0);
  assert.equal(f.drivers.get('B:1')!.closed, 0);
});

test('native same-binding proven-noAllocation retry records actual original actor before opening; lost ACK lookup/repeat never allocates twice', async (t) => {
  const f = await fixture(t, false),
    entry = [...f.entries.values()].find((e) => e.binding.memberId === 'A')!;
  entry.config = { ...entry.config, generation: -1 };
  await f.launch.startMember('A');
  entry.config = { ...entry.config, generation: 1 };
  assert.equal(f.launch.read().members.find((m) => m.memberId === 'A')!.attempt.noAllocation, true);
  const input = {
    launchId: 'TEST-run',
    rosterRevision: f.launch.read().rosterRevision,
    memberId: 'A',
    attemptId: 'TEST-native-retry-attempt',
  };
  const first = await f.call('retry', 'TEST-native-retry', input);
  await tick();
  assert.equal(field(first, 'commandId'), 'TEST-native-retry');
  assert.deepEqual(f.opened, ['L:1', 'B:1', 'A:1']);
  const original = await f.call('lookup', 'TEST-query', {
    launchId: 'TEST-run',
    memberId: 'A',
    originalCommandId: 'TEST-native-retry',
  });
  assert.deepEqual(original, {
    commandId: 'TEST-native-retry',
    attemptId: 'TEST-native-retry-attempt',
    current: true,
  });
  await f.call('retry', 'TEST-native-retry', input);
  await tick();
  assert.deepEqual(f.opened, ['L:1', 'B:1', 'A:1']);
  await assert.rejects(
    f.call('lookup', 'TEST-wrong-retry-target', {
      launchId: 'TEST-run',
      memberId: 'B',
      originalCommandId: 'TEST-native-retry',
    }),
    /conflict|forbidden/
  );
  const stored = f.store.read<{
    retries: { native: { actor: { principalId: string; inputAuthority: string } } }[];
  }>(`launches/${digest('TEST-run')}.json`)!;
  assert.equal(stored.retries[0]!.native.actor.principalId, 'native-L');
  assert.equal(stored.retries[0]!.native.actor.inputAuthority, f.source.fingerprint);
});

test('a later valid DO input with unchanged native principal/grant cannot adopt or execute earlier prepared action', async (t) => {
  const f = await fixture(t),
    request = f.request('TEST-native-old-input');
  await f.call('prepare', request.commandId, request.body);
  f.human.execute({
    commandId: 'TEST-next-do',
    operation: 'message.send',
    payload: { to: 'leader', text: 'TEST later DO', actionMode: 'do' },
  });
  f.runtimeStore.fenced(f.lead.binding, (tx) => {
    const r = tx.get()!;
    r.inputs[0]!.phase = 'terminal';
    r.inputs[0]!.terminal = 'succeeded';
    tx.put(r);
  });
  const next = f.human.pendingDeliveries().find((r) => r.commandId === 'TEST-next-do')!;
  await f.runtime.admitDelivery(next);
  await f.runtime.dispatchNext(f.lead.binding);
  const source = captureNativeInputAuthority({
    binding: f.lead.binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config: f.lead.config,
    readRuntime: () => f.runtime.readSession(f.lead.binding),
    captureTeam: (raw) => f.owner.captureNativeMcpAuthority('native-L', f.lead.binding, raw, true),
    assertCurrent() {},
  });
  await assert.rejects(
    executeNativeMemberAction(
      {
        team: f.team,
        launch: f.launch,
        entries: f.entries,
        runtime: f.runtime,
        source,
        assertCurrent() {},
        isSealed: () => false,
      },
      'execute',
      request.commandId,
      request.body
    ),
    /forbidden/
  );
  assert.equal(f.drivers.get('A:1')!.closed, 0);
  assert.equal(f.opened.length, 3);
});

test('native lead skip closes only selected ordinary member and never allocates a new generation', async (t) => {
  const f = await fixture(t),
    r = f.request('TEST-native-skip', 'skip');
  await f.call('prepare', r.commandId, r.body);
  const result = await f.call('execute', r.commandId, r.body);
  assert.equal(field(result, 'stage'), 'selected');
  assert.deepEqual(f.opened, ['L:1', 'A:1', 'B:1']);
  assert.equal(f.drivers.get('A:1')!.closed, 1);
  assert.equal(f.drivers.get('L:1')!.closed, 0);
  assert.equal(f.drivers.get('B:1')!.closed, 0);
  assert.equal(JSON.stringify(result).includes('native-L'), false);
});

test('actual ordinary native member with DO cannot borrow lead cross-member control', async (t) => {
  const f = await fixture(t),
    r = f.request('TEST-member-not-lead');
  f.human.execute({
    commandId: 'TEST-bob-do',
    operation: 'message.send',
    payload: { to: 'bob', text: 'TEST member DO', actionMode: 'do' },
  });
  const entry = [...f.entries.values()].find((e) => e.binding.memberId === 'B')!;
  const raw = f.human.pendingDeliveries().find((row) => row.commandId === 'TEST-bob-do')!;
  await f.runtime.admitDelivery(raw);
  await f.runtime.dispatchNext(entry.binding);
  const source = captureNativeInputAuthority({
    binding: entry.binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config: entry.config,
    readRuntime: () => f.runtime.readSession(entry.binding),
    captureTeam: (input) =>
      f.owner.captureNativeMcpAuthority('native-B', entry.binding, input, false),
    assertCurrent() {},
  });
  await assert.rejects(
    executeNativeMemberAction(
      {
        team: f.team,
        launch: f.launch,
        entries: f.entries,
        runtime: f.runtime,
        source,
        assertCurrent() {},
        isSealed: () => false,
      },
      'prepare',
      r.commandId,
      r.body
    ),
    /forbidden/
  );
  assert.equal(f.drivers.get('A:1')!.closed, 0);
  assert.equal(f.opened.length, 3);
});

test('committed native successor owns its new input after initiating DO ends; old callback cannot follow a replacement or revoked target grant', async (t) => {
  const f = await fixture(t),
    request = f.request('TEST-native-lifetime');
  const originalCallback = f.providerAuthorities.get('A:1')!;
  await f.call('prepare', request.commandId, request.body);
  await f.call('execute', request.commandId, request.body);
  const target = [...f.entries.values()].find((e) => e.binding.memberId === 'A')!;
  const authority = f.providerAuthorities.get('A:2')!;
  assert.equal(authority.canAllocate(), true);
  assert.equal(
    originalCallback.canAllocate(),
    false,
    'Old native callback cannot follow mutated entry into successor'
  );
  await f.nextAsk();
  assert.throws(f.source.assertCurrent, /forbidden|hold/);
  assert.equal(
    authority.canAllocate(),
    true,
    'Committed target does not borrow initiating lead DO lifetime'
  );
  f.human.execute({
    commandId: 'TEST-target-own-DO',
    operation: 'message.send',
    payload: { to: 'alice', text: 'Original target input', actionMode: 'do' },
  });
  const raw = f.human.pendingDeliveries().find((row) => row.commandId === 'TEST-target-own-DO')!;
  await f.runtime.admitDelivery(raw);
  await f.runtime.dispatchNext(target.binding);
  const source = captureNativeInputAuthority({
    binding: target.binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config: target.config,
    readRuntime: () => f.runtime.readCapturedSession(target.binding),
    captureTeam: (intent) =>
      f.owner.captureNativeMcpAuthority('native-A', target.delivery, intent, false),
    assertCurrent: authority.assertCurrent,
  });
  source.assertCurrent();
  assert.equal(source.team.principalId, 'native-A');
  assert.notEqual(source.fingerprint, f.source.fingerprint);
  const originalProfile = structuredClone(target.profile);
  target.profile.accountBinding = 'TEST-different-account';
  assert.equal(authority.canAllocate(), false);
  target.profile = originalProfile;
  assert.equal(authority.canAllocate(), true);
  f.human.revoke('native-A');
  assert.equal(authority.canAllocate(), false);
  assert.throws(source.assertCurrent, /forbidden|hold/);
  assert.equal(f.drivers.get('B:1')!.closed, 0);
});

test('source grant lost inside native open before allocation commit cannot grant target lifetime', async (t) => {
  const f = await fixture(t),
    request = f.request('TEST-native-precommit');
  f.setBeforeOpen(async (entry) => {
    if (entry.binding.memberId !== 'A') return;
    assert.equal(f.runtime.readCapturedSession(entry.binding).record?.phase, 'opening');
    f.human.revoke('native-L');
    assert.equal(f.providerAuthorities.get('A:2')!.canAllocate(), false);
    assert.throws(f.providerAuthorities.get('A:2')!.assertAllocatedCurrent, /hold/);
  });
  await f.call('prepare', request.commandId, request.body);
  await assert.rejects(f.call('execute', request.commandId, request.body), /forbidden|hold/);
  assert.equal(f.opened.length, 3);
  assert.equal(f.drivers.get('B:1')!.closed, 0);
});

test('process registration checks its own original Runtime input outside Team fence and physical root capture inside; no terminal-input recapture', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find((e) => e.binding.memberId === 'A')!;
  const authority = f.providerAuthorities.get('A:1')!;
  await f.nextAsk(); // Initiating lead no longer has a DO; target owns independent authorization.
  f.human.execute({
    commandId: 'TEST-process-own-DO',
    operation: 'message.send',
    payload: { to: 'alice', text: 'Register original owned service', actionMode: 'do' },
  });
  const raw = f.human.pendingDeliveries().find((row) => row.commandId === 'TEST-process-own-DO')!;
  await f.runtime.admitDelivery(raw);
  await f.runtime.dispatchNext(entry.binding);
  let captures = 0;
  let captureFailure: Error | undefined;
  entry.provider = {
    factory: {
      async open() {
        throw new Error('TEST-no-allocation');
      },
    },
    isReady: authority.isCurrent,
    seal() {},
    async cleanup() {
      return true;
    },
    captureRegisteredProcess(pid, registrar) {
      // Actual authority callback is Team-only here; nesting a Runtime read deadlocks this real file fence.
      authority.assertCurrent();
      captures++;
      if (captureFailure) throw captureFailure;
      return {
        version: 1,
        registrar,
        root: {
          auditToken: [501, 501, 20, 501, 20, 1000, 100, 2],
          sessionId: 1000,
          bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          osBuild: '24G90',
        },
        target: {
          auditToken: [501, 501, 20, 501, 20, pid, 100, 3],
          sessionId: 1000,
          bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          osBuild: '24G90',
        },
      };
    },
  };
  const { createMemberProcessMcpPort } =
    await import('../dist/composition/createMemberProcessMcpPort.js');
  const port = createMemberProcessMcpPort({
    entry,
    assertCurrent: authority.assertCurrent,
    assertAllocatedCurrent: authority.assertAllocatedCurrent,
    captureSource: () =>
      captureNativeInputAuthority({
        binding: entry.binding,
        profileId: 'TEST-profile',
        hostIncarnation: 'TEST-host',
        config: entry.config,
        readRuntime: () => f.runtime.readCapturedSession(entry.binding),
        captureTeam: (original) =>
          f.owner.captureNativeMcpAuthority('native-A', entry.delivery, original, false),
        assertCurrent: authority.assertCurrent,
      }),
    native: {
      observe: () => 'same-live',
      signal: () => {
        throw new Error('TEST-no-signals');
      },
    },
  });
  captureFailure = new Error('process:hold');
  assert.throws(
    () => port.register('TEST-process-refused-capture', { pid: 1001, label: 'TEST-unproven' }),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
  assert.equal(port.lookup('TEST-process-refused-capture'), null);
  assert.deepEqual(port.list(), [], 'Unproven capture cannot publish a process row');
  const unexpected = new Error('TEST-private-adapter-failure');
  captureFailure = unexpected;
  assert.throws(
    () => port.register('TEST-process-unexpected-capture', { pid: 1001, label: 'TEST-unproven' }),
    (error) => error === unexpected,
    'Unknown adapter failures are not recast as an expected HOLD'
  );
  assert.equal(port.lookup('TEST-process-unexpected-capture'), null);
  assert.deepEqual(port.list(), []);
  captureFailure = undefined;
  const refusedCaptures = captures;
  const receipt = port.register('TEST-process-own-register', { pid: 1001, label: 'TEST-owned' });
  assert.equal(receipt.principalId, 'native-A');
  assert.equal(receipt.capture?.registrar.generation, entry.binding.generation);
  assert.equal(captures, refusedCaptures + 1);
  port.register('TEST-process-own-register', { pid: 1001, label: 'TEST-owned' });
  assert.equal(captures, refusedCaptures + 1, 'Same original command only looks up the retained receipt');
  f.runtimeStore.fenced(entry.binding, (tx) => {
    const record = tx.get()!;
    record.inputs[0]!.phase = 'terminal';
    record.inputs[0]!.terminal = 'succeeded';
    tx.put(record);
  });
  assert.throws(
    () => port.register('TEST-terminal-new-register', { pid: 1002, label: 'TEST-refused' }),
    /hold|forbidden/
  );
  assert.equal(captures, refusedCaptures + 1);
  assert.equal(port.lookup('TEST-process-own-register')?.commandId, 'TEST-process-own-register');
});
