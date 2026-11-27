import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamContextReminders } from '../dist/team/TeamContextReminders.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import {
  prepareRuntimeInput,
  preparedInputProof,
  recordContextEpoch,
  validateContextEpochs,
} from '../dist/runtime/inputPreparation.js';
import { deliveryFingerprint, runtimeDigest } from '../dist/runtime/identity.js';
import type { TestContext } from 'node:test';
import type { ContextEpoch, ContextPreparationProof, TeamContextEpoch } from '../dist/team/TeamContextReminders.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { TeamPolicyPort } from '../dist/team/ports.js';
import type { RuntimeInput, RuntimeSessionRecord } from '../dist/runtime/contracts.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const binding = {
  backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
  memberId: 'TEST-alice', generation: '1',
};
const sessionRef = 'TEST-session';
const epoch = (index: number): ContextEpoch => {
  const sourceRef = `TEST-reset-${index}`;
  return { sessionRef, sourceRef, epochId: hash(JSON.stringify({ binding, sessionRef, sourceRef })) };
};

function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-context-retention-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let failWrite: ((name: string) => boolean) | undefined;
  class FaultStore extends TeamOwnerStore {
    override write(name: string, value: unknown): void {
      if (failWrite?.(name)) throw new Error('TEST publication failed');
      super.write(name, value);
    }
  }
  const store = new FaultStore(root, 'test-team');
  const initial: OwnerState = {
    schemaVersion: 1,
    binding: { backendId: binding.backendId, teamId: binding.teamId, teamName: 'test-team' },
    ready: true,
    members: [{ memberId: binding.memberId, name: 'alice', role: 'member',
      delivery: { ...binding, teamName: 'test-team' } }],
    grants: [{ principalId: 'TEST-principal', memberName: 'alice', permissions: ['read'] }],
  };
  store.write('state.json', initial);
  const state = () => store.read<OwnerState>('state.json')!;
  const make = () => new TeamContextReminders({
    store, state,
    policy: { taskBoard: () => ({ listTasks: () => [] }) } as unknown as TeamPolicyPort,
    authorize: () => state().grants[0]!,
  });
  const request = (index: number) => ({
    binding, sessionRef, inputId: `TEST-input-${index}`, operationRef: `TEST-operation-${index}`,
    intentFingerprint: hash(`TEST-original-${index}`), epochs: [] as ContextEpoch[],
    priorProofs: [] as ContextPreparationProof[], workspace: root, maxPrefixBytes: 64 * 1024,
  });
  const reminders = make();
  const represented: ContextPreparationProof[] = [];
  const candidate = (index: number) => {
    const input = request(index);
    const selected = reminders.prepare('TEST-principal', input)!;
    const proof: ContextPreparationProof = {
      schemaVersion: 1, epochIds: selected.epochIds, teamProof: selected.teamProof,
      bindingFingerprint: hash(JSON.stringify(binding)), intentFingerprint: input.intentFingerprint,
      inputId: input.inputId, operationRef: input.operationRef,
      prefixHash: hash(selected.prefix), nativePayloadHash: hash(selected.prefix + 'TEST original'),
    };
    return proof;
  };
  const prepare = (index: number) => {
    const proof = candidate(index);
    reminders.prepared('TEST-principal', binding, proof);
    represented.push(proof);
  };
  const fill = (count: number, represent = true) => {
    for (let index = 1; index <= count; index++) {
      reminders.observe('TEST-principal', binding, epoch(index));
      // Include multi-epoch preparations; one archived row cannot assume that
      // its represented proof describes only that row.
      if (represent && (index % 2 === 0 || index === count)) prepare(index);
    }
  };
  return { root, store, state, make, reminders, request, fill, candidate, prepare, represented,
    fail: (predicate?: (name: string) => boolean) => { failWrite = predicate; } };
}

test('oversized advisory roster requests only current members from the first team_get response', (t) => {
  const f = setup(t);
  const state = f.state();
  state.members[0]!.settings = { role: 'TEST mandatory current role' };
  state.members.push({
    memberId: 'TEST-bob', name: 'bob', role: 'member', settings: { role: '界'.repeat(24_000) },
  });
  f.store.write('state.json', state);
  f.reminders.observe('TEST-principal', binding, epoch(1));
  const prepared = f.reminders.prepare('TEST-principal', f.request(1))!;
  assert.ok(Buffer.byteLength(prepared.prefix) <= 64 * 1024);
  assert.match(prepared.prefix, /members in the first team_get response/u);
  assert.doesNotMatch(prepared.prefix, /nextCursor|follow its .*pages/u);
  assert.match(prepared.prefix, /TEST mandatory current role/u);
});

test('represented Team resets retire exactly while pending resets and original replay survive cold reopen', (t) => {
  const f = setup(t);
  f.fill(126);
  f.reminders.observe('TEST-principal', binding, epoch(127));
  f.reminders.observe('TEST-principal', binding, epoch(128));
  f.make().observe('TEST-principal', binding, epoch(129));
  assert.deepEqual(f.state().contextEpochs?.map((row) => row.epochId), [127, 128, 129].map((i) => epoch(i).epochId));
  const first = f.represented[0]!;
  assert.equal(first.epochIds.length, 2);
  const archived = f.store.read(`context-epochs/${epoch(1).epochId}.json`);
  assert.ok(archived);
  f.make().observe('TEST-principal', binding, epoch(1));
  assert.equal(f.state().contextEpochs?.length, 3);
  const prepared = f.make().prepare('TEST-principal', { ...f.request(130), priorProofs: [first] });
  assert.deepEqual(prepared?.epochIds, [127, 128, 129].map((i) => epoch(i).epochId));
  assert.deepEqual(f.store.read(`context-epochs/${epoch(1).epochId}.json`), archived);
  assert.throws(() => f.make().observe('TEST-principal', binding, {
    ...epoch(1), inputId: 'TEST-other-input', operationRef: 'TEST-other-operation',
  }), /hold/);
  assert.throws(() => f.make().prepare('TEST-principal', {
    ...f.request(131), priorProofs: [{ ...first, nativePayloadHash: '0'.repeat(64) }],
  }), /hold/);
  rmSync(join(f.store.directory, 'context-epochs', `${epoch(1).epochId}.json`));
  assert.throws(() => f.make().prepare('TEST-principal', {
    ...f.request(132), priorProofs: [first],
  }), /hold/);
});

test('Team archive publication and state publication failures preserve original recoverable rows', (t) => {
  const f = setup(t);
  f.fill(128);
  const before = structuredClone(f.state());
  f.fail((name) => name.startsWith('context-epochs/'));
  assert.throws(() => f.make().observe('TEST-principal', binding, epoch(129)), /TEST publication/);
  assert.deepEqual(f.state(), before);
  f.fail((name) => name === 'state.json');
  assert.throws(() => f.make().observe('TEST-principal', binding, epoch(129)), /TEST publication/);
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.store.read(`context-epochs/${epoch(1).epochId}.json`), before.contextEpochs![0]);
  f.fail();
  f.make().observe('TEST-principal', binding, epoch(129));
  assert.deepEqual(f.state().contextEpochs?.map((row) => row.epochId), [epoch(129).epochId]);
  assert.doesNotThrow(() => f.make().prepared('TEST-principal', binding, f.represented[0]!));
});

for (const count of [120, 128]) {
  test(`one preparation for ${count} pending Team resets fits bounded state through exact retirement`, (t) => {
    const f = setup(t);
    f.fill(count, false);
    f.prepare(count);
    const proof = f.represented[0]!;
    assert.equal(proof.epochIds.length, count);
    assert.equal(f.state().contextEpochs?.length, 0);
    assert.deepEqual(f.store.read<TeamContextEpoch>(`context-epochs/${epoch(1).epochId}.json`)?.represented, proof);
    assert.doesNotThrow(() => f.make().prepared('TEST-principal', binding, proof));
    assert.equal(f.make().prepare('TEST-principal', {
      ...f.request(count + 1), epochs: [epoch(1)], priorProofs: [proof],
    }), undefined);
    f.make().observe('TEST-principal', binding, epoch(count + 1));
    assert.deepEqual(f.state().contextEpochs?.map((row) => row.epochId), [epoch(count + 1).epochId]);
  });
}

test('bulk representation recovers partial archives and a lost state write only with its exact original proof', (t) => {
  const f = setup(t);
  f.fill(120, false);
  const proof = f.candidate(120);
  const before = structuredClone(f.state());
  f.fail((name) => name === `context-epochs/${epoch(2).epochId}.json`);
  assert.throws(() => f.make().prepared('TEST-principal', binding, proof), /TEST publication/);
  assert.deepEqual(f.state(), before);
  assert.ok(f.store.read(`context-epochs/${epoch(1).epochId}.json`));
  assert.equal(f.store.read(`context-epochs/${epoch(2).epochId}.json`), undefined);
  assert.throws(() => f.make().observe('TEST-principal', binding, epoch(1)), /hold/);
  assert.throws(() => f.make().prepared('TEST-principal', binding, {
    ...proof, nativePayloadHash: '0'.repeat(64),
  }), /hold/);
  assert.deepEqual(f.state(), before);
  const changed = structuredClone(before);
  changed.contextEpochs![0]!.candidate!.authorityRevision++;
  f.store.write('state.json', changed);
  assert.throws(() => f.make().prepared('TEST-principal', binding, proof), /hold/);
  f.store.write('state.json', before);
  f.fail((name) => name === 'state.json');
  assert.throws(() => f.make().prepared('TEST-principal', binding, proof), /TEST publication/);
  assert.deepEqual(f.state(), before);
  assert.ok(f.store.read(`context-epochs/${epoch(120).epochId}.json`));
  f.fail();
  const input = { ...f.request(121), priorProofs: [proof], epochs: [epoch(121)] };
  const recovered = f.make().prepare('TEST-principal', input)!;
  assert.deepEqual(recovered.epochIds, [epoch(121).epochId]);
  assert.deepEqual(f.state().contextEpochs?.map((row) => row.epochId), [epoch(121).epochId]);
  assert.doesNotThrow(() => f.make().prepared('TEST-principal', binding, proof));
});

test('corrupt or conflicting Team archive is not accepted as reset completion evidence', (t) => {
  const f = setup(t);
  f.fill(128);
  const before = structuredClone(f.state());
  const original = before.contextEpochs![0]!;
  f.store.write(`context-epochs/${original.epochId}.json`, {
    ...original, represented: { ...original.represented!, nativePayloadHash: '0'.repeat(64) },
  });
  assert.throws(() => f.make().observe('TEST-principal', binding, epoch(129)), /hold/);
  assert.deepEqual(f.state(), before);
  f.store.write(`context-epochs/${original.epochId}.json`, { ...original, represented: undefined });
  assert.throws(() => f.make().observe('TEST-principal', binding, epoch(129)), /hold/);
  assert.deepEqual(f.state(), before);
});

test('128 unrepresented Team resets remain a hold and are never retired', (t) => {
  const f = setup(t);
  f.fill(128, false);
  const before = structuredClone(f.state());
  assert.throws(() => f.make().observe('TEST-principal', binding, epoch(129)), /hold/);
  assert.deepEqual(f.state(), before);
  assert.equal(f.store.read(`context-epochs/${epoch(1).epochId}.json`), undefined);
});

test('retired context evidence cannot bypass revoked current member authority', (t) => {
  const f = setup(t);
  f.fill(128);
  f.reminders.observe('TEST-principal', binding, epoch(129));
  const state = f.state();
  state.grants[0]!.revoked = true;
  f.store.write('state.json', state);
  assert.throws(() => f.make().observe('TEST-principal', binding, epoch(1)), /forbidden/);
  assert.throws(() => f.make().prepare('TEST-principal', {
    ...f.request(130), priorProofs: [f.represented[0]!],
  }), /forbidden/);
});

function runtimeRecord(): RuntimeSessionRecord {
  const config = {
    tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: sessionRef,
    generation: 1, configRevision: 'TEST-config', requiredCapabilities: ['tools'],
  };
  const profileId = 'TEST-profile';
  return {
    schemaVersion: 1, binding, profileId, config,
    openFingerprint: runtimeDigest({ profileId, config }), hostIncarnation: 'TEST-host',
    phase: 'allocated', sealed: false, custody: 'owned', nativeReady: true,
    sessionRef, inputs: [], interactions: [],
  };
}

function addPreparation(record: RuntimeSessionRecord, index: number, ids: string[]) {
  const intent = {
    binding, deliveryId: `TEST-input-${index}`, inputId: `TEST-input-${index}`,
    messageId: `TEST-message-${index}`, content: `TEST original ${index}`,
  };
  const input: RuntimeInput = {
    intent, fingerprint: deliveryFingerprint(intent), operationRef: `TEST-operation-${index}`,
    phase: 'terminal', terminal: 'succeeded',
  };
  input.preparation = prepareRuntimeInput(binding, input, {
    epochIds: ids, prefix: `TEST standing context ${index}\n`, teamProof: hash(`TEST proof ${index}`),
  }, 64 * 1024);
  record.inputs.push(input);
  return input;
}

test('Runtime retires only prepared resets into their original input ledger and validates them on cold read', (t) => {
  const f = setup(t), record = runtimeRecord();
  for (let index = 1; index <= 128; index++) {
    recordContextEpoch(record, epoch(index));
    if (index % 2 === 0) addPreparation(record, index, [epoch(index - 1).epochId, epoch(index).epochId]);
  }
  const fingerprints = record.inputs.map((input) => [input.fingerprint, preparedInputProof(input.preparation!)]);
  recordContextEpoch(record, epoch(129));
  assert.deepEqual(record.contextEpochs, [epoch(129)]);
  assert.equal(record.inputs.flatMap((input) => input.representedContextEpochs ?? []).length, 128);
  assert.deepEqual(record.inputs.map((input) => [input.fingerprint, preparedInputProof(input.preparation!)]), fingerprints);
  const store = new FileRuntimeStore(f.root);
  store.fenced(binding, (tx) => tx.put(record));
  const cold = new FileRuntimeStore(f.root).fenced(binding, (tx) => tx.get()!);
  assert.deepEqual(cold, record);
  recordContextEpoch(cold, epoch(1));
  assert.deepEqual(cold.contextEpochs, [epoch(129)]);
  assert.throws(() => recordContextEpoch(cold, {
    ...epoch(1), inputId: cold.inputs[0]!.intent.inputId, operationRef: cold.inputs[0]!.operationRef,
  }), /hold/);
  for (const corrupt of [
    (value: RuntimeSessionRecord) => { value.inputs[0]!.representedContextEpochs![0]!.sourceRef = 'TEST forged'; },
    (value: RuntimeSessionRecord) => { value.inputs[0]!.representedContextEpochs = [epoch(129)]; },
    (value: RuntimeSessionRecord) => { value.contextEpochs!.push(epoch(1)); },
    (value: RuntimeSessionRecord) => { value.inputs[0]!.representedContextEpochs!.push(epoch(1)); },
    (value: RuntimeSessionRecord) => { value.inputs[0]!.representedContextEpochs = Array(129).fill(epoch(1)); },
  ]) {
    const changed = structuredClone(cold);
    corrupt(changed);
    assert.throws(() => store.fenced(binding, (tx) => tx.put(changed)), /hold/);
    assert.deepEqual(store.fenced(binding, (tx) => tx.get()), record);
  }
});

test('Runtime preserves pending resets and uncertain input phases when retiring prior preparations', () => {
  const record = runtimeRecord();
  for (let index = 1; index <= 128; index++) recordContextEpoch(record, epoch(index));
  assert.throws(() => recordContextEpoch(record, epoch(129)), /hold/);
  assert.equal(record.contextEpochs?.length, 128);
  const input = addPreparation(record, 1, [epoch(1).epochId]);
  input.phase = 'unknown';
  delete input.terminal;
  recordContextEpoch(record, epoch(129));
  assert.equal(record.contextEpochs?.length, 128);
  assert.deepEqual(input.representedContextEpochs, [epoch(1)]);
  assert.equal(input.phase, 'unknown');
  assert.doesNotThrow(() => validateContextEpochs(record));
});

test('retired reset may originate in an earlier input than its durable preparation', () => {
  const record = runtimeRecord();
  const earlier = addPreparation(record, 0, [epoch(1000).epochId]);
  const original = { ...epoch(1), inputId: earlier.intent.inputId, operationRef: earlier.operationRef };
  recordContextEpoch(record, original);
  for (let index = 2; index <= 128; index++) recordContextEpoch(record, epoch(index));
  const later = addPreparation(record, 1, [original.epochId]);
  recordContextEpoch(record, epoch(129));
  assert.deepEqual(later.representedContextEpochs, [original]);
  assert.notEqual(original.inputId, later.intent.inputId);
  assert.doesNotThrow(() => validateContextEpochs(record));
});
