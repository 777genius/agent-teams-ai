import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createRuntimeDeliveryPort } from '../dist/composition/runtimeDeliveryPort.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import type { RuntimeBinding, RuntimeDelivery, RuntimeOwnerOptions } from '../dist/runtime/contracts.js';
import { GoalSession } from './fixtures/autonomous-goal-host.ts';

type ClaimAuthority = NonNullable<RuntimeOwnerOptions['withDispatchAuthority']>;

async function fixture(t: TestContext, authorize: ClaimAuthority) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-goal-claim-')));
  const store = new FileRuntimeStore(root);
  const binding: RuntimeBinding = { backendId: 'TEST-backend', teamId: 'TEST-team',
    runId: 'TEST-run', memberId: 'lead', generation: '1' };
  const session = new GoalSession('TEST-claim-session', () => {});
  const runtime = new RuntimeOwner({ store, profileId: 'TEST-profile', hostIncarnation: 'TEST-incarnation',
    driverFactory: { open: async () => ({ driver: session, capabilities: ['tools'] }) },
    authorize: () => true, canDispatch: () => true, withDispatchAuthority: authorize });
  t.after(async () => {
    await runtime.stopCapturedSession(binding);
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.openSession({ binding, config: { tenantId: 'TEST-backend', projectId: 'TEST-project',
    sessionId: 'TEST-claim-session', generation: 1, configRevision: 'TEST-config', requiredCapabilities: ['tools'] } });
  const intent: RuntimeDelivery = { binding, deliveryId: 'TEST-original', inputId: 'TEST-original',
    messageId: 'TEST-message', content: 'TEST original charged continuation' };
  await runtime.admitDelivery(intent);
  return { root, store, binding, session, runtime, intent,
    record: () => store.fenced(binding, tx => tx.get()!) };
}

test('the original Team fence encloses one durable Runtime claim and ends before native submit', async t => {
  let team: TeamOwnerStore | undefined;
  let inTeamFence = false;
  let calls = 0;
  const f = await fixture(t, (binding, intent, commitClaim) => {
    assert.deepEqual(binding, f.binding);
    assert.deepEqual(intent, f.intent);
    assert.ok(team);
    team.fenced(() => {
      inTeamFence = true;
      try {
        commitClaim();
        calls++;
        assert.equal(f.session.submits.length, 0);
      } finally { inTeamFence = false; }
    });
  });
  team = new TeamOwnerStore(f.root, 'TEST-team');
  assert.equal(f.record().inputs[0]!.phase, 'admitted');
  f.session.submitAction = async input => {
    assert.equal(inTeamFence, false, 'no Team lock is held across native IO');
    assert.equal(f.record().inputs[0]!.phase, 'claimed');
    return { ok: true, value: { inputId: input.inputId, operationRef: input.operationRef,
      delivery: 'client-consumed', providerAcceptance: 'unknown' } };
  };
  await f.runtime.dispatchNext(f.binding);
  assert.equal(calls, 1);
  assert.equal(f.session.submits.length, 1);
  assert.equal(f.record().inputs[0]!.phase, 'consumed');
});

test('revoked or uncommitted authority leaves the original admitted input unclaimed', async t => {
  for (const denied of [false, true]) {
    await t.test(denied ? 'denied' : 'missing commit', async t => {
      const f = await fixture(t, () => { if (denied) throw new RuntimeOwnerError('forbidden'); });
      await assert.rejects(f.runtime.dispatchNext(f.binding), RuntimeOwnerError);
      assert.equal(f.record().inputs[0]!.phase, 'admitted');
      assert.equal(f.session.submits.length, 0);
    });
  }
});

test('an asynchronous callback cannot claim after its original synchronous authority window', async t => {
  let attempted = false;
  let lateError: unknown;
  const f = await fixture(t, async (_binding, _intent, commitClaim) => {
    await Promise.resolve();
    attempted = true;
    try { commitClaim(); } catch (error) { lateError = error; }
  });
  await assert.rejects(f.runtime.dispatchNext(f.binding), RuntimeOwnerError);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempted, true);
  assert.ok(lateError instanceof RuntimeOwnerError);
  assert.equal(f.record().inputs[0]!.phase, 'admitted');
  assert.equal(f.session.submits.length, 0);
});

test('a duplicate callback invocation cannot submit and retains its first irreversible claim', async t => {
  const f = await fixture(t, (_binding, _intent, commitClaim) => {
    commitClaim();
    commitClaim();
  });
  await assert.rejects(f.runtime.dispatchNext(f.binding), RuntimeOwnerError);
  const original = f.record().inputs[0]!;
  assert.equal(original.phase, 'claimed');
  assert.equal(f.session.submits.length, 0);
  await assert.rejects(f.runtime.dispatchNext(f.binding), RuntimeOwnerError);
  assert.equal(f.record().inputs[0]!.operationRef, original.operationRef);
  assert.equal(f.session.submits.length, 0, 'ambiguous claimed input is never replayed');
});

test('the composition delivery port preserves the original cancellation authority before changing an input', async t => {
  const f = await fixture(t, (_binding, _intent, commitClaim) => commitClaim());
  const team = new TeamOwnerStore(f.root, 'TEST-team');
  let availabilityChecks = 0;
  const port = createRuntimeDeliveryPort(f.runtime, binding => {
    assert.deepEqual(binding, f.binding);
    availabilityChecks++;
  });
  const original = structuredClone(f.record().inputs[0]!);
  let authorityChecks = 0;
  await assert.rejects(port.cancelDelivery(f.intent, () => team.fenced(() => {
    authorityChecks++;
    throw new RuntimeOwnerError('hold');
  })), RuntimeOwnerError);
  assert.equal(authorityChecks, 1, 'the port must forward the original synchronous Team check');
  assert.deepEqual(f.record().inputs, [original], 'a stale retirement cannot cancel a current input');
  assert.equal(f.session.submits.length, 0);

  const cancelled = await port.cancelDelivery(f.intent, commit => team.fenced(() => {
    authorityChecks++;
    commit();
  }));
  assert.equal(cancelled.outcome, 'not_admitted');
  assert.equal(authorityChecks, 2);
  assert.equal(availabilityChecks, 2);
  assert.deepEqual(f.record().inputs, [{ ...original, phase: 'cancelled' }]);
  assert.equal(f.session.submits.length, 0);
});
