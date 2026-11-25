import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { readDesktopLiveMembershipPayload } from './desktop-live-membership-selection.ts';

// Captured old22ee Linux TEST fixture: the original native Add and proof completed before the stale oracle failed.
const commandId = '34267612-3b0d-410c-baec-3ecf3900f26c';
const expectedRevision = 'c747708c1e62dd48313a896282bc944d275deb4a10990297b79de11dca12613b';
const requestDigest = '90a0f47b2763fb2a74a1dc0c199f9986f524d8859afbe45020bcc7eed5f5e75a';
const capture = {
  schemaVersion: 1, commandId, teamId: '8108e31e-4e7f-5b6a-907e-b2a1f9243cc5', requestDigest, expectedRevision,
  launchId: '54cc8595-493b-5e95-81c7-ef1a95cb253b',
  sourceCaptureDigest: '7647c7838408661a51607ea7d7ab9702dc11cd976be03d30f72aeddf9c6a579c',
  captureDigest: 'd8fb2b69feb363ef639d19aeb66d596a9e5da57c553028efe1f06814667ebc3b',
  target: { memberId: 'ee9b7f78-4398-5bb8-a9bd-07aee2bcedc0', name: 'carol', provider: 'opencode',
    modelProviderId: 'test-local', modelId: 'TEST-model',
    workspace: '/home/runner/work/_temp/TEST-desktop-backend-dVSdCM/workspace',
    optionsDigest: 'e593619154d398de61a0eee350c63772563b54ba09b6aaa0f90d89699f035819',
    configurationDigest: 'b0416260f0c13a49e391c64e4d1409178894926a8b9dad61b1f49d5debfc351d' },
};
const input = { commandId, expectedRevision, members: [
  { role: 'developer', workflow: 'TEST mixed codex workflow: use only the supplied business input.',
    providerId: 'codex', model: 'TEST-model', name: 'bob' },
  { providerId: 'opencode', model: 'test-local/TEST-model', name: 'carol' },
] };
const decision = { input, requestDigest, capture };

test('reconstructs the actual finite Main wire payload, retaining original command/CAS/capture proof', () => {
  const original = JSON.stringify(decision);
  const payload = readDesktopLiveMembershipPayload(commandId, decision);
  assert.equal(runtimeDigest({ payload, capture }), '651efdc9048abc948fddb181fe0dfc8e669416c0ff6f0a24e1f493e2176875cc');
  assert.equal(runtimeDigest({ payload: input, capture }), 'd7104f5b301fa03ab6526e7fbec966fe0ce2c8cd66d7c9fa57a87cca74666f3e');
  assert.equal(JSON.stringify(decision), original);
  assert.deepEqual(Object.keys(payload.members[0]!), ['name', 'role', 'workflow', 'model', 'providerId']);
});

test('does not rebind a receipt to another command, request or roster revision', () => {
  assert.throws(() => readDesktopLiveMembershipPayload('TEST-another-command', decision));
  assert.throws(() => readDesktopLiveMembershipPayload(commandId, { ...decision, requestDigest: '0'.repeat(64) }));
  assert.throws(() => readDesktopLiveMembershipPayload(commandId, { ...decision,
    input: { ...input, expectedRevision: '0'.repeat(64) } }));
});

test('does not infer the probe input from a semantically changed member payload', () => {
  const changed = structuredClone(decision);
  changed.input.members[1]!.model = 'test-local/TEST-different-model';
  assert.throws(() => readDesktopLiveMembershipPayload(commandId, changed), /same original Host request digest/);
});

test('requires the selected capture to bind the same command, request digest and source revision', () => {
  for (const field of ['commandId', 'requestDigest', 'expectedRevision'] as const)
    assert.throws(() => readDesktopLiveMembershipPayload(commandId, {
      ...decision, capture: { ...capture, [field]: 'TEST-different-original' },
    }));
});
