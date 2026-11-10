import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import type { CheckpointPayload, CheckpointStorage } from '../dist/runtime/checkpointContracts.js';
import type {
  RuntimeBinding,
  RuntimeDelivery,
  RuntimeOwnerOptions,
  RuntimeStore,
} from '../dist/runtime/contracts.js';
import type {
  DriverFactory,
  Event,
  Input,
  OpenConfig,
  Reply,
  Session,
} from '@agent-teams/provider-session-contracts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const binding = (generation = 'generation-1'): RuntimeBinding => ({
  backendId: 'TEST-backend',
  teamId: 'TEST-team',
  runId: 'TEST-run',
  memberId: 'TEST-A',
  generation,
});
const config = (generation = 1): OpenConfig => ({
  tenantId: 'TEST-tenant',
  projectId: 'TEST-project',
  sessionId: 'TEST-session',
  generation,
  configRevision: 'config-1',
  requiredCapabilities: ['tools'],
});
const delivery = (id: string, target = binding(), content = `TEST ${id}`): RuntimeDelivery => ({
  binding: target,
  deliveryId: id,
  inputId: id,
  messageId: `message-${id}`,
  content,
});
const restoreRequest = (reference: string) => ({
  sourceBinding: binding(),
  reference,
  binding: binding('generation-2'),
  config: config(2),
});
const held = (error: unknown): boolean =>
  error instanceof RuntimeOwnerError && error.code === 'hold';

class Events implements AsyncIterable<Event> {
  private readonly queue: Event[] = [];
  private waiter: ((result: IteratorResult<Event>) => void) | undefined;
  private ended = false;
  push(event: Event): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: event });
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
  readonly history: string[];
  readonly sessionRef: string;
  captures = 0;
  closes = 0;
  supported = true;
  uncertain = false;
  knownNotSent = false;
  constructor(sessionRef: string, history: string[] = []) {
    this.sessionRef = sessionRef;
    this.history = [...history];
  }
  submit: Session['submit'] = async (input) => {
    this.submits.push(input);
    if (this.uncertain) throw new Error('TEST lost submit response');
    if (this.knownNotSent) return { ok: false, code: 'backpressure', delivery: 'known-not-sent' };
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
  observe = (): AsyncIterable<Event> => this.events;
  respondToInteraction: Session['respondToInteraction'] = async () => ({
    ok: true,
    value: undefined,
  });
  interrupt: Session['interrupt'] = async () => ({
    ok: true,
    value: { requested: true, terminal: 'unconfirmed' },
  });
  checkReadiness: Session['checkReadiness'] = async () => ({ ok: true, value: undefined });
  checkpoint = (): Reply<unknown> => {
    this.captures++;
    return this.supported
      ? {
          ok: true,
          value: {
            engine: 'TEST-engine',
            providerHash: 'opaque-HASH-unchanged',
            nativeSessionToken: 'opaque-token-unchanged',
            history: [...this.history],
          },
        }
      : { ok: false, code: 'unsupported' };
  };
  close: Session['close'] = async () => {
    this.closes++;
    this.events.end();
    return { logicallyClosed: true, cleanup: 'confirmed' };
  };
  complete(index = this.submits.length - 1): void {
    const input = this.submits[index];
    assert.ok(input);
    this.history.push(input.content);
    this.events.push({
      sessionRef: this.sessionRef,
      inputId: input.inputId,
      operationRef: input.operationRef,
      kind: 'result',
      outcome: 'succeeded',
    });
  }
}
async function setup(
  t: { after(fn: () => Promise<void>): void },
  limits: ConstructorParameters<typeof FileRuntimeStore>[1] = {}
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-runtime-checkpoint-')));
  const store = new FileRuntimeStore(root, limits);
  const sessions: ControlledSession[] = [];
  const opened: OpenConfig[] = [];
  let missingNativeHistory = false;
  const make = (hostIncarnation = 'host-1', overrides: Partial<RuntimeOwnerOptions> = {}) => {
    const driverFactory: DriverFactory = {
      open: async (request) => {
        opened.push(request);
        let history: string[] = [];
        if (request.checkpointRef) {
          const opaque = (await owner.readCheckpoint(request.checkpointRef, request)) as {
            providerHash: string;
            nativeSessionToken: string;
            history: string[];
          };
          assert.equal(opaque.providerHash, 'opaque-HASH-unchanged');
          assert.equal(opaque.nativeSessionToken, 'opaque-token-unchanged');
          if (missingNativeHistory) throw new Error('TEST native backing history missing');
          history = opaque.history;
        }
        const session = new ControlledSession(`native-${sessions.length + 1}`, history);
        sessions.push(session);
        return { driver: session, capabilities: ['tools'] };
      },
    };
    const owner = new RuntimeOwner({
      store,
      checkpoints: store,
      driverFactory,
      profileId: 'TEST-profile',
      hostIncarnation,
      authorize: () => true,
      canDispatch: () => true,
      ...overrides,
    });
    return owner;
  };
  t.after(async () => {
    for (const session of sessions) session.events.end();
    await tick();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    sessions,
    opened,
    make,
    loseHistory: () => {
      missingNativeHistory = true;
    },
  };
}
async function complete(
  owner: RuntimeOwner,
  session: ControlledSession,
  id = 'A',
  target = binding()
): Promise<void> {
  await owner.admitDelivery(delivery(id, target));
  await owner.dispatchNext(target);
  session.complete();
  await tick();
}
async function captured(owner: RuntimeOwner, id = 'selected'): Promise<string> {
  const result = await owner.captureCheckpoint({ binding: binding(), checkpointId: id });
  assert.equal(result.status, 'published');
  assert.ok(result.reference);
  return result.reference;
}

test('private payload precedes reference; selected history restores once into a new empty queue after released custody', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  await owner.openSession({ binding: binding(), config: config() });
  const original = f.sessions[0]!;
  await complete(owner, original);
  const reference = await captured(owner);
  const payload = f.store.readCheckpointPayload(reference);
  assert.equal(payload.sourceBinding.generation, 'generation-1');
  assert.equal(payload.sourceConfig.generation, 1);
  assert.deepEqual(
    payload.completedOperations.map((item) => item.inputId),
    ['A']
  );
  assert.deepEqual(
    await owner.captureCheckpoint({ binding: binding(), checkpointId: 'selected' }),
    { checkpointId: 'selected', status: 'published', reference }
  );
  await assert.rejects(
    owner.restoreSession(restoreRequest(reference)),
    held,
    'live source custody must block allocation'
  );
  await owner.admitDelivery(delivery('never-sent'));
  await owner.cancelDelivery(delivery('never-sent'));
  await owner.stopSession(binding());
  assert.equal(original.captures, 1, 'stop reuses a current completed-history snapshot');
  assert.equal(original.closes, 1);
  const restarted = f.make('host-2');
  await assert.rejects(
    restarted.readCheckpoint(reference, { ...config(2), checkpointRef: reference }),
    held,
    'private payload is unavailable before a selected persisted opening intent'
  );
  const restored = await restarted.restoreSession(restoreRequest(reference));
  assert.equal(restored.phase, 'allocated');
  assert.deepEqual(restored.inputs, []);
  assert.equal(restored.config?.generation, 2);
  assert.equal(restored.restoredFrom?.sourceBinding.generation, 'generation-1');
  await restarted.restoreSession(restoreRequest(reference));
  const session = f.sessions[1]!;
  assert.deepEqual(session.history, ['TEST A']);
  await complete(restarted, session, 'B', binding('generation-2'));
  assert.deepEqual(session.history, ['TEST A', 'TEST B']);
  assert.equal(original.submits.length, 1);
  assert.equal(session.submits.length, 1);
  assert.equal(f.opened.length, 2);
  assert.ok(
    !JSON.stringify(owner.lookupCheckpoint(binding(), 'selected')).includes('opaque-token')
  );
});

test('idle waiting releases the member fence and stop with unsupported capture still closes once', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  await owner.openSession({ binding: binding(), config: config() });
  const session = f.sessions[0]!;
  await owner.admitDelivery(delivery('active'));
  await owner.dispatchNext(binding());
  const pending = owner.captureCheckpoint({ binding: binding(), checkpointId: 'after-idle' });
  assert.equal(session.captures, 0);
  await owner.admitDelivery(delivery('queued'));
  session.complete();
  await tick();
  const checkpoint = await pending;
  assert.equal(checkpoint.status, 'published');
  const reference = checkpoint.reference;
  assert.ok(reference);
  assert.equal(session.captures, 1);
  await owner.cancelDelivery(delivery('queued'));
  await owner.stopSession(binding());
  assert.equal(session.closes, 1);
  const restored = f.make('host-2');
  await restored.restoreSession(restoreRequest(reference));
  const next = f.sessions[1]!;
  next.supported = false;
  const stopped = await restored.stopSession(binding('generation-2'));
  assert.equal(stopped.custody, 'released');
  assert.equal(next.closes, 1);
  assert.equal(next.captures, 1);
  assert.equal(stopped.checkpoints?.[0]?.status, 'unsupported');
  const withoutStorage = new RuntimeOwner({
    store: f.store,
    driverFactory: {
      open: async () => {
        throw new Error('TEST must not allocate');
      },
    },
    profileId: 'TEST-profile',
    hostIncarnation: 'host-3',
    authorize: () => true,
  });
  assert.equal(
    (await withoutStorage.captureCheckpoint({ binding: binding(), checkpointId: 'no-storage' }))
      .status,
    'unsupported'
  );
});

for (const point of ['before-payload', 'before-reference', 'after-reference'] as const) {
  test(`capture fault ${point} never recaptures or auto-selects an orphan`, async (t) => {
    const f = await setup(t);
    let injected = false;
    const storage: CheckpointStorage = {
      readCheckpointPayload: (ref) => f.store.readCheckpointPayload(ref),
      writeCheckpoint: (payload) => {
        if (injected && point === 'before-payload') {
          injected = false;
          throw new Error('TEST crash before payload');
        }
        f.store.writeCheckpoint(payload);
      },
    };
    const faultStore: RuntimeStore = {
      fenced: (target, action) =>
        f.store.fenced(target, (tx) =>
          action({
            ...tx,
            put(record, purpose) {
              const publication = record.checkpoints?.some((item) => item.status === 'published');
              if (injected && publication && point === 'before-reference') {
                injected = false;
                throw new Error('TEST crash before reference');
              }
              tx.put(record, purpose);
              if (injected && publication && point === 'after-reference') {
                injected = false;
                throw new Error('TEST lost publication response');
              }
            },
          })
        ),
    };
    const owner = f.make('host-1', { store: faultStore, checkpoints: storage });
    await owner.openSession({ binding: binding(), config: config() });
    const session = f.sessions[0]!;
    await complete(owner, session);
    injected = true;
    const result = await owner.captureCheckpoint({ binding: binding(), checkpointId: 'fault' });
    assert.equal(result.status, point === 'after-reference' ? 'published' : 'held');
    assert.equal(session.captures, 1);
    const restarted = f.make('host-2');
    assert.deepEqual(
      await restarted.captureCheckpoint({ binding: binding(), checkpointId: 'fault' }),
      result
    );
    assert.equal(session.captures, 1);
    const reference = `cp1-${runtimeDigest({ binding: binding(), checkpointId: 'fault' })}`;
    if (point === 'before-payload')
      assert.throws(() => f.store.readCheckpointPayload(reference), held);
    else assert.equal(f.store.readCheckpointPayload(reference).reference, reference);
    if (point !== 'after-reference') {
      await owner.stopSession(binding());
      await assert.rejects(restarted.restoreSession(restoreRequest(reference)), held);
      assert.equal(f.opened.length, 1);
    }
  });
}

test('later completed or uncertain native input blocks the older selected reference even after confirmed close', async (t) => {
  for (const later of ['completed', 'uncertain'] as const) {
    const f = await setup(t);
    const owner = f.make();
    await owner.openSession({ binding: binding(), config: config() });
    const session = f.sessions[0]!;
    await complete(owner, session);
    const reference = await captured(owner);
    session.uncertain = later === 'uncertain';
    await owner.admitDelivery(delivery('later'));
    await owner.dispatchNext(binding());
    if (later === 'completed') {
      session.complete();
      await tick();
    }
    assert.equal((await owner.stopSession(binding())).custody, 'released');
    await assert.rejects(f.make('host-2').restoreSession(restoreRequest(reference)), held);
    assert.equal(f.opened.length, 1);
  }
});

test('known-not-sent and cancelled inputs never appear as executed checkpoint history', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  await owner.openSession({ binding: binding(), config: config() });
  const session = f.sessions[0]!;
  await complete(owner, session);
  const reference = await captured(owner);
  session.knownNotSent = true;
  await owner.admitDelivery(delivery('not-sent'));
  await owner.dispatchNext(binding());
  await owner.cancelDelivery(delivery('cancelled'));
  await owner.stopSession(binding());
  await f.make('host-2').restoreSession(restoreRequest(reference));
  assert.deepEqual(f.sessions[1]?.history, ['TEST A']);
  assert.deepEqual(
    f.store.readCheckpointPayload(reference).completedOperations.map((item) => item.inputId),
    ['A']
  );
});

test('incompatible selected config is rejected before allocation; missing native history is one held opening without fallback', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  await owner.openSession({ binding: binding(), config: config() });
  await complete(owner, f.sessions[0]!);
  const reference = await captured(owner);
  await owner.stopSession(binding());
  const restarted = f.make('host-2');
  await assert.rejects(
    restarted.restoreSession({
      ...restoreRequest(reference),
      config: { ...config(2), configRevision: 'incompatible' },
    }),
    (error) => error instanceof RuntimeOwnerError && error.code === 'conflict'
  );
  assert.equal(f.opened.length, 1);
  f.loseHistory();
  const result = await restarted.restoreSession(restoreRequest(reference));
  assert.equal(result.phase, 'held');
  assert.equal(result.custody, 'unknown');
  await f.make('host-3').restoreSession(restoreRequest(reference));
  assert.equal(
    f.opened.length,
    2,
    'uncertain restore never opens a fresh fallback or replays the selected open'
  );
  assert.equal(f.sessions.length, 1);
});

for (const corruption of ['missing', 'digest', 'symlink', 'oversize'] as const) {
  test(`selected private checkpoint rejects ${corruption} before new allocation`, async (t) => {
    const f = await setup(t, { maxCheckpointBytes: 4096 });
    const owner = f.make();
    await owner.openSession({ binding: binding(), config: config() });
    const reference = await captured(owner);
    await owner.stopSession(binding());
    const path = join(f.root, 'runtime-checkpoints', `${reference}.json`);
    if (corruption === 'missing') await rm(path);
    if (corruption === 'digest') {
      const payload = JSON.parse(await readFile(path, 'utf8')) as CheckpointPayload;
      payload.opaque = { secret: 'changed' };
      await writeFile(path, JSON.stringify(payload));
    }
    if (corruption === 'symlink') {
      const target = join(f.root, 'TEST-external-payload');
      await rename(path, target);
      await symlink(target, path);
    }
    if (corruption === 'oversize') await writeFile(path, ' '.repeat(4097));
    await assert.rejects(f.make('host-2').restoreSession(restoreRequest(reference)), held);
    assert.equal(f.opened.length, 1);
  });
}

test('state admission reserve preserves accepted interrupt/terminal/stop settlement without deleting receipts', async (t) => {
  const f = await setup(t, { maxStateBytes: 16 * 1024, settlementReserveBytes: 4096 });
  const owner = f.make();
  await owner.openSession({ binding: binding(), config: config() });
  const session = f.sessions[0]!;
  let accepted = 0;
  for (let index = 0; index < 100; index++) {
    try {
      await owner.admitDelivery(delivery(`input-${index}`, binding(), 'x'.repeat(256)));
      accepted++;
    } catch (error) {
      assert.ok(error instanceof RuntimeOwnerError && error.code === 'busy');
      break;
    }
  }
  assert.ok(accepted > 1 && accepted < 100);
  assert.equal(owner.readSession(binding()).record?.inputs.length, accepted);
  await owner.dispatchNext(binding());
  await owner.interrupt(binding(), 'input-0');
  session.complete();
  await tick();
  const stopped = await owner.stopSession(binding());
  assert.equal(stopped.custody, 'released');
  assert.equal(stopped.inputs.length, accepted);
  assert.equal(stopped.inputs[0]?.terminal, 'succeeded');
  assert.equal(stopped.inputs.filter((input) => input.phase === 'cancelled').length, accepted - 1);
  assert.equal(session.closes, 1);
  assert.equal(f.make('host-2').readSession(binding()).record?.inputs.length, accepted);
});

test('crash after durable capture intent cannot retry native capture or dispatch across restart', async (t) => {
  const f = await setup(t);
  let crash = false;
  const faultStore: RuntimeStore = {
    fenced: (target, action) =>
      f.store.fenced(target, (tx) =>
        action({
          ...tx,
          put(record, purpose) {
            tx.put(record, purpose);
            if (crash && record.checkpoints?.some((attempt) => attempt.status === 'capturing')) {
              crash = false;
              throw new Error('TEST crash after durable capture intent');
            }
          },
        })
      ),
  };
  const owner = f.make('host-1', { store: faultStore });
  await owner.openSession({ binding: binding(), config: config() });
  await owner.admitDelivery(delivery('queued'));
  crash = true;
  await assert.rejects(
    owner.captureCheckpoint({ binding: binding(), checkpointId: 'claimed-capture' }),
    /TEST crash/
  );
  assert.equal(f.sessions[0]?.captures, 0);
  assert.equal(
    (
      await f
        .make('host-2')
        .captureCheckpoint({ binding: binding(), checkpointId: 'claimed-capture' })
    ).status,
    'held'
  );
  await assert.rejects(owner.dispatchNext(binding()), held);
  assert.equal(f.sessions[0]?.captures, 0);
  assert.equal(f.sessions[0]?.submits.length, 0);
});

test('failed private payload publication during stop does not skip captured driver cleanup', async (t) => {
  const f = await setup(t);
  const storage: CheckpointStorage = {
    readCheckpointPayload: (reference) => f.store.readCheckpointPayload(reference),
    writeCheckpoint: () => {
      throw new Error('TEST private storage unavailable');
    },
  };
  const owner = f.make('host-1', { checkpoints: storage });
  await owner.openSession({ binding: binding(), config: config() });
  const stopped = await owner.stopSession(binding());
  assert.equal(stopped.custody, 'released');
  assert.equal(stopped.checkpoints?.[0]?.status, 'held');
  assert.equal(stopped.checkpoints?.[0]?.reference, undefined);
  assert.equal(f.sessions[0]?.closes, 1);
  assert.equal(f.sessions[0]?.captures, 1);
});

test(
  'idle capture deadline returns held without capturing or changing the active input',
  { timeout: 10_000 },
  async (t) => {
    const f = await setup(t);
    const owner = f.make('host-1', { checkpointIdleTimeoutMs: 1 });
    await owner.openSession({ binding: binding(), config: config() });
    await owner.admitDelivery(delivery('still-active'));
    await owner.dispatchNext(binding());
    const result = await owner.captureCheckpoint({ binding: binding(), checkpointId: 'timed-out' });
    assert.deepEqual(result, { checkpointId: 'timed-out', status: 'held' });
    assert.equal(f.sessions[0]?.captures, 0);
    assert.equal(f.sessions[0]?.submits.length, 1);
    assert.equal(owner.readSession(binding()).record?.inputs[0]?.phase, 'consumed');
    assert.equal(owner.readSession(binding()).record?.checkpoints, undefined);
  }
);
