import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { runtimeDigest as digest } from '../dist/runtime/identity.js';
import type { Session, Event } from '@agent-teams/provider-session-contracts';
import type { ExpectedLaunchMember, LaunchAttempt } from '../dist/team-launch/contracts.js';
import {
  createLaunchMemberActions,
  validateMemberSelectionChain,
} from '../dist/team-launch/memberActions.js';
import type { ActionLaunchRecord, MemberActionInput } from '../dist/team-launch/memberActions.js';
import { FileTeamRuntimeBindings } from '../dist/adapters/team/FileTeamRuntimeBindings.js';
import { executeUnconfiguredSkip } from '../dist/composition/executeUnconfiguredSkip.js';
import { applyUnconfiguredMemberSelections } from '../dist/team-launch/applyUnconfiguredMemberSelections.js';
import { transitionRuntimeMember } from '../dist/composition/transitionRuntimeMember.js';

async function run(target: Parameters<typeof transitionRuntimeMember>[0]) {
  target.assertOriginalAuthority();
  if (target.input.action === 'restart') target.assertNewWorkAllowed();
  if (!target.actions.lookup(target.input.commandId))
    target.actions.prepare(target.input, target.selected);
  return transitionRuntimeMember(target);
}
class Driver implements Session {
  sessionRef: string;
  closed = 0;
  confirmed = true;
  release: (() => void) | undefined;
  private ended = false;
  private waiter: ((r: IteratorResult<Event>) => void) | undefined;
  constructor(id: string) {
    this.sessionRef = `TEST-${id}`;
  }
  submit: Session['submit'] = async () => ({ ok: false, code: 'unsupported' });
  interrupt: Session['interrupt'] = async () => ({
    ok: false,
    code: 'unsupported',
  });
  respondToInteraction: Session['respondToInteraction'] = async () => ({
    ok: false,
    code: 'unsupported',
  });
  checkpoint: Session['checkpoint'] = () => ({
    ok: false,
    code: 'unsupported',
  });
  checkReadiness: Session['checkReadiness'] = async () => ({
    ok: true,
    value: undefined,
  });
  observe = (): AsyncIterable<Event> => ({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        this.ended
          ? Promise.resolve({ done: true, value: undefined })
          : new Promise((done) => {
              this.waiter = done;
            }),
    }),
  });
  close: Session['close'] = async () => {
    this.closed++;
    if (this.release)
      await new Promise<void>((done) => {
        this.release = done;
      });
    this.ended = true;
    this.waiter?.({ done: true, value: undefined });
    return {
      logicallyClosed: true,
      cleanup: this.confirmed ? 'confirmed' : 'unknown',
    };
  };
}
const initial = (member: ExpectedLaunchMember, attemptId: string): LaunchAttempt => ({
  attemptId,
  hostIncarnation: 'TEST-host',
  startedAtMs: 0,
  deadlineMs: 0,
  claimed: false,
  status: member.skipped ? 'skipped' : 'not-started',
  reason: 'TEST',
  nativeReady: false,
  contextApplied: false,
  everReady: false,
  usable: false,
  controlAvailable: false,
  noAllocation: false,
});
async function setup(openA = true, unconfigured = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-member-transition-')));
  const runtimeStore = new FileRuntimeStore(root),
    teamStore = new TeamOwnerStore(root, 'test-team');
  const drivers: Driver[] = [],
    opened: string[] = [];
  const runtime = new RuntimeOwner({
    store: runtimeStore,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    authorize: () => true,
    canDispatch: () => true,
    driverFactory: {
      async open(config) {
        const driver = new Driver(config.sessionId);
        drivers.push(driver);
        opened.push(`${config.sessionId}:${config.generation}`);
        return { driver, capabilities: ['tools'] };
      },
    },
  });
  const members: ExpectedLaunchMember[] = ['A', 'B'].map((memberId) => ({
    memberId,
    binding: {
      backendId: 'TEST-backend',
      teamId: 'TEST-team',
      runId: 'TEST-run',
      memberId,
      generation: 'original-1',
    },
    runtimeGeneration: 1,
    configurationDigest: digest({ memberId, generation: 1 }),
    baseConfigurationDigest: digest({ memberId, base: true }),
    contextDigest: digest({ memberId, context: true }),
    configRevision: 'TEST-config',
    skipped: false,
    timeoutMs: 10000,
  }));
  if (unconfigured) {
    const a = members[0]!;
    a.binding = null;
    a.configurationDigest = null;
    a.contextDigest = null;
    a.configRevision = null;
    delete a.runtimeGeneration;
    delete a.baseConfigurationDigest;
  }
  const definition = {
    launchId: 'TEST-run',
    rosterRevision: 'TEST-roster',
    members,
  };
  const path = 'launches/' + digest('TEST-run') + '.json';
  teamStore.write(path, {
    schemaVersion: 1,
    definition,
    fingerprint: digest(definition),
    members: members.map((m) => ({
      memberId: m.memberId,
      currentAttemptId: 'initial',
      attempts: [initial(m, 'initial')],
    })),
    retries: [],
  });
  const read = () => structuredClone(teamStore.read<ActionLaunchRecord>(path)!);
  let actorRevision = 1,
    inputAuthority: string | undefined;
  const actions = createLaunchMemberActions({
    authorized: (_action, fn) => teamStore.fenced(fn),
    observe: (memberId) => {
      const binding = read().definition.members.find((m) => m.memberId === memberId)!.binding;
      return binding
        ? ((state) => ({
            ...(state.record ? { record: state.record } : {}),
            attached: state.attached,
            nativeReady: false,
          }))(runtime.readSession(binding))
        : { attached: false, nativeReady: false };
    },
    captureActor: () => ({
      principalId: 'TEST-human',
      authorityRevision: actorRevision,
      ...(inputAuthority ? { inputAuthority } : {}),
    }),
    read,
    write: (r) => teamStore.write(path, r),
    initial,
  });
  for (const member of members.filter((m) => m.memberId !== 'A' || (openA && !unconfigured)))
    await runtime.openSession({
      binding: member.binding!,
      config: {
        tenantId: 'TEST',
        projectId: 'TEST',
        sessionId: member.memberId,
        generation: 1,
        configRevision: 'TEST-config',
        requiredCapabilities: ['tools'],
      },
    });
  await runtime.admitDelivery({
    binding: members[1]!.binding!,
    deliveryId: 'TEST-peer-queued',
    inputId: 'TEST-peer-queued',
    messageId: 'TEST-peer-message',
    content: 'Keep peer queue unchanged',
  });
  let installed = 0,
    started = 0,
    retired = 0,
    workAllowed = true,
    authority = true;
  const target = (action: 'restart' | 'skip', commandId = 'TEST-action') => {
    const source = read().definition.members[0]!;
    const input: MemberActionInput = {
      commandId,
      launchId: 'TEST-run',
      rosterRevision: read().definition.rosterRevision,
      memberId: 'A',
      expectedGeneration: source.binding!.generation,
      action,
    };
    const selected: ExpectedLaunchMember =
      action === 'skip'
        ? { ...source, skipped: true }
        : {
            ...source,
            binding: {
              ...source.binding!,
              generation: `restart-${digest({ commandId, sourceBinding: source.binding })}`,
            },
            runtimeGeneration: source.runtimeGeneration! + 1,
            configurationDigest: digest({
              memberId: 'A',
              generation: source.runtimeGeneration! + 1,
            }),
            skipped: false,
          };
    delete selected.restore;
    return {
      input,
      selected,
      sourceBinding: source.binding!,
      actions,
      runtime,
      assertOriginalAuthority() {
        if (!authority) throw new Error('TEST-revoked');
      },
      assertNewWorkAllowed() {
        if (!workAllowed) throw new Error('TEST-trashed');
      },
      async retireOriginal() {
        retired++;
        return true;
      },
      installSelected() {
        installed++;
      },
      startSelected() {
        started++;
        return runtime
          .openFreshMemberSession(
            {
              sourceBinding: source.binding!,
              binding: selected.binding!,
              config: {
                tenantId: 'TEST',
                projectId: 'TEST',
                sessionId: 'A',
                generation: selected.runtimeGeneration!,
                configRevision: 'TEST-config',
                requiredCapabilities: ['tools'],
              },
            },
            () => {}
          )
          .then(() => {});
      },
    };
  };
  return {
    root,
    teamStore,
    changeInput: (id: string) => {
      inputAuthority = digest(id);
    },
    changeActor: () => {
      actorRevision++;
    },
    runtime,
    runtimeStore,
    drivers,
    opened,
    read,
    actions,
    target,
    counts: () => ({ installed, started, retired }),
    trash: () => {
      workAllowed = false;
    },
    revoke: () => {
      authority = false;
    },
  };
}
test('actual Runtime stops exactly A before fresh A generation; B native and admitted queue bytes survive; cold original lookup cannot replay', async () => {
  const f = await setup(),
    target = f.target('restart');
  const peerBefore = f.runtime.readSession(f.read().definition.members[1]!.binding!);
  const peerBytes = JSON.stringify(peerBefore.record);
  const receipt = await run(target);
  assert.equal(receipt?.phase, 'selected');
  assert.equal(f.drivers[0]!.closed, 1);
  assert.equal(f.drivers[1]!.closed, 0);
  assert.equal(f.runtime.readSession(target.sourceBinding).record?.custody, 'released');
  assert.equal(f.runtime.readSession(target.sourceBinding).attached, false);
  assert.equal(f.runtime.readSession(target.selected.binding!).record?.phase, 'allocated');
  assert.equal(
    JSON.stringify(f.runtime.readSession(f.read().definition.members[1]!.binding!).record),
    peerBytes
  );
  assert.deepEqual(f.opened, ['A:1', 'B:1', 'A:2']);
  assert.deepEqual(f.counts(), { installed: 1, started: 1, retired: 1 });
  validateMemberSelectionChain(f.read());
  assert.deepEqual(await run(target), receipt);
  assert.deepEqual(f.counts(), { installed: 1, started: 1, retired: 1 });
});
test('unconfirmed original cleanup retains requested intent; cold repeated original cannot stop/open again or select peer', async () => {
  const f = await setup(),
    target = f.target('restart');
  f.drivers[0]!.confirmed = false;
  await assert.rejects(run(target), /Runtime/);
  assert.equal(f.actions.lookup(target.input.commandId)?.phase, 'requested');
  assert.equal(f.runtime.readSession(target.sourceBinding).record?.custody, 'unknown');
  await run(target);
  assert.equal(f.drivers[0]!.closed, 1);
  assert.equal(f.drivers[1]!.closed, 0);
  assert.deepEqual(f.counts(), { installed: 0, started: 0, retired: 0 });
  assert.equal(f.read().definition.members[0]!.binding!.generation, 'original-1');
});
test('skip requires original stop closure and no fresh native; trashed owner cannot begin replacement', async () => {
  const f = await setup(),
    skip = f.target('skip');
  await run(skip);
  assert.equal(f.read().definition.members[0]!.skipped, true);
  assert.deepEqual(f.counts(), { installed: 1, started: 0, retired: 1 });
  assert.equal(f.drivers[1]!.closed, 0);
  const g = await setup();
  g.trash();
  await assert.rejects(run(g.target('restart')), /trashed/);
  assert.equal(g.drivers[0]!.closed, 0);
  assert.equal(g.actions.lookup('TEST-action'), null);
});

test('cold exact binding projection accepts only the recorded fresh successor and retains original read identity', async () => {
  const f = await setup(),
    target = f.target('restart');
  await run(target);
  const store = new TeamOwnerStore(f.root, 'test-team');
  const cold = new FileTeamRuntimeBindings(store);
  const selected = cold.current(target.sourceBinding);
  assert.equal(selected?.binding.generation, target.selected.binding!.generation);
  assert.equal(selected?.generation, 2);
  assert.equal(cold.retained(target.sourceBinding, target.sourceBinding), true);
});

test('selected restart→skip→restart chain stays cold-readable, and a forked or corrupted original command refuses', async () => {
  const f = await setup();
  await run(f.target('restart', 'TEST-first'));
  await run(f.target('skip', 'TEST-skip'));
  await run(f.target('restart', 'TEST-second'));
  const store = new TeamOwnerStore(f.root, 'test-team'),
    cold = new FileTeamRuntimeBindings(store);
  const current = f.read().definition.members[0]!;
  assert.equal(cold.current(current.binding!)?.generation, 3);
  validateMemberSelectionChain(f.read());
  const good = f.read();
  const forked = structuredClone(good),
    fork = structuredClone(forked.memberActions![0]!);
  fork.input.commandId = 'TEST-fork';
  fork.selected.binding!.generation = `restart-${digest({ commandId: fork.input.commandId, sourceBinding: fork.source.binding })}`;
  fork.fingerprint = digest({
    input: fork.input,
    actor: fork.actor,
    noAllocation: fork.noAllocation,
    sourceAttemptId: fork.sourceAttemptId,
    source: fork.source,
    selected: fork.selected,
  });
  forked.memberActions!.push(fork);
  store.write('launches/' + digest('TEST-run') + '.json', forked);
  assert.throws(() => cold.current(current.binding!), /hold/);
  const record = good;
  record.memberActions![0]!.fingerprint = '0'.repeat(64);
  store.write('launches/' + digest('TEST-run') + '.json', record);
  assert.throws(() => cold.current(current.binding!), /hold/);
});

test('lost prepare ACK repeats only SDK-free prepare; changed original actor refuses before native request', async () => {
  const f = await setup(),
    t = f.target('restart');
  const first = f.actions.prepare(t.input, t.selected);
  assert.equal(first.record.phase, 'prepared');
  assert.deepEqual(f.actions.prepare(t.input, t.selected).record, first.record);
  assert.equal(f.drivers[0]!.closed, 0);
  f.changeActor();
  const result = await transitionRuntimeMember(t);
  assert.equal(result?.phase, 'refused');
  assert.equal(f.drivers[0]!.closed, 0);
  assert.equal(f.opened.length, 2);
});
test('proven unallocated configured skip has no Stop/open and records allocation absence separately from closure', async () => {
  const f = await setup(false),
    t = f.target('skip');
  await run(t);
  const row = f.actions.lookup(t.input.commandId)!;
  assert.equal(row.noAllocation, true);
  assert.equal(row.phase, 'selected');
  assert.equal(f.runtime.readSession(t.sourceBinding).record, undefined);
  assert.equal(f.counts().retired, 0);
  assert.equal(f.counts().started, 0);
  assert.deepEqual(f.opened, ['B:1']);
});
test('unconfigured null-binding skip is owner-only and reconstructs cold without invented Runtime closure', async () => {
  const f = await setup(false, true),
    source = f.read().definition.members[0]!;
  const input: MemberActionInput = {
    commandId: 'TEST-unconfigured',
    launchId: 'TEST-run',
    rosterRevision: 'TEST-roster',
    memberId: 'A',
    expectedGeneration: null,
    action: 'skip',
  };
  let installed = 0;
  const options = {
    actions: f.actions,
    assertCurrent() {},
    installSkipped() {
      installed++;
    },
  };
  assert.equal(executeUnconfiguredSkip(options, 'prepare', input)?.phase, 'prepared');
  assert.equal(executeUnconfiguredSkip(options, 'execute', input)?.phase, 'selected');
  assert.equal(installed, 1);
  assert.deepEqual(f.opened, ['B:1']);
  assert.equal(f.drivers[0]!.closed, 0);
  const record = f.read();
  assert.equal(record.definition.members[0]!.binding, null);
  const definition = {
    ...record.definition,
    members: [source, record.definition.members[1]!],
  };
  const cold = applyUnconfiguredMemberSelections(definition, record);
  assert.equal(cold.members[0]!.skipped, true);
  assert.equal(cold.members[0]!.binding, null);
  assert.equal(executeUnconfiguredSkip(options, 'execute', input)?.phase, 'selected');
  assert.equal(installed, 1);
  assert.throws(
    () =>
      applyUnconfiguredMemberSelections(
        {
          ...definition,
          members: [{ ...source, timeoutMs: 1 }, definition.members[1]!],
        },
        record
      ),
    (error: unknown) =>
      !!error && typeof error === 'object' && 'code' in error && error.code === 'hold'
  );
});

test('unallocated skip seals only actual unopened metadata and cancels its queued work without any driver close', async () => {
  const f = await setup(false),
    t = f.target('skip');
  await f.runtime.admitDelivery({
    binding: t.sourceBinding,
    deliveryId: 'TEST-A-queued',
    inputId: 'TEST-A-queued',
    messageId: 'TEST-A-message',
    content: 'Never dispatch this skipped input',
  });
  assert.equal(f.runtime.readSession(t.sourceBinding).record?.phase, 'unopened');
  await run(t);
  const stopped = f.runtime.readSession(t.sourceBinding);
  assert.equal(stopped.record?.phase, 'closed');
  assert.equal(stopped.record?.custody, 'released');
  assert.equal(stopped.attached, false);
  assert.equal(stopped.record?.inputs[0]?.phase, 'cancelled');
  assert.equal(f.drivers[0]!.closed, 0);
  assert.deepEqual(f.opened, ['B:1']);
});

test('actual TeamLaunchOwner requested marker blocks concurrent original start claim and cold no-allocation selection remains skipped', async () => {
  const f = await setup(false, true),
    definition = structuredClone(f.read().definition);
  let opens = 0;
  const make = (selected: typeof definition) =>
    new TeamLaunchOwner({
      definition: selected,
      store: f.teamStore,
      hostIncarnation: 'TEST-host',
      authorized: (_action, fn) => f.teamStore.fenced(() => fn()),
      captureActor: () => ({ principalId: 'TEST-human', authorityRevision: 1 }),
      runtime: {
        read: () => ({ attached: false, nativeReady: false }),
        async open() {
          opens++;
        },
      },
    });
  const owner = make(definition),
    actions = owner.memberActions(),
    source = actions.source('A');
  const input: MemberActionInput = {
    commandId: 'TEST-owner-skip',
    launchId: definition.launchId,
    rosterRevision: definition.rosterRevision,
    memberId: 'A',
    expectedGeneration: null,
    action: 'skip',
  };
  actions.prepare(input, { ...source, skipped: true });
  actions.request(input.commandId);
  assert.throws(
    () => owner.startMember('A'),
    (error: unknown) =>
      !!error && typeof error === 'object' && 'code' in error && error.code === 'hold'
  );
  assert.equal(opens, 0);
  actions.unallocated(input.commandId);
  actions.publish(input.commandId);
  const cold = make(applyUnconfiguredMemberSelections(definition, f.read()));
  assert.equal(cold.read().members.find((m) => m.memberId === 'A')!.attempt.status, 'skipped');
  assert.equal(cold.startMember('A'), undefined);
  assert.equal(opens, 0);
});

test('existing technical retry keeps same binding, stores exact original receipt and cold lookup after lost ACK never opens again', async () => {
  const f = await setup(false),
    definition = structuredClone(f.read().definition),
    binding = definition.members[0]!.binding!;
  let tries = 0;
  const make = () =>
    new TeamLaunchOwner({
      definition,
      store: f.teamStore,
      hostIncarnation: 'TEST-host',
      authorized: (_action, fn) => f.teamStore.fenced(fn),
      runtime: {
        read: (memberId) => {
          const b = definition.members.find((m) => m.memberId === memberId)!.binding!;
          const state = f.runtime.readSession(b);
          return {
            ...(state.record ? { record: state.record } : {}),
            attached: state.attached,
            nativeReady: false,
          };
        },
        async open() {
          tries++;
          await f.runtime.openSession({
            binding,
            config: {
              tenantId: 'TEST',
              projectId: 'TEST',
              sessionId: 'A',
              generation: -1,
              configRevision: 'TEST-config',
              requiredCapabilities: ['tools'],
            },
          });
        },
      },
    });
  const owner = make();
  await owner.startMember('A');
  const failed = owner.read().members.find((m) => m.memberId === 'A')!;
  assert.equal(failed.attempt.noAllocation, true);
  assert.equal(failed.attempt.status, 'failed');
  const original = {
    commandId: 'TEST-retry-original',
    launchId: definition.launchId,
    rosterRevision: definition.rosterRevision,
    attemptId: 'TEST-retry-attempt',
    memberIds: ['A'],
  };
  owner.retry(original);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(tries, 2);
  assert.deepEqual(f.opened, ['B:1']);
  const cold = make(),
    row = cold
      .memberActions()
      .read('A')
      .retries.find((r) => r.commandId === original.commandId)!;
  assert.deepEqual(row, {
    commandId: original.commandId,
    attemptId: original.attemptId,
    current: true,
  });
  cold.retry(original);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(tries, 2);
  assert.equal(
    cold.read().members.find((m) => m.memberId === 'A')!.binding!.generation,
    binding.generation
  );
});

test('lifecycle debt appearing after original cleanup blocks fresh publication/open, retaining original receipt and peer', async () => {
  const f = await setup(),
    t = f.target('restart', 'TEST-trash-during-cleanup');
  const retire = t.retireOriginal;
  t.retireOriginal = async () => {
    const result = await retire();
    f.trash();
    return result;
  };
  await assert.rejects(run(t), /trashed/);
  assert.equal(f.actions.lookup(t.input.commandId)?.phase, 'requested');
  assert.equal(f.read().definition.members[0]!.binding!.generation, 'original-1');
  assert.equal(f.runtime.readSession(t.sourceBinding).record?.custody, 'released');
  assert.equal(f.drivers[1]!.closed, 0);
  assert.equal(f.opened.length, 2);
});

test('private native preparation binds original input authority; a later DO with unchanged principal/grant cannot execute it', async () => {
  const f = await setup(),
    t = f.target('restart', 'TEST-native-intent');
  f.changeInput('TEST-original-DO');
  f.actions.prepare(t.input, t.selected);
  f.changeInput('TEST-later-DO');
  assert.equal((await transitionRuntimeMember(t))?.phase, 'refused');
  assert.equal(f.drivers[0]!.closed, 0);
  assert.equal(f.opened.length, 2);
});

test('explicit fresh generation preserves UNKNOWN original handoff after confirmed closure; no old input/outbox replay', async () => {
  const f = await setup(),
    t = f.target('restart', 'TEST-unknown-old-result');
  let submits = 0;
  f.drivers[0]!.submit = async () => {
    submits++;
    throw new Error('TEST-unknown-tool-result');
  };
  const original = {
    binding: t.sourceBinding,
    deliveryId: 'TEST-old-input',
    inputId: 'TEST-old-input',
    messageId: 'TEST-old-message',
    content: 'Retain original uncertain effect',
  };
  await f.runtime.admitDelivery(original);
  await f.runtime.dispatchNext(t.sourceBinding);
  const before = f.runtime.readSession(t.sourceBinding).record!.inputs[0]!;
  assert.equal(before.phase, 'unknown');
  await f.runtime.stopSession(t.sourceBinding);
  await assert.rejects(
    f.runtime.openSession({
      binding: { ...t.sourceBinding, generation: 'TEST-ordinary-successor' },
      config: {
        tenantId: 'TEST',
        projectId: 'TEST',
        sessionId: 'A',
        generation: 2,
        configRevision: 'TEST-config',
        requiredCapabilities: ['tools'],
      },
    }),
    (error) => !!error && typeof error === 'object' && 'code' in error && error.code === 'hold'
  );
  assert.deepEqual(f.opened, ['A:1', 'B:1']);
  await run(t);
  const old = f.runtime.readSession(t.sourceBinding),
    fresh = f.runtime.readSession(t.selected.binding!);
  assert.equal(old.record?.phase, 'closed');
  assert.equal(old.record?.custody, 'released');
  assert.equal(old.attached, false);
  assert.deepEqual(old.record!.inputs[0], before);
  assert.equal(fresh.record?.phase, 'allocated');
  assert.equal(fresh.record!.inputs.length, 0);
  assert.equal(submits, 1);
  assert.equal(f.drivers[1]!.closed, 0);
  await run(t);
  assert.equal(submits, 1);
  assert.deepEqual(f.opened, ['A:1', 'B:1', 'A:2']);
});

test('cold selected-but-unclaimed restart requires its original command before opening; generic start cannot replay the effect', async () => {
  const f = await setup(),
    t = f.target('restart', 'TEST-cold-published');
  t.startSelected = async () => {};
  await run(t);
  const definition = structuredClone(f.read().definition);
  let opens = 0;
  const cold = new TeamLaunchOwner({
    definition,
    store: f.teamStore,
    hostIncarnation: 'TEST-cold-host',
    authorized: (_action, fn) => f.teamStore.fenced(fn),
    captureActor: () => ({ principalId: 'TEST-human', authorityRevision: 1 }),
    runtime: {
      captureAuthority: () => () => {},
      read(memberId) {
        const state = f.runtime.readSession(
          definition.members.find((m) => m.memberId === memberId)!.binding!
        );
        return {
          ...(state.record ? { record: state.record } : {}),
          attached: state.attached,
          nativeReady: false,
        };
      },
      async open(memberId, assertAuthority) {
        opens++;
        const binding = definition.members.find((m) => m.memberId === memberId)!.binding!;
        await f.runtime.openFreshMemberSession(
          {
            sourceBinding: cold.readFreshMemberSource(binding)!,
            binding,
            config: {
              tenantId: 'TEST',
              projectId: 'TEST',
              sessionId: 'A',
              generation: 2,
              configRevision: 'TEST-config',
              requiredCapabilities: ['tools'],
            },
          },
          assertAuthority!
        );
      },
    },
  });
  assert.deepEqual(cold.readFreshMemberSource(t.selected.binding!), t.sourceBinding);
  assert.throws(
    () => cold.startMember('A'),
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'reason' in error &&
      error.reason === 'member-action-original-required'
  );
  assert.throws(
    () => cold.startMember('A', () => {}, 'TEST-other-intent'),
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'reason' in error &&
      error.reason === 'member-action-original-required'
  );
  assert.equal(opens, 0);
  assert.deepEqual(f.opened, ['A:1', 'B:1']);
  await cold.startMember('A', () => {}, t.input.commandId);
  assert.equal(opens, 1);
  assert.deepEqual(f.opened, ['A:1', 'B:1', 'A:2']);
  assert.equal(
    cold.startMember('A', () => {}, t.input.commandId),
    undefined
  );
  assert.equal(opens, 1);
});
