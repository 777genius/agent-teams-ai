import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeCaptureQualification } from '../dist/nativeCaptureProof.js';
import type { EvidenceEvent } from '../dist/ledgerTypes.js';

/** Controlled ledger boundary; native provenance is separately established by Host E2E. */
function fixture() {
  const tools = [{ messageId: 'msg_nativeAssistant', callId: 'TEST-edit',
    calledEventId: 'evt_called', calledSeq: 37, completedEventId: 'evt_success', completedSeq: 39 }];
  const identity = { nativeSessionId: 'ses_nativeSession', nativeInputId: 'msg_nativeInput', windowRef: 'TEST-window' };
  return {
    source: 'file_edit', operation: 'modify', toolUseId: 'TEST-edit', toolStatus: 'succeeded',
    beforeState: { exists: true }, afterState: { exists: true },
    before: { sha256: 'a'.repeat(64) }, after: { sha256: 'b'.repeat(64) },
    causalBinding: { toolName: 'opencode.fileChange', toolUseId: 'TEST-edit',
      native: { provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4', ...identity, tools: structuredClone(tools) } },
    nativeCaptureProof: { kind: 'opencode-update-patch-v2', protocolRevision: '2.1.4',
      toolInputDigest: 'c'.repeat(64), beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), ...identity, tools },
  };
}
const qualify = (event: ReturnType<typeof fixture>) => nativeCaptureQualification(event as unknown as EvidenceEvent);

test('Review admits only V2 byte proof bound to its actual event anchors and generation', () => {
  assert.equal(qualify(fixture()), 'qualified');
  const mutations: ((event: ReturnType<typeof fixture>) => void)[] = [
    event => { event.causalBinding.native.nativeGeneration = 'v1'; },
    event => { event.nativeCaptureProof.kind = 'opencode-update-patch-v1'; },
    event => { event.nativeCaptureProof.protocolRevision = '2.0.21'; },
    event => { event.nativeCaptureProof.tools[0].calledSeq = 40; },
    event => { event.nativeCaptureProof.tools[0].completedEventId = 'evt_foreign'; },
    event => { event.nativeCaptureProof.beforeSha256 = 'd'.repeat(64); },
    event => { event.toolStatus = 'failed'; },
  ];
  for (const mutate of mutations) {
    const event = structuredClone(fixture()); mutate(event);
    assert.equal(qualify(event), 'unqualified');
  }
});
