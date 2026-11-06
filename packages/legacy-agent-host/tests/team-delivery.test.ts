import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';

import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { JsonValue } from '../dist/contracts.js';
import type {
  DeliveryAdmission,
  DeliveryIntent,
  TeamRuntimeDeliveryPort,
} from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(t: TestContext, makeStore?: (root: string) => TeamOwnerStore) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-delivery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const store = makeStore?.(root) ?? new TeamOwnerStore(root, binding.teamName);
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    store,
    members: [
      {
        memberId: 'alice-id',
        name: 'alice',
        role: 'member',
        delivery: {
          ...binding,
          runId: 'TEST-run',
          memberId: 'alice-id',
          generation: '1',
        },
      },
    ],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'admin'] },
      { principalId: 'admin', memberName: 'user', permissions: ['read', 'admin'] },
      { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'message.write'] },
    ],
  };
  const owner = createFilesystemTeamOwner(options);
  const human = owner.connect('human');
  function commit(commandId = 'message') {
    return human.execute({
      commandId,
      operation: 'message.send',
      payload: {
        to: 'alice',
        text: `Original content ${commandId}`,
        taskRefs: [],
      },
    });
  }
  function outbox(intent: DeliveryIntent): DeliveryIntent {
    return store.read<DeliveryIntent>(`outbox/${intent.deliveryId}.json`)!;
  }
  return { root, store, options, owner, human, commit, outbox };
}

/** Controlled Runtime boundary persists admission proof on real TEST files. No native submit exists. */
class DurableRuntime implements TeamRuntimeDeliveryPort {
  readonly fingerprintDelivery = deliveryFingerprint;
  lookups = 0;
  admissions = 0;
  accepted = 0;
  loseAck = false;
  beforeLookup: (() => Promise<void>) | undefined;
  beforeAdmit: (() => Promise<void>) | undefined;
  lookupOverride: ((intent: DeliveryIntent) => DeliveryAdmission) | undefined;

  readonly root: string;
  readonly authorized: (intent: DeliveryIntent) => boolean;

  constructor(root: string, authorized: (intent: DeliveryIntent) => boolean) {
    this.root = root;
    this.authorized = authorized;
  }

  proof(
    intent: DeliveryIntent,
    phase = 'admitted',
    outcome: DeliveryAdmission['outcome'] = 'admitted'
  ): DeliveryAdmission {
    const { backendId, teamId, runId, memberId, generation } = intent.binding;
    return {
      inputId: intent.inputId,
      outcome,
      receipt: {
        schemaVersion: 1,
        inputId: intent.inputId,
        binding: { backendId, teamId, runId, memberId, generation },
        fingerprint: deliveryFingerprint(intent),
        operationRef: `operation-${intent.inputId}`,
        phase,
      },
    };
  }

  private records(): Record<string, DeliveryAdmission> {
    try {
      return JSON.parse(readFileSync(join(this.root, 'runtime-proofs.json'), 'utf8')) as Record<
        string,
        DeliveryAdmission
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  persist(intent: DeliveryIntent, proof: DeliveryAdmission): void {
    writeFileSync(
      join(this.root, 'runtime-proofs.json'),
      JSON.stringify({ ...this.records(), [intent.inputId]: proof })
    );
  }

  async lookupDelivery(intent: DeliveryIntent): Promise<DeliveryAdmission> {
    this.lookups++;
    await this.beforeLookup?.();
    return (
      this.lookupOverride?.(intent) ??
      this.records()[intent.inputId] ?? { inputId: intent.inputId, outcome: 'not_admitted' }
    );
  }

  async admitDelivery(intent: DeliveryIntent): Promise<DeliveryAdmission> {
    this.admissions++;
    await this.beforeAdmit?.();
    // Mirrors Runtime's current-authority callback immediately before durable admission.
    if (!this.authorized(intent)) throw new Error('TEST current authority rejected admission');
    const prior = this.records()[intent.inputId];
    if (prior) return prior;
    const proof = this.proof(intent);
    this.persist(intent, proof);
    this.accepted++;
    if (this.loseAck) {
      this.loseAck = false;
      throw new Error('TEST response lost after durable admission');
    }
    return proof;
  }
}

test('startup scans pending outbox after completed business commits without replaying UI/MCP handlers', async (t) => {
  const f = fixture(t);
  const first = f.commit('one');
  f.commit('two');
  const before = readFileSync(join(f.root, 'teams/test-team/inboxes/alice.json'), 'utf8');
  const restarted = createFilesystemTeamOwner(f.options);
  const runtime = new DurableRuntime(f.root, (intent) => restarted.authorizeDeliveryIntent(intent));
  const results = await restarted.resumeDeliveries(runtime);
  assert.deepEqual(
    results.map((result) => result.outcome),
    ['admitted', 'admitted']
  );
  assert.equal(runtime.lookups, 2);
  assert.equal(runtime.admissions, 2);
  assert.equal(runtime.accepted, 2);
  assert.deepEqual(restarted.connect('human').pendingDeliveries(), []);
  assert.equal(readFileSync(join(f.root, 'teams/test-team/inboxes/alice.json'), 'utf8'), before);
  assert.deepEqual(
    restarted.connect('human').lookup('one'),
    first,
    'business receipt remains independent'
  );
});

test('lost Runtime ACK is reconciled by original-ID lookup, without replacement admission', async (t) => {
  const f = fixture(t);
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  const runtime = new DurableRuntime(f.root, (input) => f.owner.authorizeDeliveryIntent(input));
  runtime.loseAck = true;
  assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'held');
  assert.equal(f.outbox(intent).phase, 'pending');
  const originalProof = JSON.parse(
    readFileSync(join(f.root, 'runtime-proofs.json'), 'utf8')
  ) as Record<string, DeliveryAdmission>;
  assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'admitted');
  assert.equal(runtime.admissions, 1);
  assert.equal(runtime.accepted, 1);
  assert.deepEqual(f.outbox(intent).runtimeReceipt, originalProof[intent.inputId]?.receipt);
  assert.equal(f.outbox(intent).inputId, intent.inputId);
});

class FailAckOnce extends TeamOwnerStore {
  fail = true;
  override write(name: string, value: unknown): void {
    if (this.fail && name.startsWith('outbox/') && (value as DeliveryIntent).phase === 'admitted') {
      this.fail = false;
      throw new Error('TEST failed local ACK write');
    }
    super.write(name, value);
  }
}

test('failed Team ACK write and owner reopen retain Runtime proof and never admit twice', async (t) => {
  const f = fixture(t, (root) => new FailAckOnce(root, 'test-team'));
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  const runtime = new DurableRuntime(f.root, (input) => f.owner.authorizeDeliveryIntent(input));
  assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'held');
  assert.equal(f.outbox(intent).phase, 'pending');
  const restarted = createFilesystemTeamOwner({
    ...f.options,
    store: new TeamOwnerStore(f.root, 'test-team'),
  });
  assert.equal((await restarted.resumeDeliveries(runtime))[0]?.outcome, 'admitted');
  assert.equal(runtime.admissions, 1);
  assert.equal(runtime.lookups, 2);
});

test('UNKNOWN lookup remains pending and never becomes automatic admission', async (t) => {
  const f = fixture(t);
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  const before = JSON.stringify(f.outbox(intent));
  const runtime = new DurableRuntime(f.root, () => true);
  runtime.lookupOverride = (input) => ({ inputId: input.inputId, outcome: 'unknown' });
  for (let i = 0; i < 2; i++)
    assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'pending');
  assert.equal(runtime.admissions, 0);
  assert.equal(JSON.stringify(f.outbox(intent)), before);
});

test('same input ID with wrong binding/fingerprint cannot ACK the original outbox', async (t) => {
  const f = fixture(t);
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  const runtime = new DurableRuntime(f.root, () => true);
  runtime.lookupOverride = (input) =>
    runtime.proof({ ...input, binding: { ...input.binding, backendId: 'other-backend' } });
  assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'held');
  assert.equal(f.outbox(intent).phase, 'pending');
  runtime.lookupOverride = (input) => runtime.proof({ ...input, content: 'different content' });
  assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'held');
  assert.equal(runtime.admissions, 0);
  assert.equal(f.outbox(intent).runtimeReceipt, undefined);
});

test('cancelled tombstone produces truthful not-admitted outbox and is never resurrected', async (t) => {
  const f = fixture(t);
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  const runtime = new DurableRuntime(f.root, () => true);
  runtime.persist(intent, runtime.proof(intent, 'cancelled', 'not_admitted'));
  assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'not_admitted');
  assert.equal(f.outbox(intent).phase, 'not_admitted');
  assert.equal(runtime.admissions, 0);
  assert.deepEqual(await f.owner.resumeDeliveries(runtime), []);
  assert.equal(runtime.lookups, 1);
});

test('durable admission of known-not-sent handoff is ACKed without claiming native consumption', async (t) => {
  const f = fixture(t);
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  const runtime = new DurableRuntime(f.root, () => true);
  runtime.persist(intent, runtime.proof(intent, 'not-sent'));
  assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'admitted');
  assert.equal((f.outbox(intent).runtimeReceipt as Record<string, JsonValue>).phase, 'not-sent');
  assert.equal(runtime.admissions, 0);
});

test('concurrent reconnect resumption shares one owner operation and releases the Team fence during lookup', async (t) => {
  const f = fixture(t);
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  const gate = deferred();
  const runtime = new DurableRuntime(f.root, (input) => f.owner.authorizeDeliveryIntent(input));
  runtime.beforeLookup = () => gate.promise;
  const first = f.owner.resumeDeliveries(runtime);
  const duplicate = f.owner.resumeDeliveries(runtime);
  assert.equal(first, duplicate);
  assert.equal(runtime.lookups, 1);
  // This same-authority mutation must finish while the Runtime await is unresolved.
  f.owner.connect('admin').revoke('human');
  gate.resolve();
  assert.equal((await first)[0]?.outcome, 'held');
  assert.equal(runtime.admissions, 0);
  assert.equal(f.outbox(intent).phase, 'pending');
});

test('grant revision or recipient generation changes during lookup prevent stale ACK publication', async (t) => {
  for (const change of ['grant-revision', 'recipient-generation']) {
    const f = fixture(t);
    f.commit();
    const intent = f.human.pendingDeliveries()[0]!;
    const runtime = new DurableRuntime(f.root, () => true);
    const gate = deferred();
    runtime.beforeLookup = () => gate.promise;
    runtime.persist(intent, runtime.proof(intent));
    const resumed = f.owner.resumeDeliveries(runtime);
    f.store.fenced(() => {
      const state = f.store.read<{
        grants: { principalId: string; revision: number }[];
        members: { name: string; delivery: { generation: string } }[];
      }>('state.json')!;
      if (change === 'grant-revision')
        state.grants.find((grant) => grant.principalId === 'human')!.revision++;
      else state.members.find((member) => member.name === 'alice')!.delivery.generation = '2';
      f.store.write('state.json', state);
    });
    gate.resolve();
    assert.equal((await resumed)[0]?.outcome, 'held', change);
    assert.equal(f.outbox(intent).phase, 'pending');
    assert.equal(runtime.admissions, 0);
    assert.equal(f.owner.authorizeDeliveryIntent(intent), false);
  }
});

test('revoke after proven absence is rechecked at Runtime admission before effects', async (t) => {
  const f = fixture(t);
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  const entered = deferred();
  const gate = deferred();
  const runtime = new DurableRuntime(f.root, (input) => f.owner.authorizeDeliveryIntent(input));
  runtime.beforeAdmit = () => {
    entered.resolve();
    return gate.promise;
  };
  const resumed = f.owner.resumeDeliveries(runtime);
  await entered.promise;
  f.owner.connect('admin').revoke('human');
  gate.resolve();
  assert.equal((await resumed)[0]?.outcome, 'held');
  assert.equal(runtime.accepted, 0);
  assert.equal(f.outbox(intent).phase, 'pending');
});

test('corrupted pending binding cannot be adopted or passed to Runtime by matching display IDs', async (t) => {
  const f = fixture(t);
  f.commit();
  const intent = f.human.pendingDeliveries()[0]!;
  f.store.fenced(() =>
    f.store.write(`outbox/${intent.deliveryId}.json`, {
      ...intent,
      binding: { ...intent.binding, generation: '2' },
    })
  );
  const runtime = new DurableRuntime(f.root, () => true);
  assert.equal((await f.owner.resumeDeliveries(runtime))[0]?.outcome, 'held');
  assert.equal(runtime.lookups, 0);
  assert.equal(runtime.admissions, 0);
});
