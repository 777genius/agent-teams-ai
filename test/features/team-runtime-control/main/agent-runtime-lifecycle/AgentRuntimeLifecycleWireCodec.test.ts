import { AgentRuntimeLifecycleWireCodec } from '@features/team-runtime-control/main/adapters/input/agent-runtime-lifecycle/AgentRuntimeLifecycleWireCodec';
import { describe, expect, it } from 'vitest';

function frame(effect: 'preflight' | 'launch' | 'observe' | 'stop' | 'recover' = 'preflight') {
  return {
    protocolVersion: 1,
    requestId: `request:${effect}`,
    callerLease: {
      kind: 'agent-runtime-lifecycle-caller-lease/v1',
      bootId: 'boot:test',
      leaseId: 'lease:test',
      authority: 'external_lifecycle_orchestrator',
      callerId: 'external-orchestrator',
      token: 'caller_token_abcdefghijklmnopqrstuvwxyz012345',
      issuedAtIso: '2026-08-07T00:59:00.000Z',
      expiresAtIso: '2026-08-07T01:02:00.000Z',
    },
    operationId: `operation:${effect}`,
    effectLease: {
      token: `effect_${effect}_abcdefghijklmnopqrstuvwxyz012345`,
      fence: 4,
      ownerId: `launch-team-cancellation:${effect}`,
      claimedAtIso: '2026-08-07T00:59:30.000Z',
      expiresAtIso: '2026-08-07T01:01:30.000Z',
    },
    plan: { immutable: true },
    laneId: 'lane:test',
    effect,
    ...(effect === 'launch'
      ? {
          readiness: {
            backend: 'provisioning_cli',
            bindingId: 'binding:test',
            laneId: 'lane:test',
            planHash: `sha256:${'a'.repeat(64)}`,
            bindingRevision: 1,
            providerRevisions: [{ providerId: 'anthropic', capabilityRevision: 1 }],
          },
        }
      : {}),
    ...(effect === 'observe' || effect === 'stop' ? { executionRef: 'execution:test' } : {}),
    ...(effect === 'stop' ? { mode: 'graceful' } : {}),
  };
}

describe('AgentRuntimeLifecycleWireCodec', () => {
  it('decodes only the five exact machine effect shapes', () => {
    const codec = new AgentRuntimeLifecycleWireCodec();
    for (const effect of ['preflight', 'launch', 'observe', 'stop', 'recover'] as const) {
      expect(codec.decode(JSON.stringify(frame(effect)))).toMatchObject({
        status: 'decoded',
        request: { effect, requestId: `request:${effect}` },
      });
    }
  });

  it('rejects extra authority, missing fencing, malformed refs, and oversized input', () => {
    const codec = new AgentRuntimeLifecycleWireCodec(2_000);
    const invalid = [
      { ...frame(), teamName: 'browser-chosen-team' },
      { ...frame(), effectLease: undefined },
      { ...frame('observe'), executionRef: 'contains whitespace' },
      { ...frame(), effect: 'createTeam' },
    ];
    for (const value of invalid) {
      expect(codec.decode(JSON.stringify(value)).status).toBe('rejected');
    }
    expect(codec.decode('x'.repeat(2_001)).status).toBe('rejected');
  });

  it('rejects delimiter injection and overlong identifiers', () => {
    const codec = new AgentRuntimeLifecycleWireCodec();
    expect(
      codec.decode(JSON.stringify({ ...frame(), requestId: 'request:bad\nsecond-frame' })).status
    ).toBe('rejected');
    expect(
      codec.decode(JSON.stringify({ ...frame(), laneId: `lane:${'x'.repeat(512)}` })).status
    ).toBe('rejected');
  });

  it('encodes a single newline-delimited response without reflecting credentials', () => {
    const encoded = new AgentRuntimeLifecycleWireCodec().encode({
      protocolVersion: 1,
      requestId: 'request:preflight',
      effect: 'preflight',
      status: 'rejected',
      reason: 'unauthenticated',
    });
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded).not.toContain('caller_token');
  });
});
