import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeTeamCoordinator } from '../dist/composition/RuntimeTeamCoordinator.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../dist/runtime/identity.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../dist/runtime/contracts.js';

test('active cross-Team replies preserve captured Runtime binding across property order without selecting a stale generation', () => {
  const binding: RuntimeBinding = {
    backendId: 'TEST-owner',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'dana-id',
    generation: '1',
  };
  // CrossTeamComposition reconstructs this shape from the authenticated sender.
  const sender = {
    memberId: binding.memberId,
    runId: binding.runId,
    generation: binding.generation,
  };
  const reconstructed = { backendId: binding.backendId, teamId: binding.teamId, ...sender };
  const intent = {
    binding,
    deliveryId: 'TEST-original-delivery',
    inputId: 'TEST-original-delivery',
    messageId: 'TEST-original-cross-message',
    content: 'TEST original cross-Team request',
  };
  const record: RuntimeSessionRecord = {
    schemaVersion: 1,
    binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config: {
      tenantId: 'TEST-owner',
      projectId: 'TEST-project',
      sessionId: 'TEST-native-session',
      generation: 1,
      configRevision: 'TEST-config',
      requiredCapabilities: ['session.conversation'],
    },
    openFingerprint: 'TEST-open',
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    sessionRef: 'TEST-session',
    inputs: [
      {
        intent,
        fingerprint: deliveryFingerprint(intent),
        operationRef: 'TEST-native-operation',
        phase: 'consumed',
      },
    ],
    interactions: [],
  };
  const entry = { binding };
  let reads = 0,
    current = true;
  // Exercise the public selection method with a controlled owned-session seam;
  // no constructor, endpoint, filesystem, provider or native process is created.
  const subject = Object.create(RuntimeTeamCoordinator.prototype) as RuntimeTeamCoordinator;
  Object.assign(subject, {
    entries: new Map([[runtimeDigest(binding), entry]]),
    isCurrent: (candidate: unknown) => current && candidate === entry,
    runtime: {
      readSession(candidate: RuntimeBinding) {
        reads++;
        assert.deepEqual(normalizeBinding(candidate), binding);
        return { record, attached: true };
      },
    },
  });
  assert.deepEqual(
    subject.crossTeamActiveInputs(reconstructed),
    [intent],
    'same captured member input supplies the original reply hint'
  );
  assert.equal(reads, 1);
  const observed = subject.crossTeamActiveInputs(binding);
  observed[0]!.content = 'TEST caller modification';
  assert.equal(
    record.inputs[0]!.intent.content,
    'TEST original cross-Team request',
    'returned immutable delivery is copied'
  );
  assert.deepEqual(subject.crossTeamActiveInputs({ ...reconstructed, generation: '2' }), []);
  assert.equal(reads, 2, 'stale generation never reads a different session');
  current = false;
  assert.deepEqual(subject.crossTeamActiveInputs(reconstructed), []);
  assert.equal(reads, 2, 'revoked captured member remains unavailable');
});
