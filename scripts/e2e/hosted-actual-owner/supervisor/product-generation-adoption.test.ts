import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { APPROVAL_GENERATION_TRANSITION } from '../../../../src/main/composition/hosted/hostedApprovalGenerationTransitionContract';
import { decodeNativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';
import { observeProductGenerationAdoption, readProductGenerationAdoption } from './product-generation-transition';

// Message-state fixtures only. They do not establish process ownership,
// independently signed manifest admission, or a runnable provider.
function fixture() {
  const events = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null, send() {} });
  const child = events as unknown as ChildProcess;
  const selection = decodeNativeActivationHandleSelection({ contract: 'agent-teams.hosted-native-activation-handle/v1',
    ownerProcessStartToken: '1'.repeat(64), bootstrapV2HeaderSha256: '2'.repeat(64),
    bootstrapDigest: '3'.repeat(64), ownerGeneration: 1, ownerSessionId: 'owner-session_fixture01',
    expectedOpenCodeExecutableSha256: 'cffecbe3ff685de84d7fa028e552c42d15a7c720a8f8d5d1cddd265110e5eb88' });
  const message = { contract: `${APPROVAL_GENERATION_TRANSITION}/ready`,
    selection, transitionSha256: null, manifestDigest: `sha256:${'4'.repeat(64)}` };
  return { events, child, selection, message };
}

test('predecessor digest is available only after the validated ready wait completes', async () => {
  const { events, child, selection, message } = fixture();
  assert.throws(() => readProductGenerationAdoption(child, selection));
  const pending = observeProductGenerationAdoption(child, selection);
  events.emit('message', message);
  await pending;
  assert.equal(readProductGenerationAdoption(child, selection).manifestDigest, message.manifestDigest);
  assert.throws(() => readProductGenerationAdoption(child, { ...selection, ownerProcessStartToken: '5'.repeat(64) }));
  events.connected = false;
  assert.throws(() => readProductGenerationAdoption(child, selection));
});

test('invalid selection or process loss cannot retain a predecessor digest', async () => {
  for (const variant of ['selection', 'disconnected'] as const) {
    const { events, child, selection, message } = fixture();
    const pending = observeProductGenerationAdoption(child, selection);
    if (variant === 'selection') events.emit('message', { ...message,
      selection: { ...selection, ownerGeneration: 2 } });
    else { events.connected = false; events.emit('message', message); }
    await assert.rejects(pending);
    events.connected = true;
    assert.throws(() => readProductGenerationAdoption(child, selection));
  }
});
