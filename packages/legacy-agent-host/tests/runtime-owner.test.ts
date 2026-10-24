import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import type {
  RuntimeBinding,
  RuntimeDelivery,
  RuntimeOwnerOptions,
  RuntimeStore,
} from '../dist/runtime/contracts.js';
import type {
  CloseReceipt,
  DriverFactory,
  Event,
  Handoff,
  Input,
  InteractionReply,
  OpenConfig,
  Reply,
  Session,
} from '@agent-teams/provider-session-contracts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class Events implements AsyncIterable<Event> {
  private readonly queue: Event[] = [];
  private waiter: ((result: IteratorResult<Event>) => void) | undefined;
  private ended = false;
  push(event: Event): void {
    if (this.waiter) {
      const next = this.waiter;
      this.waiter = undefined;
      next({ done: false, value: event });
    } else this.queue.push(event);
  }
  end(): void {
    this.ended = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

class ControlledSession implements Session {
  readonly events = new Events();
  readonly submits: Input[] = [];
  readonly interrupts: string[] = [];
  readonly replies: { ref: string; reply: InteractionReply }[] = [];
  closeCalls = 0;
  cleanup: CloseReceipt['cleanup'] = 'confirmed';
  submitAction: ((input: Input) => Promise<Reply<Handoff>>) | undefined;
  interruptAction: (() => Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>>) | undefined;
  readonly sessionRef: string;
  constructor(sessionRef: string) {
    this.sessionRef = sessionRef;
  }
  submit = async (input: Input): Promise<Reply<Handoff>> => {
    this.submits.push(input);
    return this.submitAction
      ? this.submitAction(input)
      : {
          ok: true,
          value: {
            inputId: input.inputId,
            operationRef: input.operationRef,
            delivery: 'client-consumed',
            providerAcceptance: 'unknown',
          },
        };
  };
  observe = (): AsyncIterable<Event> => this.events;
  respondToInteraction = async (ref: string, reply: InteractionReply): Promise<Reply<void>> => {
    this.replies.push({ ref, reply });
    return { ok: true, value: undefined };
  };
  interrupt = async (ref: string): Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>> => {
    this.interrupts.push(ref);
    return this.interruptAction
      ? this.interruptAction()
      : { ok: true, value: { requested: true, terminal: 'unconfirmed' } };
  };
  checkReadiness = async (): Promise<Reply<void>> => ({ ok: true, value: undefined });
  checkpoint = (): Reply<unknown> => ({ ok: false, code: 'unsupported' });
  close = async (): Promise<CloseReceipt> => {
    this.closeCalls++;
    this.events.end();
    return { logicallyClosed: true, cleanup: this.cleanup };
  };
  result(index = 0, outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' = 'succeeded'): void {
    const input = this.submits[index];
    assert.ok(input);
    this.events.push({
      sessionRef: this.sessionRef,
      inputId: input.inputId,
      operationRef: input.operationRef,
      kind: 'result',
      outcome,
    });
  }
}

const binding = (memberId = 'A', generation = 'generation-1'): RuntimeBinding => ({
  backendId: 'TEST-backend',
  teamId: 'TEST-team',
  runId: 'TEST-run',
  memberId,
  generation,
});
const config = (memberId = 'A'): OpenConfig => ({
  tenantId: 'TEST-backend',
  projectId: 'TEST-project',
  sessionId: `session-${memberId}`,
  generation: 1,
  configRevision: 'config-1',
  requiredCapabilities: ['tools'],
});
const delivery = (id: string, target = binding()): RuntimeDelivery => ({
  binding: target,
  deliveryId: id,
  inputId: id,
  messageId: `message-${id}`,
  content: `TEST input ${id}`,
});

async function setup(t: { after(fn: () => Promise<void> | void): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-runtime-owner-')));
  const store = new FileRuntimeStore(root);
  const sessions = new Map<string, ControlledSession>();
  let opens = 0;
  const driverFactory: DriverFactory = {
    open: async (request) => {
      opens++;
      const session = new ControlledSession(request.sessionId);
      sessions.set(request.sessionId, session);
      return { driver: session, capabilities: ['tools'] };
    },
  };
  const make = (hostIncarnation: string, overrides: Partial<RuntimeOwnerOptions> = {}) =>
    new RuntimeOwner({
      store,
      driverFactory,
      profileId: 'TEST-profile',
      hostIncarnation,
      authorize: () => true,
      canDispatch: () => true,
      ...overrides,
    });
  t.after(async () => {
    for (const session of sessions.values()) session.events.end();
    await tick();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, sessions, make, opens: () => opens };
}

test('durable admission survives lost ACK; immutable duplicates reuse one operation and changed payload conflicts', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1');
  await runtime.openSession({ binding: binding(), config: config() });
  const first = await runtime.admitDelivery(delivery('one'));
  const duplicate = await runtime.admitDelivery({ ...delivery('one'), binding: { ...binding() } });
  assert.deepEqual(duplicate, first);
  assert.equal(
    f.sessions.get('session-A')?.submits.length,
    0,
    'Team admission must not itself submit'
  );
  await assert.rejects(
    runtime.admitDelivery({ ...delivery('one'), content: 'different payload' }),
    (error) => error instanceof RuntimeOwnerError && error.code === 'conflict'
  );
  await runtime.dispatchNext(binding());
  assert.equal(f.sessions.get('session-A')?.submits.length, 1);
  const restarted = f.make('host-2');
  assert.equal((await restarted.lookupDelivery(delivery('one'))).outcome, 'admitted');
  const held = restarted.reconcileSession(binding());
  assert.equal(held.inputs[0]?.phase, 'unknown');
  assert.equal(held.hostIncarnation, 'host-1');
  await restarted.openSession({ binding: binding(), config: config() });
  await assert.rejects(restarted.dispatchNext(binding()), RuntimeOwnerError);
  await assert.rejects(
    restarted.openSession({
      binding: binding('A', 'generation-2'),
      config: { ...config(), generation: 2 },
    }),
    RuntimeOwnerError
  );
  assert.equal(f.opens(), 1, 'restart/open retry must not allocate another native session');
  assert.equal(f.sessions.get('session-A')?.submits.length, 1);
});

test('opening intent persisted before allocation is never replayed after interrupted publication', async (t) => {
  const f = await setup(t);
  const opening = deferred<Awaited<ReturnType<DriverFactory['open']>>>();
  let opens = 0;
  const runtime = f.make('host-1', {
    driverFactory: {
      open: () => {
        opens++;
        return opening.promise;
      },
    },
  });
  const pending = runtime.openSession({ binding: binding(), config: config() });
  assert.equal(runtime.readSession(binding()).record?.phase, 'opening');
  const restarted = f.make('host-2');
  assert.equal(restarted.reconcileSession(binding()).custody, 'unknown');
  await restarted.openSession({ binding: binding(), config: config() });
  assert.equal(opens, 1);
  assert.equal(f.opens(), 0);
  // Stop during the still-live original opening fences its late native result.
  await runtime.stopSession(binding());
  const session = new ControlledSession('late-native');
  opening.resolve({ driver: session, capabilities: ['tools'] });
  const result = await pending;
  assert.equal(result.sealed, true);
  assert.equal(result.phase, 'closed');
  assert.equal(session.closeCalls, 1);
  assert.equal(session.submits.length, 0);
});

test('failure immediately after durable dispatch claim causes HOLD, not native submit replay', async (t) => {
  const f = await setup(t);
  let inject = false;
  const faultStore: RuntimeStore = {
    fenced: (target, action) =>
      f.store.fenced(target, (tx) =>
        action({
          ...tx,
          put(record) {
            tx.put(record);
            if (inject && record.inputs.some((input) => input.phase === 'claimed')) {
              inject = false;
              throw new Error('TEST crash after claim publication');
            }
          },
        })
      ),
  };
  const runtime = f.make('host-1', { store: faultStore });
  await runtime.openSession({ binding: binding(), config: config() });
  await runtime.admitDelivery(delivery('one'));
  inject = true;
  await assert.rejects(runtime.dispatchNext(binding()), /TEST crash/);
  assert.equal(f.sessions.get('session-A')?.submits.length, 0);
  const restarted = f.make('host-2');
  assert.equal(restarted.reconcileSession(binding()).inputs[0]?.phase, 'unknown');
  await assert.rejects(restarted.dispatchNext(binding()), RuntimeOwnerError);
  assert.equal(f.sessions.get('session-A')?.submits.length, 0);
});

test('unseen cancellation tombstone and stop-sealed queues survive restart without dispatch', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1');
  assert.equal((await runtime.cancelDelivery(delivery('unseen'))).outcome, 'not_admitted');
  await runtime.openSession({ binding: binding(), config: config() });
  assert.equal((await runtime.admitDelivery(delivery('unseen'))).outcome, 'not_admitted');
  await runtime.admitDelivery(delivery('queued'));
  const stopped = await runtime.stopSession(binding());
  assert.equal(stopped.phase, 'closed');
  assert.equal(
    stopped.inputs.find((input) => input.intent.inputId === 'queued')?.phase,
    'cancelled'
  );
  const restarted = f.make('host-2');
  for (const id of ['queued', 'unseen', 'late'])
    assert.equal((await restarted.admitDelivery(delivery(id))).outcome, 'not_admitted');
  await assert.rejects(restarted.dispatchNext(binding()), RuntimeOwnerError);
  assert.equal(f.sessions.get('session-A')?.submits.length, 0);
});

test('independent permission/interrupt on A cannot cancel B or misdirect late interrupt A1 to A2', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1');
  await runtime.openSession({ binding: binding(), config: config() });
  await runtime.openSession({ binding: binding('B'), config: config('B') });
  const a = f.sessions.get('session-A')!;
  const b = f.sessions.get('session-B')!;
  await runtime.admitDelivery(delivery('A1'));
  await runtime.admitDelivery(delivery('A2'));
  await runtime.admitDelivery(delivery('B1', binding('B')));
  await runtime.dispatchNext(binding());
  await runtime.dispatchNext(binding('B'));
  const a1 = a.submits[0]!;
  a.events.push({
    sessionRef: a.sessionRef,
    inputId: a1.inputId,
    operationRef: a1.operationRef,
    kind: 'interaction',
    interactionRef: 'permission-A1',
    request: { kind: 'permission', tool: 'TEST-tool', input: {} },
  });
  await tick();
  await runtime.respondToInteraction(binding(), 'A1', 'permission-A1', {
    kind: 'permission',
    decision: 'deny',
  });
  assert.equal(a.replies.length, 1);
  assert.equal(b.replies.length, 0);
  const interrupt = deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>();
  a.interruptAction = () => interrupt.promise;
  const pendingInterrupt = runtime.interrupt(binding(), 'A1');
  a.result();
  await tick();
  await assert.rejects(
    runtime.dispatchNext(binding()),
    RuntimeOwnerError,
    'pending control fences next handoff'
  );
  interrupt.resolve({ ok: true, value: { requested: true, terminal: 'unconfirmed' } });
  await pendingInterrupt;
  await runtime.dispatchNext(binding());
  await runtime.interrupt(binding(), 'A1');
  assert.deepEqual(a.interrupts, [a1.operationRef]);
  assert.equal(a.submits.length, 2);
  assert.equal(b.submits.length, 1);
  assert.equal(b.closeCalls, 0);
  a.cleanup = 'unknown';
  const stopped = await runtime.stopSession(binding());
  assert.equal(stopped.custody, 'unknown');
  assert.equal(stopped.phase, 'held');
  b.result();
  await tick();
  await runtime.admitDelivery(delivery('B2', binding('B')));
  await runtime.dispatchNext(binding('B'));
  assert.equal(b.submits.length, 2, 'B progresses while A retains custody debt');
});

test('current authority gates admission, duplicate lookup and dispatch; terminal capture survives revoke', async (t) => {
  const f = await setup(t);
  let granted = true;
  const runtime = f.make('host-1', { authorize: () => granted });
  await runtime.openSession({ binding: binding(), config: config() });
  await runtime.admitDelivery(delivery('one'));
  await runtime.dispatchNext(binding());
  granted = false;
  await assert.rejects(
    runtime.lookupDelivery(delivery('one')),
    (error) => error instanceof RuntimeOwnerError && error.code === 'forbidden'
  );
  await assert.rejects(runtime.admitDelivery(delivery('two')), RuntimeOwnerError);
  await assert.rejects(runtime.dispatchNext(binding()), RuntimeOwnerError);
  f.sessions.get('session-A')!.result();
  await tick();
  granted = true;
  assert.equal(runtime.readSession(binding()).record?.inputs[0]?.terminal, 'succeeded');
});

test('known-not-sent differs from uncertain submit, and fresh host cannot answer retained permission', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1');
  await runtime.openSession({ binding: binding(), config: config() });
  const session = f.sessions.get('session-A')!;
  session.submitAction = async () => ({
    ok: false,
    code: 'backpressure',
    delivery: 'known-not-sent',
  });
  await runtime.admitDelivery(delivery('not-sent'));
  assert.equal((await runtime.dispatchNext(binding())).inputs[0]?.phase, 'not-sent');
  session.submitAction = async () => {
    throw new Error('TEST response lost');
  };
  await runtime.admitDelivery(delivery('uncertain'));
  assert.equal((await runtime.dispatchNext(binding())).inputs[1]?.phase, 'unknown');
  const input = session.submits[1]!;
  session.events.push({
    sessionRef: session.sessionRef,
    inputId: input.inputId,
    operationRef: input.operationRef,
    kind: 'interaction',
    interactionRef: 'retained',
    request: { kind: 'permission', tool: 'TEST-tool', input: {} },
  });
  await tick();
  const restarted = f.make('host-2');
  const record = restarted.reconcileSession(binding());
  assert.equal(record.interactions[0]?.phase, 'unknown');
  await assert.rejects(
    restarted.respondToInteraction(binding(), 'uncertain', 'retained', {
      kind: 'permission',
      decision: 'allow',
    }),
    RuntimeOwnerError
  );
  assert.equal(session.replies.length, 0);
});

test('corrupt runtime obligation is HOLD rather than an empty session or permission to replace it', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1');
  await runtime.openSession({ binding: binding(), config: config() });
  await runtime.admitDelivery(delivery('one'));
  const [memberDirectory] = await readdir(join(f.root, 'runtime-sessions'));
  assert.ok(memberDirectory);
  const directory = join(f.root, 'runtime-sessions', memberDirectory);
  const [file] = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  assert.ok(file);
  const path = join(directory, file);
  const stored = JSON.parse(await readFile(path, 'utf8')) as { inputs: { phase: string }[] };
  stored.inputs[0]!.phase = 'invented-terminal';
  await writeFile(path, JSON.stringify(stored));
  const restarted = f.make('host-2');
  assert.throws(
    () => restarted.readSession(binding()),
    (error) => error instanceof RuntimeOwnerError && error.code === 'hold'
  );
  await assert.rejects(
    restarted.openSession({ binding: binding('A', 'replacement'), config: config() }),
    RuntimeOwnerError
  );
  assert.equal(f.opens(), 1);
});

test('runtime namespace and member directories reject symlinks without touching the target', async (t) => {
  const f = await setup(t);
  const external = join(f.root, 'TEST-external');
  await mkdir(external);
  await writeFile(join(external, 'sentinel'), 'unchanged');
  const runtime = f.make('host-1');
  await runtime.admitDelivery(delivery('one'));
  const namespace = join(f.root, 'runtime-sessions');
  const [member] = await readdir(namespace);
  assert.ok(member);
  await rename(join(namespace, member), join(f.root, 'TEST-saved-member'));
  await symlink(external, join(namespace, member), 'dir');
  assert.throws(() => runtime.readSession(binding()), RuntimeOwnerError);
  await rename(namespace, join(f.root, 'TEST-saved-namespace'));
  await symlink(external, namespace, 'dir');
  assert.throws(() => new FileRuntimeStore(f.root), RuntimeOwnerError);
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(external), ['sentinel']);
});

test('per-intent revocation before claim durably rejects unclaimed work, and restored grants do not replay it', async (t) => {
  const f = await setup(t);
  let eligible = true;
  const runtime = f.make('host-1', {
    authorize: (_binding, action, intent) => action !== 'dispatch' || !intent || eligible,
  });
  await runtime.openSession({ binding: binding(), config: config() });
  await runtime.admitDelivery(delivery('revoked'));
  eligible = false;
  await assert.rejects(
    runtime.dispatchNext(binding()),
    (error) => error instanceof RuntimeOwnerError && error.code === 'forbidden'
  );
  eligible = true;
  assert.equal((await runtime.lookupDelivery(delivery('revoked'))).outcome, 'not_admitted');
  assert.equal(runtime.readSession(binding()).record?.inputs[0]?.phase, 'rejected');
  await runtime.dispatchNext(binding());
  assert.equal(f.sessions.get('session-A')?.submits.length, 0);
  await assert.rejects(
    runtime.openSession({
      binding: binding('B'),
      config: { ...config('B'), checkpointRef: 'unvalidated-checkpoint' },
    }),
    RuntimeOwnerError
  );
  assert.equal(
    f.opens(),
    1,
    'unpublished checkpoint cannot bypass host custody/history validation'
  );
});

test('queue/input byte limits reject before admission and native readiness alone cannot bypass required dispatch proof', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1', {
    maxQueuedInputs: 2,
    maxInputBytes: 4,
    canDispatch: () => false,
  });
  await runtime.openSession({ binding: binding(), config: config() });
  const first = { ...delivery('one'), content: '😀' };
  const second = { ...delivery('two'), content: 'abcd' };
  assert.equal((await runtime.admitDelivery(first)).outcome, 'admitted');
  assert.equal((await runtime.admitDelivery(second)).outcome, 'admitted');
  await assert.rejects(
    runtime.admitDelivery({ ...delivery('three'), content: 'abcd' }),
    (error) => error instanceof RuntimeOwnerError && error.code === 'busy'
  );
  await assert.rejects(
    runtime.admitDelivery({ ...delivery('large'), content: '😀x' }),
    (error) => error instanceof RuntimeOwnerError && error.code === 'invalid'
  );
  await assert.rejects(runtime.dispatchNext(binding()), RuntimeOwnerError);
  assert.equal(runtime.readSession(binding()).record?.inputs.length, 2);
  assert.equal(f.sessions.get('session-A')?.submits.length, 0);
});

test('stop waits for the accepted interrupt then closes once without dispatching queued input', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1');
  await runtime.openSession({ binding: binding(), config: config() });
  const session = f.sessions.get('session-A')!;
  await runtime.admitDelivery(delivery('active'));
  await runtime.admitDelivery(delivery('queued'));
  await runtime.dispatchNext(binding());
  const completion = deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>();
  session.interruptAction = () => completion.promise;
  const interrupt = runtime.interrupt(binding(), 'active');
  await tick();
  let completed = false;
  const stop = runtime.stopSession(binding()).then((record) => {
    completed = true;
    return record;
  });
  await tick();
  assert.equal(completed, false);
  assert.equal(session.closeCalls, 0);
  assert.equal(runtime.readSession(binding()).record?.inputs[1]?.phase, 'cancelled');
  completion.resolve({ ok: true, value: { requested: true, terminal: 'unconfirmed' } });
  await interrupt;
  const stopped = await stop;
  assert.equal(stopped.phase, 'closed');
  assert.equal(stopped.custody, 'released');
  assert.equal(stopped.control, undefined);
  assert.equal(session.closeCalls, 1);
  assert.equal(session.submits.length, 1);
  await runtime.stopSession(binding());
  assert.equal(session.closeCalls, 1);
});

test('settled unknown interrupt does not skip owned cleanup and retains uncertainty after closure', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1');
  await runtime.openSession({ binding: binding(), config: config() });
  const session = f.sessions.get('session-A')!;
  await runtime.admitDelivery(delivery('active'));
  await runtime.dispatchNext(binding());
  const completion = deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>();
  session.interruptAction = () => completion.promise;
  const interrupt = runtime.interrupt(binding(), 'active');
  await tick();
  const stop = runtime.stopSession(binding());
  completion.resolve({ ok: false, code: 'unknown' });
  await interrupt;
  const stopped = await stop;
  assert.equal(session.closeCalls, 1);
  assert.equal(stopped.custody, 'released');
  assert.equal(stopped.control?.phase, 'unknown');
  assert.equal(stopped.inputs[0]?.phase, 'unknown');
  await assert.rejects(
    runtime.openSession({ binding: binding('A', 'next'), config: { ...config(), generation: 2 } }),
    RuntimeOwnerError
  );
});

test('trusted captured shutdown cleans an owned session after revocation without adopting foreign custody', async (t) => {
  const f = await setup(t);
  let granted = true;
  const runtime = f.make('host-1', { authorize: () => granted });
  await runtime.openSession({ binding: binding(), config: config() });
  const session = f.sessions.get('session-A')!;
  await runtime.admitDelivery(delivery('queued'));
  granted = false;
  await assert.rejects(
    runtime.stopSession(binding()),
    (error) => error instanceof RuntimeOwnerError && error.code === 'forbidden'
  );
  assert.equal(session.closeCalls, 0);
  const stopped = await runtime.stopCapturedSession(binding());
  assert.equal(stopped.sealed, true);
  assert.equal(stopped.phase, 'closed');
  assert.equal(stopped.custody, 'released');
  assert.equal(stopped.inputs[0]?.phase, 'cancelled');
  assert.equal(session.closeCalls, 1);
  assert.equal(session.submits.length, 0);
  await runtime.stopCapturedSession(binding());
  assert.equal(session.closeCalls, 1);
  assert.equal(f.opens(), 1);

  granted = true;
  await runtime.openSession({ binding: binding('B'), config: config('B') });
  const foreign = f.make('host-2', { authorize: () => false });
  const held = await foreign.stopCapturedSession(binding('B'));
  assert.equal(held.sealed, true);
  assert.equal(held.phase, 'held');
  assert.equal(held.custody, 'unknown');
  assert.equal(held.hostIncarnation, 'host-1');
  assert.equal(f.sessions.get('session-B')?.closeCalls, 0);
  assert.equal(f.opens(), 2, 'trusted shutdown cannot adopt or allocate foreign host resources');
});

test('trusted shutdown before first open seals a closed technical tombstone without allocating', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1', { authorize: () => false });
  const stopped = await runtime.stopCapturedSession(binding());
  assert.equal(stopped.phase, 'closed');
  assert.equal(stopped.custody, 'released');
  assert.equal(stopped.sealed, true);
  assert.equal(stopped.config, null);
  assert.equal(f.opens(), 0);
  const restarted = f.make('host-2');
  assert.equal((await restarted.admitDelivery(delivery('late'))).outcome, 'not_admitted');
  await assert.rejects(
    restarted.openSession({ binding: binding(), config: config() }),
    heldRuntime
  );
  assert.equal(f.opens(), 0);
  assert.equal((await restarted.stopCapturedSession(binding())).phase, 'closed');
});

function heldRuntime(error: unknown): boolean {
  return error instanceof RuntimeOwnerError && error.code === 'hold';
}

test('repeated settled unknown close retains held custody debt without another native close', async (t) => {
  const f = await setup(t);
  const runtime = f.make('host-1', { events: f.store });
  await runtime.openSession({ binding: binding(), config: config() });
  const session = f.sessions.get('session-A')!;
  session.cleanup = 'unknown';
  const first = await runtime.stopCapturedSession(binding());
  assert.equal(first.phase, 'held');
  assert.equal(first.custody, 'unknown');
  assert.equal(first.closeClaimed, true);
  await tick();
  const [namespace] = await readdir(join(f.root, 'runtime-sessions'));
  assert.ok(namespace);
  const paths = [join(f.root, 'runtime-sessions', namespace, runtimeDigest(binding()) + '.json'),
    join(f.root, 'runtime-events', runtimeDigest(binding()) + '.json')];
  const before = await Promise.all(paths.map(path => readFile(path)));
  for (const owner of [runtime, f.make('host-2', { authorize: () => false, events: f.store })]) {
    const repeated = await owner.stopCapturedSession(binding());
    assert.equal(repeated.phase, 'held');
    assert.equal(repeated.custody, 'unknown');
    assert.equal(repeated.closeClaimed, true);
    assert.equal(repeated.sealed, true);
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before,
      'settled unknown close must not append duplicate held observations');
  }
  assert.equal(session.closeCalls, 1);
  assert.equal(f.opens(), 1);
});


test('driver-less held shutdown publishes sealing once and cold disposal preserves original bytes', async (t) => {
  const f = await setup(t), runtime = f.make('host-1', {
    events: f.store,
    driverFactory: { open: async () => { throw new Error('TEST factory rejected'); } },
  });
  await runtime.admitDelivery(delivery('queued-before-factory-rejection'));
  const failed = await runtime.openSession({ binding: binding(), config: config() });
  assert.equal(failed.phase, 'held');
  assert.equal(failed.sealed, false);
  assert.equal(failed.diagnostic, 'open-unknown');
  const sequence = f.store.readActivity(binding())!.sequence;
  const stopped = await runtime.stopCapturedSession(binding());
  assert.equal(stopped.sealed, true);
  assert.equal(stopped.custody, 'unknown');
  assert.equal(stopped.inputs[0]?.phase, 'cancelled');
  assert.ok(f.store.readActivity(binding())!.sequence > sequence,
    'actual sealing and admission cancellation must remain observable');
  const [namespace] = await readdir(join(f.root, 'runtime-sessions'));
  assert.ok(namespace);
  const paths = [join(f.root, 'runtime-sessions', namespace, runtimeDigest(binding()) + '.json'),
    join(f.root, 'runtime-events', runtimeDigest(binding()) + '.json')];
  const before = await Promise.all(paths.map(path => readFile(path)));
  const cold = f.make('host-2', { events: f.store, authorize: () => false });
  await assert.rejects(cold.stopSession(binding()),
    error => error instanceof RuntimeOwnerError && error.code === 'forbidden');
  for (const owner of [runtime, cold, cold]) {
    const repeated = await owner.stopCapturedSession(binding());
    assert.equal(repeated.phase, 'held');
    assert.equal(repeated.custody, 'unknown');
    assert.equal(repeated.diagnostic, 'open-unknown');
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before,
      'repeated driver-less shutdown must preserve raw record and activity bytes');
  }
  assert.equal(f.opens(), 0);
  assert.equal(f.sessions.size, 0);
});

for (const change of ['expiry', 'terminal-input', 'pending-control'] as const) {
  test(`interaction ${change} between reply claim and driver call cannot issue a grant`, async (t) => {
    const f = await setup(t);
    const runtime = f.make('host-1');
    await runtime.openSession({ binding: binding(), config: config() });
    await runtime.admitDelivery(delivery('permission-input'));
    await runtime.dispatchNext(binding());
    const session = f.sessions.get('session-A')!;
    const input = session.submits[0]!;
    session.events.push({
      sessionRef: session.sessionRef,
      inputId: input.inputId,
      operationRef: input.operationRef,
      kind: 'interaction',
      interactionRef: 'permission-race',
      request: { kind: 'permission', tool: 'TEST-tool', input: {} },
    });
    await tick();
    const pending = runtime.respondToInteraction(binding(), input.inputId, 'permission-race', {
      kind: 'permission',
      decision: 'allow',
    });
    f.store.fenced(binding(), (tx) => {
      const state = tx.get()!;
      const interaction = state.interactions.find(
        (item) => item.interactionRef === 'permission-race'
      )!;
      assert.equal(interaction.phase, 'responding');
      if (change === 'expiry') interaction.expiresAt = 0;
      else if (change === 'terminal-input') {
        const original = state.inputs.find((item) => item.intent.inputId === input.inputId)!;
        original.phase = 'terminal';
        original.terminal = 'cancelled';
      } else
        state.control = {
          inputId: input.inputId,
          operationRef: input.operationRef,
          phase: 'pending',
        };
      tx.put(state);
    });
    const settled = await pending;
    assert.equal(
      session.replies.length,
      0,
      'no provider permission after original scope becomes invalid'
    );
    assert.equal(
      settled.interactions.find((item) => item.interactionRef === 'permission-race')?.phase,
      'unknown'
    );
  });
}


test('cold metadata shutdown preserves settled closed Runtime bytes, original unknown input and event sequence', async (t) => {
  const f = await setup(t), first = f.make('host-1', { events: f.store });
  await first.openSession({ binding: binding(), config: config() });
  await first.admitDelivery(delivery('interrupted-original'));
  await first.dispatchNext(binding());
  const stopped = await first.stopCapturedSession(binding());
  await tick();
  assert.equal(stopped.phase, 'closed');
  assert.equal(stopped.custody, 'released');
  assert.equal(stopped.inputs[0]?.phase, 'unknown');
  const [namespace] = await readdir(join(f.root, 'runtime-sessions'));
  assert.ok(namespace);
  const paths = [join(f.root, 'runtime-sessions', namespace, runtimeDigest(binding()) + '.json'),
    join(f.root, 'runtime-events', runtimeDigest(binding()) + '.json')];
  const before = await Promise.all(paths.map(path => readFile(path)));
  const cold = f.make('host-2', { events: f.store });
  await cold.stopCapturedSession(binding());
  await cold.stopCapturedSession(binding());
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before,
    'cold read-only Host cleanup must not append duplicate closed observations');
  assert.equal(cold.readSession(binding()).record?.inputs[0]?.phase, 'unknown');
  assert.equal(f.opens(), 1);
  assert.equal(f.sessions.get('session-A')?.closeCalls, 1);
});

test('closed Runtime with unfinished sealing still publishes actual admission cancellation once', async (t) => {
  const f = await setup(t), runtime = f.make('host-1', { events: f.store });
  await runtime.admitDelivery(delivery('queued-original'));
  f.store.fenced(binding(), tx => {
    const record = tx.get()!;
    record.phase = 'closed'; record.custody = 'released';
    record.sealed = false; record.nativeReady = false;
    tx.put(record);
  });
  const before = f.store.readActivity(binding())!.sequence;
  const closed = await runtime.stopCapturedSession(binding());
  assert.equal(closed.sealed, true);
  assert.equal(closed.nativeReady, false);
  assert.equal(closed.inputs[0]?.phase, 'cancelled');
  assert.ok(f.store.readActivity(binding())!.sequence > before,
    'meaningful closure correction must remain observable');
  const settled = JSON.stringify(f.store.readActivity(binding()));
  await runtime.stopCapturedSession(binding());
  assert.equal(JSON.stringify(f.store.readActivity(binding())), settled);
  assert.equal(f.opens(), 0);
});
