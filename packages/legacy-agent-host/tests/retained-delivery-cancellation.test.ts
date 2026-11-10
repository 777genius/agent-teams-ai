import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { cancelRetainedDeliveries } from '../dist/team/cancelRetainedDeliveries.js';
import type { RetainedDeliveryCancellation } from '../dist/team/cancelRetainedDeliveries.js';
import type { DeliveryAdmission, DeliveryIntent, TeamRuntimeDeliveryPort } from '../dist/team/contracts.js';

function fixture(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-retained-cancel-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new TeamOwnerStore(root, 'TEST-team');
  const intent: DeliveryIntent = { schemaVersion: 1, binding: { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team', runId: 'TEST-run', memberId: 'alice', generation: '1' },
    commandId: 'TEST-message', principalId: 'user', authorityRevision: 1,
    messageId: 'TEST-inbox', deliveryId: 'TEST-input', inputId: 'TEST-input', content: 'original exact message', phase: 'pending' };
  store.fenced(() => store.write('outbox/TEST-input.json', intent));
  const fingerprint = 'TEST-fingerprint';
  const response = (phase: string): DeliveryAdmission => ({ inputId: intent.inputId,
    outcome: ['cancelled', 'rejected'].includes(phase) ? 'not_admitted' : phase === 'claimed' ? 'unknown' : 'admitted',
    receipt: { schemaVersion: 1, binding: { ...intent.binding }, inputId: intent.inputId, fingerprint, operationRef: 'TEST-operation', phase } });
  const targets: RetainedDeliveryCancellation[] = [{ intent }];
  let cancels = 0;
  const runtime: TeamRuntimeDeliveryPort = { fingerprintDelivery: () => fingerprint,
    async admitDelivery() { throw new Error('Must never admit'); }, async lookupDelivery() { throw new Error('Must cancel unseen IDs, not trust lookup absence'); },
    async cancelDelivery(raw) { assert.deepEqual(raw, intent); cancels++; return response('cancelled'); } };
  const options = { store, runtime, targets, assertRetained(target: RetainedDeliveryCancellation) { assert.deepEqual(target.intent, intent); },
    saveProof(target: RetainedDeliveryCancellation) { store.write('TEST-retained-proof.json', target); } };
  return { store, intent, runtime, targets, response, options, cancels: () => cancels };
}
test('unseen original input is durably cancelled before inbox removal can be authorized; replay performs no cancellation', async t => {
  const f = fixture(t);
  assert.deepEqual(await cancelRetainedDeliveries(f.options), [{ deliveryId: f.intent.deliveryId, outcome: 'not-sent' }]);
  const after = f.store.read<DeliveryIntent>('outbox/TEST-input.json')!;
  assert.equal(after.phase, 'not_admitted');
  assert.equal(after.content, f.intent.content, 'never amputate original input/history');
  const retained = f.store.read<RetainedDeliveryCancellation>('TEST-retained-proof.json')!;
  assert.deepEqual(await cancelRetainedDeliveries({ ...f.options, targets: [retained] }), [{ deliveryId: f.intent.deliveryId, outcome: 'not-sent' }]);
  assert.equal(f.cancels(), 1);
});
test('claimed/unknown stays held and preserves original outbox payload; terminal is settled but never reported discarded', async t => {
  const f = fixture(t);
  f.runtime.cancelDelivery = async () => f.response('claimed');
  assert.equal((await cancelRetainedDeliveries(f.options))[0]!.outcome, 'held');
  assert.deepEqual(f.store.read('outbox/TEST-input.json'), f.intent);
  f.runtime.cancelDelivery = async () => f.response('terminal');
  assert.equal((await cancelRetainedDeliveries(f.options))[0]!.outcome, 'settled');
  assert.equal(f.store.read<DeliveryIntent>('outbox/TEST-input.json')!.phase, 'admitted');
});
test('binding/fingerprint or product command replacement cannot overwrite a retained cancellation target', async t => {
  const f = fixture(t);
  f.runtime.cancelDelivery = async () => ({ ...f.response('cancelled'), receipt: { ...(f.response('cancelled').receipt as Record<string, string>), fingerprint: 'FOREIGN' } });
  assert.equal((await cancelRetainedDeliveries(f.options))[0]!.outcome, 'held');
  f.runtime.cancelDelivery = async () => {
    f.store.fenced(() => f.store.write('outbox/TEST-input.json', { ...f.intent, commandId: 'REPLACED-command' }));
    return f.response('cancelled');
  };
  assert.equal((await cancelRetainedDeliveries(f.options))[0]!.outcome, 'held');
  assert.equal(f.store.read<DeliveryIntent>('outbox/TEST-input.json')!.commandId, 'REPLACED-command');
});
