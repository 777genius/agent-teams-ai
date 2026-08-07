import { DispatchAgentRuntimeLifecycleEffect } from '@features/team-runtime-control/core/application/agent-runtime-lifecycle/DispatchAgentRuntimeLifecycleEffect';
import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeLifecycleCallerLease,
  AgentRuntimeLifecycleRequest,
} from '@features/team-runtime-control/contracts/agent-runtime-lifecycle-acl';
import type { ExecutionBackendRegistry } from '@features/team-runtime-control/core/application/backends';
import type { RuntimeCancellationId } from '@features/team-runtime-control/core/application/ports';

const NOW = Date.parse('2026-08-07T01:00:00.000Z');
const CALLER_LEASE: AgentRuntimeLifecycleCallerLease = Object.freeze({
  kind: 'agent-runtime-lifecycle-caller-lease/v1',
  bootId: 'boot:test',
  leaseId: 'caller-lease:test',
  authority: 'external_lifecycle_orchestrator',
  callerId: 'external-orchestrator',
  token: 'caller_token_abcdefghijklmnopqrstuvwxyz012345',
  issuedAtIso: '2026-08-07T00:59:00.000Z',
  expiresAtIso: '2026-08-07T01:02:00.000Z',
});

function request(effect: AgentRuntimeLifecycleRequest['effect']): AgentRuntimeLifecycleRequest {
  const common = {
    protocolVersion: 1 as const,
    requestId: `request:${effect}`,
    callerLease: CALLER_LEASE,
    operationId: `operation:${effect}`,
    effectLease: {
      token: `effect_${effect}_abcdefghijklmnopqrstuvwxyz012345`,
      fence: 7,
      ownerId: 'cancel:test',
      claimedAtIso: '2026-08-07T00:59:30.000Z',
      expiresAtIso: '2026-08-07T01:01:30.000Z',
    },
    plan: {} as AgentRuntimeLifecycleRequest['plan'],
    laneId: 'lane:test' as AgentRuntimeLifecycleRequest['laneId'],
  };
  switch (effect) {
    case 'launch':
      return {
        ...common,
        effect,
        readiness: {
          backend: 'provisioning_cli',
          bindingId: 'binding:test',
          laneId: common.laneId,
          planHash: `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
          bindingRevision: 1,
          providerRevisions: [{ providerId: 'anthropic', capabilityRevision: 1 }],
        },
      };
    case 'observe':
      return { ...common, effect, executionRef: 'execution:test' };
    case 'stop':
      return { ...common, effect, executionRef: 'execution:test', mode: 'graceful' };
    default:
      return { ...common, effect };
  }
}

function harness() {
  const backend = {
    preflight: vi.fn().mockResolvedValue({ status: 'ready', readiness: { receipt: true } }),
    launch: vi.fn().mockResolvedValue({ status: 'launched', executionRef: 'execution:test' }),
    observe: vi.fn().mockResolvedValue({ status: 'ready' }),
    stop: vi.fn().mockResolvedValue({ status: 'stopped' }),
    recover: vi.fn().mockResolvedValue({ status: 'recovered', executionRef: 'execution:test' }),
  };
  const scope = { marker: 'accepted-scope' };
  const registry = {
    resolve: vi.fn().mockReturnValue({ status: 'resolved', backend, scope }),
  } as unknown as ExecutionBackendRegistry;
  const authenticate = vi.fn().mockResolvedValue({
    status: 'authenticated',
    caller: {
      bootId: CALLER_LEASE.bootId,
      leaseId: CALLER_LEASE.leaseId,
      authority: CALLER_LEASE.authority,
      callerId: CALLER_LEASE.callerId,
      expiresAtIso: CALLER_LEASE.expiresAtIso,
    },
  });
  const cancellation = {
    cancellationId: 'cancel:test' as RuntimeCancellationId,
    isCancellationRequested: () => false,
  };
  const createCancellation = vi.fn(() => cancellation);
  const dispatch = new DispatchAgentRuntimeLifecycleEffect({
    bootId: CALLER_LEASE.bootId,
    registry,
    callerLeaseAuthenticator: { authenticate },
    cancellationFactory: { create: createCancellation },
    clock: { nowEpochMs: () => NOW },
  });
  return { dispatch, backend, registry, authenticate, scope, cancellation, createCancellation };
}

describe('DispatchAgentRuntimeLifecycleEffect', () => {
  it('dispatches exactly one already-accepted lane to each backend effect', async () => {
    const test = harness();
    for (const effect of ['preflight', 'launch', 'observe', 'stop', 'recover'] as const) {
      await expect(test.dispatch.execute(request(effect))).resolves.toMatchObject({
        status: 'completed',
        effect,
      });
    }

    expect(test.registry.resolve).toHaveBeenCalledTimes(5);
    expect(test.backend.preflight).toHaveBeenCalledWith({
      scope: test.scope,
      cancellation: test.cancellation,
    });
    expect(test.backend.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: test.scope,
        operationId: 'operation:launch',
        effectLease: request('launch').effectLease,
      })
    );
    expect(test.backend.observe).toHaveBeenCalledWith({
      scope: test.scope,
      executionRef: 'execution:test',
    });
    expect(test.backend.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: test.scope,
        operationId: 'operation:stop',
        effectLease: request('stop').effectLease,
        executionRef: 'execution:test',
        mode: 'graceful',
      })
    );
    expect(test.backend.recover).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: test.scope,
        operationId: 'operation:recover',
        effectLease: request('recover').effectLease,
      })
    );
  });

  it('accepts a per-operation lease owner distinct from the stable caller identity', async () => {
    const test = harness();
    expect(CALLER_LEASE.callerId).not.toBe(request('launch').effectLease.ownerId);
    await expect(test.dispatch.execute(request('launch'))).resolves.toMatchObject({
      status: 'completed',
      effect: 'launch',
    });
    expect(test.backend.launch).toHaveBeenCalledOnce();
    expect(test.createCancellation).toHaveBeenCalledWith({
      requestId: 'request:launch',
      operationId: 'operation:launch',
      effect: 'launch',
    });
  });

  it('authenticates an invalid token before cancellation or operation resolution', async () => {
    const test = harness();
    test.authenticate.mockResolvedValueOnce({ status: 'rejected' } as never);
    const invalidTokenRequest = {
      ...request('launch'),
      callerLease: { ...CALLER_LEASE, token: 'invalid_token_abcdefghijklmnopqrstuvwxyz012345' },
    } as AgentRuntimeLifecycleRequest;

    await expect(test.dispatch.execute(invalidTokenRequest)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'unauthenticated',
    });
    expect(test.authenticate).toHaveBeenCalledOnce();
    expect(test.createCancellation).not.toHaveBeenCalled();
    expect(test.registry.resolve).not.toHaveBeenCalled();
  });

  it('fails closed before backend resolution for stale boot, auth, and effect owner', async () => {
    for (const mutate of [
      (input: AgentRuntimeLifecycleRequest) => ({
        ...input,
        callerLease: { ...input.callerLease, bootId: 'boot:stale' },
      }),
      (input: AgentRuntimeLifecycleRequest) => ({
        ...input,
        effectLease: { ...input.effectLease, ownerId: CALLER_LEASE.callerId },
      }),
      (input: AgentRuntimeLifecycleRequest) => ({
        ...input,
        effectLease: { ...input.effectLease, fence: 0 },
      }),
    ]) {
      const test = harness();
      const result = await test.dispatch.execute(
        mutate(request('launch')) as AgentRuntimeLifecycleRequest
      );
      expect(result.status).toBe('rejected');
      expect(test.registry.resolve).not.toHaveBeenCalled();
      expect(test.backend.launch).not.toHaveBeenCalled();
    }

    const unauthenticated = harness();
    unauthenticated.authenticate.mockResolvedValueOnce({ status: 'rejected' } as never);
    await expect(unauthenticated.dispatch.execute(request('launch'))).resolves.toMatchObject({
      status: 'rejected',
      reason: 'unauthenticated',
    });
    expect(unauthenticated.registry.resolve).not.toHaveBeenCalled();
  });

  it('does not retry an unavailable backend effect', async () => {
    const test = harness();
    test.backend.launch.mockRejectedValueOnce(new Error('ambiguous-provider-effect'));
    await expect(test.dispatch.execute(request('launch'))).resolves.toMatchObject({
      status: 'rejected',
      reason: 'unavailable',
    });
    expect(test.backend.launch).toHaveBeenCalledOnce();
  });

  it('passes stale and replay fencing to the sole backend authority without retrying', async () => {
    const test = harness();
    test.backend.launch
      .mockResolvedValueOnce({ status: 'rejected', reason: 'not_owned' })
      .mockResolvedValueOnce({ status: 'already_launched', executionRef: 'execution:test' });

    await expect(test.dispatch.execute(request('launch'))).resolves.toMatchObject({
      status: 'completed',
      outcome: { status: 'rejected', reason: 'not_owned' },
    });
    await expect(test.dispatch.execute(request('launch'))).resolves.toMatchObject({
      status: 'completed',
      outcome: { status: 'already_launched' },
    });
    expect(test.backend.launch).toHaveBeenCalledTimes(2);
    expect(test.backend.launch.mock.calls[0]?.[0]).toMatchObject({
      operationId: request('launch').operationId,
      effectLease: request('launch').effectLease,
    });
  });
});
