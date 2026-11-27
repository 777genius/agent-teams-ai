import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { createHostTeamLifecycleComposition } from '../dist/composition/createHostTeamLifecycleComposition.js';
import { createRuntimeLifecyclePorts } from '../dist/composition/createRuntimeLifecyclePorts.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { HostOutput } from '../dist/output.js';
import { DEFAULT_HOST_LIMITS } from '../dist/contracts.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';
import type { JsonValue, HostCloseReason } from '../dist/contracts.js';
import type { RuntimeBinding, RuntimeTransaction } from '../dist/runtime/contracts.js';
import type { DeliveryIntent } from '../dist/team/contracts.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-queue-pages-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writes: string[] = [];
  class Store extends TeamOwnerStore {
    override write(name: string, value: unknown): void { writes.push(name); super.write(name, value); }
  }
  const runtimeWrites: RuntimeBinding[] = [];
  class RuntimeStore extends FileRuntimeStore {
    override fenced<T>(binding: RuntimeBinding, action: (transaction: RuntimeTransaction) => T): T {
      return super.fenced(binding, tx => action({ ...tx, put(record, purpose) {
        runtimeWrites.push(binding); tx.put(record, purpose);
      } }));
    }
  }
  const profile = { principalId: 'human', owner: { ownerId: 'TEST-owner', revision: 'TEST-revision', storageRoot: root,
    profileId: 'TEST-profile', protocolVersion: 1 as const, buildId: 'TEST-build', nodeSha256: '0'.repeat(64), hostEntrySha256: '0'.repeat(64) } };
  const binding = { backendId: profile.owner.ownerId, teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const deliveryBinding = { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' };
  const definition = {
    binding, scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: binding.teamId,
      runId: deliveryBinding.runId, memberId: 'human', generation: '1' },
    members: [{ memberId: 'alice-id', name: 'alice', role: 'lead', delivery: deliveryBinding }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'message.write'] },
      { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'message.write'] }],
  } satisfies HostedTeam['definition'];
  const store = new Store(root, binding.teamName);
  const owner = createFilesystemTeamOwner({ root, store, binding, members: definition.members, grants: definition.grants });
  const connection = owner.connect(profile.principalId), team: HostedTeam = { definition, owner, connection };
  const runtimeStore = new RuntimeStore(root);
  let opens = 0, current = true;
  const runtime = new RuntimeOwner({ store: runtimeStore, profileId: profile.owner.profileId, hostIncarnation: 'TEST-host',
    driverFactory: { async open() { opens++; throw new Error('Queue inventory cannot open a native session'); } },
    authorize: (target, action, intent) => intent ? owner.authorizeDeliveryIntent(intent, action) : owner.authorizeMemberBinding(target, action),
    canDispatch: () => false });
  const delivery = { fingerprintDelivery: runtime.fingerprintDelivery.bind(runtime), admitDelivery: runtime.admitDelivery.bind(runtime),
    lookupDelivery: runtime.lookupDelivery.bind(runtime), cancelDelivery: runtime.cancelDelivery.bind(runtime) };
  const assertCurrent = () => { if (!current) throw new TeamOwnerError('hold'); };
  const create = (principalId = profile.principalId) => createHostTeamLifecycleComposition({ profile: { ...profile, principalId }, teams: new Map([[binding.teamId, team]]),
    runtime: () => ({ lifecyclePorts: () => createRuntimeLifecyclePorts({ runtime, delivery, entries: new Map(),
      assertWriter: assertCurrent, closeEndpoint: async () => undefined }) }), importer: () => undefined,
    assertCurrent, assertWriter: assertCurrent, isShuttingDown: () => false });
  const lifecycle = create();
  lifecycle.stores.set(binding.teamId, store);
  const inputBinding = { schemaVersion: 1, handleId: 'TEST-queue-handle', owner: profile.owner, scope: definition.scope };
  const call = async (method: string, payload: JsonValue, selected = inputBinding, composition = lifecycle) => {
    const result = await composition.methods[method]!.handle({ commandId: 'TEST-queue-read', binding: selected, payload },
      { requestId: 'TEST-queue-read', signal: new AbortController().signal });
    return row(result);
  };
  const enqueue = async (index: number, text = 'TEST queued message') => {
    const receipt = connection.execute({ commandId: 'TEST-message-' + index, operation: 'message.send',
      payload: { to: 'alice', text, messageId: 'TEST-message-' + index } });
    assert.equal(receipt.phase, 'completed');
    const intent = store.read<DeliveryIntent>('outbox/' + receipt.effects.deliveryId + '.json')!;
    await runtime.admitDelivery(intent);
    return intent;
  };
  return { root, store, owner, connection, runtime, runtimeStore, delivery, lifecycle, create, inputBinding,
    call, enqueue, writes, runtimeWrites, opens: () => opens, invalidate: () => { current = false; } };
}

test('30 accepted 40k queued messages fit the actual Host priority response without rewriting original inputs', async t => {
  const f = fixture(t), text = 'TEST original '.padEnd(40_000, 'x');
  const intents: DeliveryIntent[] = [];
  for (let index = 0; index < 30; index++) intents.push(await f.enqueue(index, text));
  const inboxPath = join(f.root, 'teams/TEST-team/inboxes/alice.json');
  const beforeInbox = readFileSync(inboxPath), beforeInputs = structuredClone(f.runtime.readCapturedSession(intents[0]!.binding).record);
  const writes = [...f.writes], runtimeWrites = [...f.runtimeWrites];
  const result = await f.call('team.queue.read', { member: 'alice' });
  assert.equal(result.ok, true);
  const frames: Buffer[] = [], closed: HostCloseReason[] = [];
  const output = new HostOutput(new Writable({ write(chunk, _encoding, callback) { frames.push(Buffer.from(chunk)); callback(); } }),
    DEFAULT_HOST_LIMITS, reason => { closed.push(reason); });
  t.after(() => output.stop());
  const accepted = output.sendPriority({ jsonrpc: '2.0', id: 'TEST-queue-read', result: result as JsonValue });
  assert.equal(accepted, true, 'the real queue read response must not close Host with priority_overflow: ' + JSON.stringify(closed));
  assert.deepEqual(closed, []); assert.equal(frames.length, 1);
  assert.ok(frames[0]!.length < DEFAULT_HOST_LIMITS.maxFrameBytes);
  assert.deepEqual(row(result.value).messages, intents.map(intent => ({ messageId: intent.messageId })));
  assert.deepEqual(readFileSync(inboxPath), beforeInbox);
  assert.deepEqual(f.runtime.readCapturedSession(intents[0]!.binding).record, beforeInputs);
  assert.deepEqual(f.writes, writes); assert.deepEqual(f.runtimeWrites, runtimeWrites);
  assert.equal(f.opens(), 0);
  const later = await f.enqueue(30, 'TEST arrived after confirmation inventory');
  const discarded = await f.call('team.queue.discard', { member: 'alice', messageIds: intents.map(intent => intent.messageId) });
  assert.equal(discarded.ok, true);
  assert.equal(row(discarded.value).discarded, 30);
  assert.deepEqual((await f.owner.queuedMessages('human', f.delivery).list('alice')).messages.map(message => message.messageId), [later.messageId]);
  for (const intent of intents) assert.equal(f.store.read<DeliveryIntent>('outbox/' + intent.deliveryId + '.json')!.content, intent.content);
  assert.equal(f.opens(), 0);
});

test('Host queue cursors retain original handle, owner, scope, member, principal and current admin revision', async t => {
  const f = fixture(t);
  // The owner still performs its real queue read and authorization. Only this large read result is controlled.
  const queued = f.owner.queuedMessages.bind(f.owner);
  const messages = Array.from({ length: 513 }, (_, index) => ({ messageId: 'TEST-inventory-' + index,
    text: 'TEST retained ' + index, timestamp: '2026-11-27T00:00:00.000Z' }));
  f.owner.queuedMessages = (...args) => {
    const queue = queued(...args);
    return { ...queue, async list(member) { await queue.list(member); return { member, messages }; } };
  };
  const first = await f.call('team.queue.read', { member: 'alice' }); assert.equal(first.ok, true);
  const cursor = row(first.value).nextCursor; assert.equal(typeof cursor, 'string');
  const payload = { member: 'alice', cursor: cursor as string };
  assert.equal((await f.call('team.queue.read', payload)).ok, true);
  for (const changed of [
    { ...f.inputBinding, handleId: 'TEST-other-handle' },
    { ...f.inputBinding, owner: { ...f.inputBinding.owner, revision: 'TEST-other-owner' } },
    { ...f.inputBinding, scope: { ...f.inputBinding.scope, workspaceId: 'TEST-other-workspace' } },
  ]) assert.equal((await f.call('team.queue.read', payload, changed)).ok, false);
  assert.equal((await f.call('team.queue.read', { ...payload, member: 'bob' })).ok, false);
  assert.equal((await f.call('team.queue.read', payload, f.inputBinding, f.create())).ok, false);
  const state = f.store.read<OwnerState>('state.json')!;
  state.grants.push({ ...state.grants.find(grant => grant.principalId === 'human')!, principalId: 'TEST-other-admin' });
  f.store.write('state.json', state);
  assert.equal((await f.call('team.queue.read', payload, f.inputBinding, f.create('TEST-other-admin'))).ok, false);
  const grant = state.grants.find(grant => grant.principalId === 'human')!;
  grant.revision = (grant.revision ?? 1) + 1;
  f.store.write('state.json', state);
  assert.equal((await f.call('team.queue.read', payload)).ok, false);
  assert.equal(f.opens(), 0);
});

test('one eligible raw message can exceed a whole-row page after JSON escaping while its exact native input fits', async t => {
  const f = fixture(t), text = 'TEST original ' + '\u0001'.repeat(60_000);
  const receipt = f.connection.execute({ commandId: 'TEST-one-escaped-message', operation: 'message.send',
    payload: { to: 'alice', text, messageId: 'TEST-one-escaped-message' } });
  assert.equal(receipt.phase, 'completed');
  const intent = f.store.read<DeliveryIntent>('outbox/' + receipt.effects.deliveryId + '.json')!;
  assert.ok(Buffer.byteLength(intent.content) < 64 * 1024);
  const original = await f.owner.queuedMessages('human', f.delivery).list('alice');
  assert.ok(Buffer.byteLength(JSON.stringify(original.messages[0])) > 240 * 1024);
  assert.equal(original.messages[0]!.text, text);
  const beforeInbox = readFileSync(join(f.root, 'teams/TEST-team/inboxes/alice.json'));
  const writes = [...f.writes], runtimeWrites = [...f.runtimeWrites];
  const result = await f.call('team.queue.read', { member: 'alice' });
  assert.equal(result.ok, true);
  assert.deepEqual(row(result.value).messages, [{ messageId: intent.messageId }]);
  assert.deepEqual(readFileSync(join(f.root, 'teams/TEST-team/inboxes/alice.json')), beforeInbox);
  assert.deepEqual(f.writes, writes); assert.deepEqual(f.runtimeWrites, runtimeWrites);
  assert.equal(f.runtime.readCapturedSession(intent.binding).record, undefined); assert.equal(f.opens(), 0);
});

for (const change of ['revoke', 'revision', 'context'] as const) {
  test(`queue inventory refuses ${change} during an awaited real Runtime lookup`, async t => {
    const f = fixture(t); await f.enqueue(0);
    const lookup = f.delivery.lookupDelivery;
    f.delivery.lookupDelivery = async intent => {
      const proof = await lookup(intent);
      if (change === 'context') f.invalidate();
      else {
        const state = f.store.read<OwnerState>('state.json')!, grant = state.grants.find(value => value.principalId === 'human')!;
        if (change === 'revoke') grant.revoked = true;
        else grant.revision = (grant.revision ?? 1) + 1;
        f.store.write('state.json', state);
      }
      return proof;
    };
    const result = await f.call('team.queue.read', { member: 'alice' });
    assert.equal(result.ok, false); assert.equal(result.outcome, 'not-dispatched');
    assert.equal(result.value, undefined); assert.equal(f.opens(), 0);
  });
}
