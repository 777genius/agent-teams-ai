import { describe, expect, it, vi } from 'vitest';

import { verifyCurrentNativeSuggestion } from '../../../src/features/native-prompt-suggestions/renderer/hooks/verifyCurrentNativeSuggestion';

import type { NativeNextPromptCandidate } from '../../../src/features/native-prompt-suggestions/contracts';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';

const candidate: NativeNextPromptCandidate = {
  ownerHandle: 'host-team:TEST-handle-A',
  teamId: 'TEST-team-A', runId: 'TEST-run-A',
  memberId: 'TEST-member-A', memberName: 'alice',
  generation: 'TEST-generation-1', conversationRef: 'direct:alice',
  suggestionId: 'TEST-suggestion-1', messageId: 'TEST-human-message-1',
  inputId: 'TEST-input-1', operationRef: 'TEST-operation-1',
  completedTurnRef: 'TEST-native-turn-1',
  provider: 'claude', text: 'Review the tests',
};

const original = { inputId: candidate.inputId, phase: 'terminal', terminal: 'succeeded' };
function fixture() {
  const state = {
    memberId: candidate.memberId, generation: candidate.generation,
    phase: 'allocated', custody: 'owned', nativeReady: true,
    attached: true, sealed: false, nativePromptCurrent: true, inputs: [original],
  };
  const getConnections = vi.fn(async () => ({
    state: 'ready' as const,
    bindings: [{ handle: { handleId: 'TEST-handle-A' }, label: 'Test team',
      members: [{ memberId: candidate.memberId, label: 'alice' }] }],
  }));
  const invoke = vi.fn(async () => ({ ok: true as const, value: state }));
  const backend = { getConnections, invoke } as unknown as Pick<AgentBackendApi, 'getConnections' | 'invoke'>;
  return { backend, state, invoke, getConnections };
}

describe('native suggestion acceptance-time captured Runtime read', () => {
  it('checks original input, active generation, attached custody and descriptor twice', async () => {
    const x = fixture();
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(true);
    expect(x.invoke).toHaveBeenCalledWith({
      handle: { handleId: 'TEST-handle-A' },
      commandId: expect.any(String),
      operation: 'runtime.read',
      payload: {
        memberId: candidate.memberId, expectedGeneration: candidate.generation,
        nativePromptProof: { inputId: candidate.inputId, operationRef: candidate.operationRef },
      },
    });
    expect(x.getConnections).toHaveBeenCalledTimes(2);
  });

  it('rejects stale restart, lost custody, missing input and superseding executed input', async () => {
    const x = fixture();
    x.state.generation = 'TEST-generation-2';
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(false);
    x.state.generation = candidate.generation;
    x.state.attached = false;
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(false);
    x.state.attached = true;
    x.state.inputs = [{ inputId: 'TEST-new', phase: 'terminal', terminal: 'succeeded' }];
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(false);
    x.state.inputs = [original, { inputId: 'TEST-new', phase: 'terminal', terminal: 'succeeded' }];
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(false);
    x.state.inputs = [original, { inputId: 'TEST-unexecuted', phase: 'admitted', terminal: 'succeeded' }];
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(true);
  });

  it('fails closed without independent matching original Host operation proof', async () => {
    const x = fixture();
    x.state.nativePromptCurrent = false;
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(false);
    x.state.nativePromptCurrent = true;
    expect(await verifyCurrentNativeSuggestion({ ...candidate, operationRef: '' }, x.backend)).toBe(false);
    expect(await verifyCurrentNativeSuggestion({ ...candidate, operationRef: 'TEST-foreign-operation' }, x.backend)).toBe(true);
    // The fake backend accepts any request; only the original Host can vouch
    // for the exact operation. The wire contract must carry the changed proof.
    expect(x.invoke).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        nativePromptProof: { inputId: candidate.inputId, operationRef: 'TEST-foreign-operation' },
      }),
    }));
  });

  it('refuses changed backend selection, failing read, malformed and unsupported candidates', async () => {
    const x = fixture();
    x.getConnections.mockResolvedValueOnce({ state: 'ready', bindings: [] });
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(false);
    x.invoke.mockRejectedValueOnce(new Error('TEST offline'));
    expect(await verifyCurrentNativeSuggestion(candidate, x.backend)).toBe(false);
    expect(await verifyCurrentNativeSuggestion({ ...candidate, ownerHandle: 'bad' }, x.backend)).toBe(false);
    expect(await verifyCurrentNativeSuggestion({ ...candidate, inputId: '' }, x.backend)).toBe(false);
  });
});
