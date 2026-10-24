import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import { initialContextDigest } from '../dist/team-launch/context.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { launchPreparationFingerprint } from '../dist/team-launch/launchPreparation.js';
import type { TeamLaunchDefinition, TeamLaunchRecord, NativeContextEvidence } from '../dist/team-launch/contracts.js';
import type { RuntimeBinding } from '../dist/runtime/contracts.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const binding = (memberId: string): RuntimeBinding => ({
  backendId: 'TEST-backend',
  teamId: 'TEST-team',
  runId: 'TEST-run',
  memberId,
  generation: 'generation-1',
});
const instructions = (id: string): string => `TEST role ${id}; team TEST-team; workspace TEST-only`;
class ControlledSession implements Session {
  readonly sessionRef: string;
  readonly submits: Input[] = [];
  readonly installedInstructions: string;
  private queue: Event[] = [];
  private waiter: ((result: IteratorResult<Event>) => void) | undefined;
  private ended = false;
  constructor(id: string) {
    this.sessionRef = `native-${id}`;
    this.installedInstructions = instructions(id);
  }
  emit(event: Event): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: event });
    } else this.queue.push(event);
  }
  submit: Session['submit'] = async (input) => {
    this.submits.push(input);
    return {
      ok: true,
      value: {
        inputId: input.inputId,
        operationRef: input.operationRef,
        delivery: 'client-consumed',
        providerAcceptance: 'unknown',
      },
    };
  };
  observe = (): AsyncIterable<Event> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    }),
  });
  respondToInteraction: Session['respondToInteraction'] = async () => ({
    ok: true,
    value: undefined,
  });
  interrupt: Session['interrupt'] = async () => ({
    ok: true,
    value: { requested: true, terminal: 'unconfirmed' },
  });
  checkReadiness: Session['checkReadiness'] = async () => ({ ok: true, value: undefined });
  checkpoint: Session['checkpoint'] = () => ({ ok: false, code: 'unsupported' });
  close: Session['close'] = async () => {
    this.end();
    return { logicallyClosed: true, cleanup: 'confirmed' };
  };
  end(): void {
    this.ended = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
}
async function setup(t: { after(fn: () => Promise<void>): void }, members = ['A', 'B', 'C']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-team-launch-'))),
    store = new TeamOwnerStore(root, 'TEST-team'),
    runtimeStore = new FileRuntimeStore(root),
    sessions = new Map<string, ControlledSession>(),
    opens = new Map<string, number>();
  const configured = new Set(members),
    observationFailure = new Set<string>(),
    failBeforeRuntime = new Set<string>(),
    ready = new Set(members),
    contextAccepted = new Set(members),
    proofOverride = new Map<string, NativeContextEvidence>();
  let now = Date.now(),
    authorized = true;
  const definition: TeamLaunchDefinition = {
    launchId: 'TEST-run',
    rosterRevision: 'TEST-roster-1',
    members: members.map((id) => ({
      memberId: id,
      binding: binding(id),
      configurationDigest: `config-${id}`,
      contextDigest: initialContextDigest(instructions(id)),
      configRevision: 'config-1',
      skipped: false,
      timeoutMs: 30_000,
    })),
  };
  const make = (hostIncarnation = 'host-1') => {
    const runtime = new RuntimeOwner({
      store: runtimeStore,
      profileId: 'TEST-profile',
      hostIncarnation,
      authorize: () => true,
      canDispatch: () => true,
      driverFactory: {
        open: async (request) => {
          opens.set(request.sessionId, (opens.get(request.sessionId) ?? 0) + 1);
          const session = new ControlledSession(request.sessionId);
          sessions.set(request.sessionId, session);
          return { driver: session, capabilities: ['tools'] };
        },
      },
    });
    const evidence = (id: string): NativeContextEvidence | undefined => {
      if (proofOverride.has(id)) return proofOverride.get(id);
      const session = sessions.get(id);
      return session && contextAccepted.has(id) && ready.has(id)
        ? {
            kind: 'native-configuration',
            contextDigest: initialContextDigest(session.installedInstructions),
            generation: binding(id).generation,
            configRevision: 'config-1',
          }
        : undefined;
    };
    const launch = new TeamLaunchOwner({
      definition,
      hostIncarnation,
      store,
      now: () => now,
      authorized: (_action, callback) =>
        store.fenced(() => {
          if (!authorized) throw new TeamLaunchError('forbidden', 'grant');
          return callback();
        }),
      runtime: {
        read: (id) => {
          if (observationFailure.has(id)) throw new Error('TEST observation unavailable');
          const current = runtime.readSession(binding(id)),
            proof = evidence(id);
          return {
            ...(current.record ? { record: current.record } : {}),
            attached: current.attached,
            nativeReady: ready.has(id),
            ...(proof ? { context: proof } : {}),
          };
        },
        open: async (id) => {
          if (!configured.has(id) || failBeforeRuntime.has(id))
            throw new Error('TEST preallocation unavailable');
          await runtime.openSession({
            binding: binding(id),
            config: {
              tenantId: 'TEST-tenant',
              projectId: 'TEST-project',
              sessionId: id,
              generation: 1,
              configRevision: 'config-1',
              requiredCapabilities: ['tools'],
            },
          });
        },
      },
    });
    return { launch, runtime, evidence };
  };
  t.after(async () => {
    for (const session of sessions.values()) session.end();
    await tick();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    runtimeStore,
    sessions,
    opens,
    configured,
    observationFailure,
    failBeforeRuntime,
    ready,
    contextAccepted,
    proofOverride,
    definition,
    make,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      authorized = false;
    },
  };
}
async function settle(launch: TeamLaunchOwner): Promise<void> {
  for (let count = 0; count < 4; count++) await tick();
  launch.refresh();
}

test('source launch times retain original admission across read/replay/reconstruction', async (t) => {
  const f = await setup(t, ['A']);
  const { launch } = f.make();
  assert.equal(launch.read().startedAtMs, null);
  const admitted = launch.start('TEST-original');
  assert.ok(admitted.startedAtMs !== null);
  assert.equal(admitted.observedAtMs, admitted.startedAtMs);
  await settle(launch);
  f.advance(5000);
  const replay = launch.start('TEST-original');
  assert.equal(replay.startedAtMs, admitted.startedAtMs);
  assert.equal(replay.observedAtMs, admitted.observedAtMs + 5000);
  launch.seal();
  assert.equal(f.make('next-host').launch.read().startedAtMs, admitted.startedAtMs);
});

test('ready launch retains policy-skipped members without waiting for their native allocation', async (t) => {
  const f = await setup(t, ['A', 'skipped']);
  f.definition.members[1]!.skipped = true;
  const { launch } = f.make();
  launch.start('TEST-skip');
  await settle(launch);
  const summary = launch.read();
  assert.equal(summary.status, 'ready');
  assert.equal(summary.expected, 2);
  assert.equal(summary.ready, 1);
  assert.equal(summary.members[1]!.attempt.status, 'skipped');
  assert.deepEqual([...f.opens.keys()], ['A']);
});

test('empty or entirely skipped roster never invents a ready native Team', async (t) => {
  for (const ids of [[], ['skipped']]) {
    const f = await setup(t, ids);
    for (const member of f.definition.members) member.skipped = true;
    const { launch } = f.make();
    assert.notEqual(launch.start('TEST-no-runnable').status, 'ready');
    assert.equal(f.opens.size, 0);
  }
});

test('ambiguous preparation publication allocates nothing and the original intent can continue after reconstruction', async (t) => {
  const f = await setup(t, ['A']);
  f.definition.members[0]!.baseConfigurationDigest = 'a'.repeat(64);
  f.definition.members[0]!.runtimeGeneration = 1;
  const first = f.make();
  const input = {
    commandId: 'TEST-preparation-original',
    sourceRosterRevision: first.launch.read().rosterRevision,
    members: [{ memberId: 'A', configuration: { model: 'TEST-selected' }, configurationDigest: 'b'.repeat(64), baseConfigurationDigest: 'a'.repeat(64), configRevision: 'TEST-selected-revision' }],
  };
  const write = f.store.write.bind(f.store);
  f.store.write = (name, value) => {
    write(name, value);
    if ((value as TeamLaunchRecord).preparation) throw new Error('TEST-fsync-observation-lost');
  };
  try {
    assert.throws(() => first.launch.prepare(input), /TEST-fsync-observation-lost/);
  } finally {
    f.store.write = write;
  }
  assert.equal(f.opens.size, 0, 'no factory effect follows uncertain configuration publication');
  first.launch.seal();
  const record = f.store.read<TeamLaunchRecord>(`launches/${runtimeDigest('TEST-run')}.json`)!;
  Object.assign(f.definition, record.definition);
  const recovered = f.make('host-after-publication');
  assert.equal(recovered.launch.prepare(input), false, 'original preparation is read, not republished');
  assert.throws(() => recovered.launch.start(input.commandId), /conflict/, 'dropping the prepared payload is not the same intent');
  recovered.launch.start(input.commandId, launchPreparationFingerprint(input));
  await settle(recovered.launch);
  assert.equal(f.opens.get('A'), 1);
  f.revoke();
  assert.throws(() => recovered.launch.prepare(input), /forbidden/, 'replay still requires current authority');
  recovered.launch.seal();
  await recovered.runtime.stopCapturedSession(binding('A'));
});

test('whole expected roster persists before allocation; partial launch and scoped no-allocation retry preserve healthy/pending members', async (t) => {
  const f = await setup(t);
  f.failBeforeRuntime.add('C');
  const { launch, runtime, evidence } = f.make();
  const before = launch.read();
  assert.equal(before.expected, 3);
  assert.equal(before.ready, 0);
  assert.equal(f.opens.size, 0);
  launch.start('launch-command');
  await settle(launch);
  assert.equal(launch.read().ready, 2);
  assert.equal(
    launch.read().members.find((item) => item.memberId === 'C')?.attempt.status,
    'failed'
  );
  const b = f.sessions.get('B')!;
  const delivery = {
    binding: binding('B'),
    deliveryId: 'B-bootstrap-control',
    inputId: 'B-bootstrap-control',
    messageId: 'B-message',
    content: 'TEST work after confirmed configuration',
  };
  await runtime.admitDelivery(delivery);
  await runtime.dispatchNext(binding('B'));
  const input = b.submits[0]!;
  b.emit({
    kind: 'interaction',
    sessionRef: b.sessionRef,
    inputId: input.inputId,
    operationRef: input.operationRef,
    interactionRef: 'permission-B',
    request: { kind: 'permission', tool: 'TEST-tool', input: {} },
  });
  await tick();
  launch.refresh();
  const pending = launch.read();
  assert.equal(pending.status, 'partial');
  assert.equal(
    pending.members.find((item) => item.memberId === 'B')?.attempt.status,
    'pending-human'
  );
  assert.equal(launch.canWork('A', evidence('A')), true);
  assert.equal(launch.canWork('B', evidence('B')), false);
  const bAttempt = pending.members.find((item) => item.memberId === 'B')!.attempt.attemptId;
  f.advance(60_000);
  launch.refresh();
  assert.equal(
    launch.read().members.find((item) => item.memberId === 'B')?.attempt.status,
    'pending-human'
  );
  f.failBeforeRuntime.delete('C');
  launch.retry({
    launchId: f.definition.launchId,
    rosterRevision: f.definition.rosterRevision,
    commandId: 'retry-C-command',
    attemptId: 'retry-C-attempt',
    memberIds: ['C'],
  });
  await settle(launch);
  assert.deepEqual([...f.opens.entries()].sort(), [
    ['A', 1],
    ['B', 1],
    ['C', 1],
  ]);
  assert.equal(
    launch.read().members.find((item) => item.memberId === 'B')?.attempt.attemptId,
    bAttempt
  );
  assert.equal(b.submits.length, 1);
  launch.retry({
    launchId: f.definition.launchId,
    rosterRevision: f.definition.rosterRevision,
    commandId: 'retry-C-command',
    attemptId: 'retry-C-attempt',
    memberIds: ['C'],
  });
  await settle(launch);
  assert.equal(f.opens.get('C'), 1);
  launch.start('launch-command');
  await settle(launch);
  assert.equal(f.opens.get('A'), 1);
  assert.equal(f.opens.get('B'), 1);
  assert.equal(f.opens.get('C'), 1);
  launch.seal();
});

test('native readiness without exact same-generation initial context is not usable, and scoped retry cannot erase custody debt', async (t) => {
  const f = await setup(t, ['A']);
  f.contextAccepted.delete('A');
  const { launch } = f.make();
  launch.start('launch-command');
  await settle(launch);
  let state = launch.read().members[0]!.attempt;
  assert.equal(state.nativeReady, true);
  assert.equal(state.contextApplied, false);
  assert.equal(state.usable, false);
  assert.equal(f.sessions.get('A')?.submits.length, 0);
  f.proofOverride.set('A', {
    kind: 'native-configuration',
    contextDigest: initialContextDigest(instructions('A')),
    generation: 'old-generation',
    configRevision: 'config-1',
  });
  launch.refresh();
  assert.equal(launch.read().ready, 0);
  f.advance(31_000);
  launch.refresh();
  state = launch.read().members[0]!.attempt;
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'bootstrap-timeout');
  assert.throws(
    () =>
      launch.retry({
        launchId: f.definition.launchId,
        rosterRevision: f.definition.rosterRevision,
        commandId: 'retry',
        attemptId: 'attempt',
        memberIds: ['A'],
      }),
    (error) =>
      error instanceof TeamLaunchError && error.reason === 'generation-replacement-required'
  );
  assert.equal(f.opens.get('A'), 1);
  launch.seal();
});

test('readiness loss and recovery keep the same generation and confirmed context without replaying or reopening', async (t) => {
  const f = await setup(t, ['A']);
  const { launch, evidence } = f.make();
  launch.start('launch-command');
  await settle(launch);
  assert.equal(launch.read().status, 'ready');
  const attempt = launch.read().members[0]!.attempt.attemptId;
  f.ready.delete('A');
  f.advance(60_000);
  launch.refresh();
  const lost = launch.read().members[0]!.attempt;
  assert.equal(lost.status, 'pending-bootstrap');
  assert.equal(lost.contextApplied, true);
  assert.equal(lost.usable, false);
  assert.equal(launch.canWork('A', evidence('A')), false);
  f.ready.add('A');
  launch.refresh();
  assert.equal(launch.read().status, 'ready');
  assert.equal(launch.read().members[0]!.attempt.attemptId, attempt);
  assert.equal(f.opens.get('A'), 1);
  launch.seal();
});

test('restart retains roster/attempts/permission obligations without replay, fresh usability or restored callbacks', async (t) => {
  const f = await setup(t, ['A', 'B']);
  const original = f.make();
  original.launch.start('launch-command');
  await settle(original.launch);
  const b = f.sessions.get('B')!,
    delivery = {
      binding: binding('B'),
      deliveryId: 'permission-input',
      inputId: 'permission-input',
      messageId: 'permission-message',
      content: 'TEST work',
    };
  await original.runtime.admitDelivery(delivery);
  await original.runtime.dispatchNext(binding('B'));
  const input = b.submits[0]!;
  b.emit({
    kind: 'interaction',
    sessionRef: b.sessionRef,
    inputId: input.inputId,
    operationRef: input.operationRef,
    interactionRef: 'retained-permission',
    request: { kind: 'permission', tool: 'TEST-tool', input: {} },
  });
  await tick();
  original.launch.refresh();
  original.launch.seal();
  const restarted = f.make('host-2');
  restarted.launch.start('launch-command');
  await settle(restarted.launch);
  const state = restarted.launch.read();
  assert.equal(state.expected, 2);
  assert.equal(state.ready, 0);
  assert.ok(
    state.members.every(
      (item) => item.attempt.status === 'unknown' && !item.attempt.controlAvailable
    )
  );
  assert.equal(
    state.members.find((item) => item.memberId === 'B')?.attempt.reason,
    'retained-interaction-unavailable'
  );
  await assert.rejects(
    restarted.runtime.respondToInteraction(binding('B'), input.inputId, 'retained-permission', {
      kind: 'permission',
      decision: 'allow',
    })
  );
  assert.deepEqual([...f.opens.values()], [1, 1]);
  assert.equal(b.submits.length, 1);
  restarted.launch.seal();
});

test('missing/skipped members remain in the persisted expected roster; changed descriptor and intent identities cannot replace it', async (t) => {
  const f = await setup(t, ['A', 'missing', 'skipped']);
  f.definition.members[1]!.configurationDigest = null;
  f.definition.members[2]!.skipped = true;
  const { launch } = f.make();
  launch.start('launch-command');
  await settle(launch);
  const state = launch.read();
  assert.equal(state.expected, 3);
  assert.equal(state.status, 'partial');
  assert.equal(state.members[1]?.attempt.reason, 'runtime-unconfigured');
  assert.equal(state.members[2]?.attempt.status, 'skipped');
  assert.deepEqual([...f.opens.keys()], ['A']);
  assert.throws(() => launch.start('different-command'), TeamLaunchError);
  assert.throws(
    () =>
      launch.retry({
        launchId: 'wrong-launch',
        rosterRevision: f.definition.rosterRevision,
        commandId: 'retry',
        attemptId: 'retry',
        memberIds: ['A'],
      }),
    TeamLaunchError
  );
  const changed = structuredClone(f.definition);
  changed.members[0]!.contextDigest = '0'.repeat(64);
  assert.throws(
    () =>
      new TeamLaunchOwner({
        definition: changed,
        hostIncarnation: 'new-host',
        store: f.store,
        authorized: (_action, callback) => callback(),
        runtime: {
          read: () => ({ attached: false, nativeReady: false }),
          open: async () => {
            assert.fail('must not allocate');
          },
        },
      }),
    TeamLaunchError
  );
  launch.seal();
});

test('current authorization gates read/retry and corrupt expected roster is HOLD instead of a smaller launch', async (t) => {
  const f = await setup(t, ['A']);
  const { launch } = f.make();
  launch.start('launch-command');
  await settle(launch);
  f.revoke();
  assert.throws(
    () => launch.read(),
    (error) => error instanceof TeamLaunchError && error.code === 'forbidden'
  );
  const path = join(f.store.directory, 'launches', `${runtimeDigest(f.definition.launchId)}.json`),
    record = JSON.parse(await readFile(path, 'utf8')) as { members: unknown[] };
  record.members = [];
  await writeFile(path, JSON.stringify(record));
  assert.throws(
    () => launch.refresh(),
    (error) => error instanceof TeamLaunchError && error.code === 'hold'
  );
  launch.seal();
});

test('failed observation clears current readiness/control while retaining historical context facts and never reopens', async (t) => {
  const f = await setup(t, ['A']);
  const { launch, runtime } = f.make();
  launch.start('launch-command');
  await settle(launch);
  assert.equal(launch.read().members[0]?.attempt.controlAvailable, true);
  f.observationFailure.add('A');
  launch.refresh();
  let state = launch.read().members[0]!.attempt;
  assert.equal(state.status, 'unknown');
  assert.equal(state.nativeReady, false);
  assert.equal(state.controlAvailable, false);
  assert.equal(state.contextApplied, true);
  assert.equal(state.everReady, true);
  assert.equal(state.usable, false);
  f.observationFailure.delete('A');
  const session = f.sessions.get('A')!;
  await runtime.admitDelivery({
    binding: binding('A'),
    deliveryId: 'control',
    inputId: 'control',
    messageId: 'control-message',
    content: 'TEST permission',
  });
  await runtime.dispatchNext(binding('A'));
  const input = session.submits[0]!;
  session.emit({
    kind: 'interaction',
    sessionRef: session.sessionRef,
    inputId: input.inputId,
    operationRef: input.operationRef,
    interactionRef: 'pending',
    request: { kind: 'permission', tool: 'TEST-tool', input: {} },
  });
  await tick();
  launch.refresh();
  assert.equal(launch.read().members[0]?.attempt.status, 'pending-human');
  f.observationFailure.add('A');
  launch.refresh();
  state = launch.read().members[0]!.attempt;
  assert.equal(state.status, 'unknown');
  assert.equal(state.nativeReady, false);
  assert.equal(state.controlAvailable, false);
  assert.equal(f.opens.get('A'), 1);
  assert.equal(session.submits.length, 1);
  launch.seal();
});


test('cold startup refresh keeps historical ready launch bytes while reads project closed Runtime truth', async (t) => {
  const f = await setup(t, ['A']), original = f.make('host-1');
  original.launch.start('TEST-original-ready');
  await settle(original.launch);
  assert.equal(original.launch.read().status, 'ready');
  await original.runtime.admitDelivery({ binding: binding('A'), deliveryId: 'TEST-unknown', inputId: 'TEST-unknown', messageId: 'TEST-message', content: 'TEST interrupted original' });
  await original.runtime.dispatchNext(binding('A'));
  const closed = await original.runtime.stopCapturedSession(binding('A'));
  await tick();
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.custody, 'released');
  assert.equal(closed.inputs[0]?.phase, 'unknown');
  const launchPath = join(f.root, 'teams/TEST-team/.host-owner/launches', runtimeDigest(f.definition.launchId) + '.json');
  const before = await readFile(launchPath);
  assert.equal((JSON.parse(before.toString()) as TeamLaunchRecord).members[0]!.attempts[0]!.status, 'ready');
  const runtimeBefore = JSON.stringify(f.runtimeStore.fenced(binding('A'), tx => tx.get()));
  const cold = f.make('host-2');
  for (let count = 0; count < 2; count++) {
    const summary = cold.launch.read();
    assert.equal(summary.status, 'failed');
    assert.equal(summary.members[0]!.attempt.reason, 'stopped');
    assert.equal(summary.members[0]!.attempt.usable, false);
    cold.launch.refresh(); // Exact method called by metadata Host startup kick.
  }
  assert.deepEqual(await readFile(launchPath), before, 'foreign historical attempt is not a new native observation');
  assert.equal(JSON.stringify(f.runtimeStore.fenced(binding('A'), tx => tx.get())), runtimeBefore);
  assert.equal(f.opens.get('A'), 1);
});

test('current owner refresh still persists actual stopped readiness transition', async (t) => {
  const f = await setup(t, ['A']), current = f.make('host-1');
  current.launch.start('TEST-current-ready');
  await settle(current.launch);
  assert.equal(current.launch.read().status, 'ready');
  const path = join(f.root, 'teams/TEST-team/.host-owner/launches', runtimeDigest(f.definition.launchId) + '.json');
  const before = await readFile(path);
  await current.runtime.stopCapturedSession(binding('A'));
  await tick();
  current.launch.refresh();
  const after = await readFile(path), attempt = (JSON.parse(after.toString()) as TeamLaunchRecord).members[0]!.attempts[0]!;
  assert.notDeepEqual(after, before);
  assert.equal(attempt.reason, 'stopped');
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.usable, false);
  assert.equal(attempt.nativeReady, false);
  assert.equal(attempt.controlAvailable, false);
});
