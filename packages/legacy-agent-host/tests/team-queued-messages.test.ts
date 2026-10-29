import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { teamCommandPath } from '../dist/team/commandEntries.js';
import { readFileSync } from 'node:fs';
import { AttachmentArtifactStore } from '../dist/attachments/AttachmentArtifactStore.js';
import { mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { OwnerBackupResourceAccess } from '../dist/adapters/lifecycle/OwnerBackupResourceAccess.js';
import { memberBinding } from '../dist/team/DeliveryRecovery.js';
import { assertRosterEditable } from '../dist/composition/teamRoster.js';
import type { MemberEntry } from '../dist/composition/MemberEntry.js';
import type { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import type { DeliveryIntent, TeamGrant } from '../dist/team/contracts.js';
function fixture(t: import('node:test').TestContext, rich = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-owned-queue-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const selected = { ...binding, runId: 'TEST-run', memberId: 'alice', generation: '1' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const owner = createFilesystemTeamOwner({ root, binding, store,
    members: [{ memberId: 'lead', name: 'team-lead', role: 'lead' }, { memberId: 'alice', name: 'alice', role: 'member', delivery: selected }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'message.write', 'admin'] },
      { principalId: 'alice', memberName: 'alice', permissions: ['read', 'message.write'] }] });
  const artifacts = new AttachmentArtifactStore(root, binding, store);
  const refs = rich ? ['TEST-z-first', 'TEST-a-second'].map(id => {
    const bytes = Buffer.from(id);
    const uploaded = artifacts.upload({ uploadId: id, purpose: { kind: 'message', member: 'alice' },
      attachment: { id, filename: id + '.txt', mimeType: 'text/plain', size: bytes.length },
      digest: createHash('sha256').update(bytes).digest('hex'), offset: 0, base64: bytes.toString('base64') });
    assert.ok(uploaded.reference); return uploaded.reference;
  }) : undefined;
  const message = owner.connect('human').execute({ commandId: 'TEST-send', operation: 'message.send', payload: { to: 'alice', text: 'original queued input', ...(refs ? { attachments: refs } : {}) } });
  const intent = store.read<DeliveryIntent>(`outbox/${message.effects.deliveryId}.json`)!;
  const runtimeStore = new FileRuntimeStore(root);
  let opens = 0;
  const runtime = new RuntimeOwner({ store: runtimeStore, profileId: 'TEST-profile', hostIncarnation: 'TEST-incarnation',
    driverFactory: { async open() { opens++; throw new Error('Queue operations must not allocate/submit native work'); } },
    authorize: (target, action, input) => input ? owner.authorizeDeliveryIntent(input, action) : owner.authorizeMemberBinding(target, action), canDispatch: () => false });
  const delivery = { fingerprintDelivery: runtime.fingerprintDelivery.bind(runtime), admitDelivery: runtime.admitDelivery.bind(runtime), lookupDelivery: runtime.lookupDelivery.bind(runtime), cancelDelivery: runtime.cancelDelivery.bind(runtime) };
  const queue = owner.queuedMessages('human', delivery);
  const inbox = () => store.read<unknown[]>('../inboxes/alice.json')!;
  const input = { commandId: 'TEST-discard', member: 'alice', messageIds: [intent.messageId] };
  const backup = new OwnerBackupResourceAccess(store, binding);
  return { root, binding, refs, store, owner, intent, runtimeStore, runtime, delivery, queue, inbox, input, backup, opens: () => opens };
}
test('actual unseen Runtime input is cancelled once; only its confirmed queued row is discarded and old backup cannot resurrect it', async t => {
  const f = fixture(t), before = f.backup.capture('teams/TEST-team/inboxes/alice.json');
  assert.equal((await f.queue.list('alice')).messages.length, 1);
  const receipt = await f.queue.discard(f.input);
  assert.equal(receipt.discardedMessageIds!.length, 1);
  assert.deepEqual(f.queue.lookup(f.input.commandId, { member: f.input.member, messageIds: f.input.messageIds }), receipt);
  assert.throws(() => f.queue.lookup(f.input.commandId, { member: f.input.member, messageIds: ['TEST-replacement'] }));
  assert.equal(f.queue.lookup('TEST-absent', { member: f.input.member, messageIds: f.input.messageIds }), undefined);
  assert.equal(f.inbox().length, 0);
  const operationRef = f.runtime.readCapturedSession(f.intent.binding).record!.inputs[0]!.operationRef;
  assert.deepEqual(await f.queue.discard(f.input), receipt);
  assert.equal(f.runtime.readCapturedSession(f.intent.binding).record!.inputs[0]!.operationRef, operationRef);
  assert.equal(f.store.read<DeliveryIntent>(`outbox/${f.intent.deliveryId}.json`)!.content, f.intent.content);
  unlinkSync(join(f.root, 'teams/TEST-team/inboxes/alice.json'));
  assert.equal(f.backup.restoreMissing('teams/TEST-team/inboxes/alice.json', before.bytes, before.proof), 'held');
  assert.equal(f.opens(), 0);
});
test('controlled claimed/unknown input holds original discard; later terminal proof preserves its inbox history', async t => {
  const f = fixture(t);
  await f.runtime.admitDelivery(f.intent);
  f.runtimeStore.fenced(f.intent.binding, tx => { const record = tx.get()!; record.inputs[0]!.phase = 'claimed'; tx.put(record); });
  await assert.rejects(f.queue.discard(f.input));
  assert.equal(f.inbox().length, 1);
  assert.equal(f.owner.authorizeDeliveryIntent(f.intent, 'dispatch'), false, 'original discard suspends selected pending input only');
  f.runtimeStore.fenced(f.intent.binding, tx => { const record = tx.get()!; record.inputs[0]!.phase = 'terminal'; record.inputs[0]!.terminal = 'succeeded'; tx.put(record); });
  const result = await f.queue.discard(f.input);
  assert.deepEqual(result.discardedMessageIds, []);
  assert.equal(result.remainingQueued, 0);
  assert.equal(f.inbox().length, 1, 'claimed/settled input is history, never a removable queued row');
});
test('crash after same-receipt discard decision recovers the original projection after revoke without another native input', async t => {
  const f = fixture(t), original = f.store.write.bind(f.store);
  let failed = false;
  f.store.write = (name, value) => { if (name === '../inboxes/alice.json' && !failed) { failed = true; throw new Error('TEST inbox publication failed'); } original(name, value); };
  await assert.rejects(f.queue.discard(f.input), /publication/);
  assert.equal(f.inbox().length, 1);
  const operationRef = f.runtime.readCapturedSession(f.intent.binding).record!.inputs[0]!.operationRef;
  f.store.write = original;
  f.store.fenced(() => { const state = f.store.read<{ grants: TeamGrant[] }>('state.json')!; state.grants.find(row => row.principalId === 'human')!.revoked = true; f.store.write('state.json', state); });
  assert.deepEqual(await f.owner.recoverQueuedMessages(f.delivery), [{ commandId: f.input.commandId, phase: 'completed' }]);
  assert.equal(f.inbox().length, 0);
  assert.equal(f.runtime.readCapturedSession(f.intent.binding).record!.inputs[0]!.operationRef, operationRef);
  assert.equal(f.opens(), 0);
});

test('original roster closure accepts durable cancelled inputs but refuses claimed or unknown debt', async t => {
  const f = fixture(t);
  await f.queue.discard(f.input);
  let pending = false;
  const options = { members: [{ memberId: 'alice', delivery: f.intent.binding }],
    entries: [{ profile: { memberId: 'alice' }, binding: memberBinding(f.intent.binding) }] as MemberEntry[],
    launch: { memberActions: () => ({ pending: () => pending ? [{}] : [] }), read: () => ({ members: [{ memberId: 'alice', attempt: { claimed: false } }] }) } as unknown as TeamLaunchOwner,
    runtime: f.runtime };
  assert.equal(f.runtime.readCapturedSession(f.intent.binding).record!.inputs[0]!.phase, 'cancelled');
  assert.doesNotThrow(() => assertRosterEditable(options));
  pending = true;
  assert.throws(() => assertRosterEditable(options), 'retirement intent retains original saved source even after input cancellation');
  pending = false;
  for (const phase of ['claimed', 'unknown', 'admitted', 'consumed'] as const) {
    f.runtimeStore.fenced(f.intent.binding, tx => { const record = tx.get()!; record.inputs[0]!.phase = phase; tx.put(record); });
    assert.throws(() => assertRosterEditable(options), phase);
  }
  f.runtimeStore.fenced(f.intent.binding, tx => { const record = tx.get()!; record.inputs[0]!.phase = 'rejected'; tx.put(record); });
  assert.doesNotThrow(() => assertRosterEditable(options));
  assert.equal(f.opens(), 0);
});


test('rich queued discard cancels the original input once and cold recovery preserves exact attachment refs', async t => {
  const f = fixture(t, true);
  assert.deepEqual(f.intent.attachments, f.refs);
  const messagePath = join(f.store.directory, teamCommandPath('TEST-send'));
  const messageBytes = readFileSync(messagePath, 'utf8');
  let cancellations = 0, admissions = 0;
  const delivery = { ...f.delivery,
    async cancelDelivery(intent: DeliveryIntent) { cancellations++; return f.delivery.cancelDelivery(intent); },
    async admitDelivery(intent: DeliveryIntent) { admissions++; return f.delivery.admitDelivery(intent); } };
  const queue = f.owner.queuedMessages('human', delivery);
  const originalWrite = f.store.write.bind(f.store);
  let fail = true;
  f.store.write = (name, value) => {
    if (name === '../inboxes/alice.json' && fail) { fail = false; throw new Error('TEST rich projection interruption'); }
    originalWrite(name, value);
  };
  await assert.rejects(queue.discard(f.input), /rich projection interruption/);
  f.store.write = originalWrite;
  const retained = queue.lookup(f.input.commandId, { member: f.input.member, messageIds: f.input.messageIds })!;
  assert.equal(retained.phase, 'prepared');
  assert.deepEqual(retained.targets[0]!.intent, f.intent);
  assert.equal(retained.targets[0]!.fingerprint, f.runtime.fingerprintDelivery(f.intent));
  assert.equal(retained.targets[0]!.proof!.inputId, f.intent.inputId);
  const record = f.runtime.readCapturedSession(f.intent.binding).record!;
  assert.equal(record.inputs.length, 1); assert.equal(record.inputs[0]!.phase, 'cancelled');
  const operationRef = record.inputs[0]!.operationRef;
  const cold = createFilesystemTeamOwner({ root: f.root, binding: f.binding, members: [], grants: [],
    store: new TeamOwnerStore(f.root, f.binding.teamName) });
  assert.deepEqual(await cold.recoverQueuedMessages(delivery), [{ commandId: f.input.commandId, phase: 'completed' }]);
  const coldQueue = cold.queuedMessages('human', delivery);
  const completed = coldQueue.lookup(f.input.commandId, { member: f.input.member, messageIds: f.input.messageIds })!;
  assert.equal(completed.phase, 'completed');
  assert.deepEqual(completed.targets, retained.targets);
  assert.equal(completed.captureDigest, retained.captureDigest);
  assert.equal(completed.fingerprint, retained.fingerprint);
  assert.deepEqual(completed.discardedMessageIds, [f.intent.messageId]);
  assert.deepEqual(await coldQueue.discard(f.input), completed);
  assert.equal(f.inbox().length, 0);
  const outbox = f.store.read<DeliveryIntent>(`outbox/${f.intent.deliveryId}.json`)!;
  assert.deepEqual(outbox, { ...f.intent, phase: 'not_admitted', runtimeReceipt: retained.targets[0]!.proof!.receipt });
  assert.deepEqual(outbox.attachments, f.refs);
  assert.equal(readFileSync(messagePath, 'utf8'), messageBytes);
  assert.equal(f.runtime.readCapturedSession(f.intent.binding).record!.inputs[0]!.operationRef, operationRef);
  assert.equal(cancellations, 1); assert.equal(admissions, 0); assert.equal(f.opens(), 0);
});
