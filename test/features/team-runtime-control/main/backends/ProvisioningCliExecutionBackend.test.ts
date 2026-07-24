import {
  createCompositeRuntimePlan,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  type RuntimeCancellation,
  type RuntimeCancellationId,
  type RuntimeExecutionBackendKind,
  type Sha256Hash,
} from '@features/team-runtime-control';
import {
  type CancellableLaneExecutionRequest,
  type LaneExecutionLaunchOutcome,
  type LaneExecutionObserveOutcome,
  type LaneExecutionPreflightDecision,
  type LaneExecutionProviderCapability,
  type LaneExecutionRecoverOutcome,
  type LaneExecutionRequest,
  type LaneExecutionScope,
  type LaneExecutionStopOutcome,
  type LaunchLaneExecutionRequest,
  type ObserveLaneExecutionRequest,
  parseLaneExecutionRef,
  type StopLaneExecutionRequest,
} from '@features/team-runtime-control/core/application/backends';
import {
  type ProvisioningCliDeterministicExecutionPorts,
  ProvisioningCliExecutionBackend,
} from '@features/team-runtime-control/main/adapters/output/backends';
import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type { TeamProviderId } from '@shared/types';

function hash(character: string): Sha256Hash {
  return `sha256:${character.repeat(64)}` as Sha256Hash;
}

function createScope(
  providerId: TeamProviderId,
  backend: RuntimeExecutionBackendKind = providerId === 'opencode' ? 'opencode' : 'provisioning_cli'
): LaneExecutionScope {
  const laneId = parseLaneId('primary');
  const plan = createCompositeRuntimePlan({
    teamId: parseTeamId(`team_${'a'.repeat(32)}`),
    runId: parseRunId(`run_${'b'.repeat(32)}`),
    generation: 1,
    leadProviderId: providerId,
    lanePlanResult: planTeamRuntimeLanes({
      leadProviderId: providerId,
      members: [{ name: 'worker', providerId }],
    }),
    rosterGeneration: 1,
    memberBindings: [
      {
        memberId: parseMemberId(`member_${'c'.repeat(32)}`),
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('worker'),
        providerId,
        laneId,
        policy: 'required',
      },
    ],
    laneCredentials: [{ laneId, requiredCredentialExposureSet: { secretRefs: [] } }],
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'d'.repeat(32)}`),
      registrationRevision: 1,
      bindingGeneration: 1,
      mountGeneration: 1,
    },
    executionUnits: [
      {
        executionUnitId: parseExecutionUnitId(`unit-${providerId}`),
        backendBinding: {
          backend,
          bindingId: parseRuntimeBackendBindingId(`binding-${providerId}`),
          bindingRevision: 3,
        },
        laneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId(`binary-${providerId}`),
          binaryRevision: 1,
          binaryHash: hash('1'),
        },
        environmentPolicy: { policy: 'explicit_allowlist', variables: [] },
        credentialExposureSet: { secretRefs: [] },
        resourcePolicy: {
          maxRuntimeMs: 30_000,
          gracefulStopMs: 2_000,
          maxOutputBytes: 100_000,
          maxProcessCount: 2,
        },
      },
    ],
  });
  return {
    plan,
    lane: plan.lanes[0]!,
    executionUnit: plan.executionUnits[0]!,
    requiredProviderIds: [providerId],
  };
}

function cancellation(cancelled = false): RuntimeCancellation {
  return {
    cancellationId: 'cancel-backend-test' as RuntimeCancellationId,
    isCancellationRequested: () => cancelled,
  };
}

class FakeProvisioningPorts implements ProvisioningCliDeterministicExecutionPorts {
  capabilityRevision = 7;
  capabilityBackend: RuntimeExecutionBackendKind = 'provisioning_cli';
  supported = true;
  readiness: 'ready' | 'not_ready' = 'ready';
  preflightOutcome: LaneExecutionPreflightDecision = { status: 'ready' };
  launchOutcome: LaneExecutionLaunchOutcome = {
    status: 'launched',
    executionRef: parseLaneExecutionRef('provisioning-run-1'),
  };
  observeOutcome: LaneExecutionObserveOutcome = { status: 'ready' };
  stopOutcome: LaneExecutionStopOutcome = { status: 'stopped' };
  recoverOutcome: LaneExecutionRecoverOutcome = {
    status: 'recovered',
    executionRef: parseLaneExecutionRef('provisioning-run-1'),
  };
  readonly calls: string[] = [];

  readCapabilities(
    request: LaneExecutionRequest
  ): Promise<readonly LaneExecutionProviderCapability[]> {
    this.calls.push('readCapabilities');
    return Promise.resolve(
      request.scope.requiredProviderIds.map((providerId) => ({
        backend: this.capabilityBackend,
        bindingId: request.scope.executionUnit.backendBinding.bindingId,
        bindingRevision: request.scope.executionUnit.backendBinding.bindingRevision,
        providerId,
        capabilityRevision: this.capabilityRevision,
        supported: this.supported,
        readiness: this.readiness,
      }))
    );
  }

  preflight(_request: CancellableLaneExecutionRequest): Promise<LaneExecutionPreflightDecision> {
    this.calls.push('preflight');
    return Promise.resolve(this.preflightOutcome);
  }

  launch(_request: LaunchLaneExecutionRequest): Promise<LaneExecutionLaunchOutcome> {
    this.calls.push('launch');
    return Promise.resolve(this.launchOutcome);
  }

  observe(_request: ObserveLaneExecutionRequest): Promise<LaneExecutionObserveOutcome> {
    this.calls.push('observe');
    return Promise.resolve(this.observeOutcome);
  }

  stop(_request: StopLaneExecutionRequest): Promise<LaneExecutionStopOutcome> {
    this.calls.push('stop');
    return Promise.resolve(this.stopOutcome);
  }

  recover(_request: CancellableLaneExecutionRequest): Promise<LaneExecutionRecoverOutcome> {
    this.calls.push('recover');
    return Promise.resolve(this.recoverOutcome);
  }
}

describe('ProvisioningCliExecutionBackend', () => {
  it.each(['anthropic', 'codex', 'gemini'] as const)(
    'validates and preflights the accepted %s lane without re-planning it',
    async (providerId) => {
      const ports = new FakeProvisioningPorts();
      const backend = new ProvisioningCliExecutionBackend(ports);
      const scope = createScope(providerId);

      expect(backend.validatePlan(scope)).toEqual({ status: 'accepted' });
      const result = await backend.preflight({ scope, cancellation: cancellation() });

      expect(result).toMatchObject({
        status: 'ready',
        readiness: {
          backend: 'provisioning_cli',
          laneId: scope.lane.laneId,
          planHash: scope.plan.planHash,
          bindingRevision: 3,
          providerRevisions: [{ providerId, capabilityRevision: 7 }],
        },
      });
      expect(ports.calls).toEqual(['readCapabilities', 'preflight']);
    }
  );

  it('delegates launch, observe, stop, and recover to the injected deterministic flow', async () => {
    const ports = new FakeProvisioningPorts();
    const backend = new ProvisioningCliExecutionBackend(ports);
    const scope = createScope('anthropic');
    const activeCancellation = cancellation();
    const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
    if (preflight.status !== 'ready') throw new Error('expected ready fake preflight');
    const executionRef = parseLaneExecutionRef('provisioning-run-1');

    await expect(
      backend.launch({ scope, cancellation: activeCancellation, readiness: preflight.readiness })
    ).resolves.toEqual({ status: 'launched', executionRef });
    await expect(backend.observe({ scope, executionRef })).resolves.toEqual({ status: 'ready' });
    await expect(
      backend.stop({ scope, executionRef, mode: 'graceful', cancellation: activeCancellation })
    ).resolves.toEqual({ status: 'stopped' });
    await expect(backend.recover({ scope, cancellation: activeCancellation })).resolves.toEqual({
      status: 'recovered',
      executionRef,
    });
    expect(ports.calls).toEqual([
      'readCapabilities',
      'preflight',
      'readCapabilities',
      'launch',
      'readCapabilities',
      'observe',
      'readCapabilities',
      'stop',
      'readCapabilities',
      'recover',
    ]);
  });

  it('contains provider lifecycle outcomes without flattening their state', async () => {
    const ports = new FakeProvisioningPorts();
    ports.observeOutcome = { status: 'exited', outcome: 'failure' };
    ports.stopOutcome = { status: 'operator_required' };
    ports.recoverOutcome = { status: 'not_started' };
    const backend = new ProvisioningCliExecutionBackend(ports);
    const scope = createScope('codex');
    const executionRef = parseLaneExecutionRef('provisioning-run-2');

    await expect(backend.observe({ scope, executionRef })).resolves.toEqual({
      status: 'exited',
      outcome: 'failure',
    });
    await expect(
      backend.stop({ scope, executionRef, mode: 'immediate', cancellation: cancellation() })
    ).resolves.toEqual({ status: 'operator_required' });
    await expect(backend.recover({ scope, cancellation: cancellation() })).resolves.toEqual({
      status: 'not_started',
    });
  });

  it('preserves an explicit unavailable outcome when the capability snapshot is ready', async () => {
    const ports = new FakeProvisioningPorts();
    ports.preflightOutcome = { status: 'rejected', reason: 'unavailable' };
    const backend = new ProvisioningCliExecutionBackend(ports);

    await expect(
      backend.preflight({ scope: createScope('anthropic'), cancellation: cancellation() })
    ).resolves.toEqual({ status: 'rejected', reason: 'unavailable' });
  });

  it('fails closed on unsupported plans, capability identity, readiness, and stale receipts', async () => {
    const ports = new FakeProvisioningPorts();
    const backend = new ProvisioningCliExecutionBackend(ports);
    const openCodeScope = createScope('opencode');
    expect(backend.validatePlan(openCodeScope)).toEqual({
      status: 'rejected',
      reason: 'backend_mismatch',
    });
    await expect(
      backend.preflight({ scope: openCodeScope, cancellation: cancellation() })
    ).resolves.toEqual({ status: 'rejected', reason: 'invalid_plan' });
    expect(ports.calls).toEqual([]);

    const scope = createScope('gemini');
    expect(backend.validatePlan({ ...scope, requiredProviderIds: [] })).toEqual({
      status: 'rejected',
      reason: 'invalid_plan',
    });
    expect(backend.validatePlan({ ...scope, lane: { ...scope.lane } })).toEqual({
      status: 'rejected',
      reason: 'invalid_plan',
    });
    ports.capabilityBackend = 'opencode';
    await expect(backend.preflight({ scope, cancellation: cancellation() })).resolves.toEqual({
      status: 'rejected',
      reason: 'capability_mismatch',
    });
    expect(ports.calls).toEqual(['readCapabilities']);

    ports.calls.length = 0;
    ports.capabilityBackend = 'provisioning_cli';
    ports.readiness = 'not_ready';
    await expect(backend.preflight({ scope, cancellation: cancellation() })).resolves.toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
    expect(ports.calls).toEqual(['readCapabilities']);

    ports.calls.length = 0;
    ports.readiness = 'ready';
    const preflight = await backend.preflight({ scope, cancellation: cancellation() });
    if (preflight.status !== 'ready') throw new Error('expected ready fake preflight');
    ports.capabilityRevision += 1;
    await expect(
      backend.launch({ scope, cancellation: cancellation(), readiness: preflight.readiness })
    ).resolves.toEqual({ status: 'rejected', reason: 'readiness_mismatch' });
    expect(ports.calls.at(-1)).toBe('readCapabilities');
    expect(ports.calls).not.toContain('launch');
  });

  it('short-circuits cancelled operations before any compatibility effect', async () => {
    const ports = new FakeProvisioningPorts();
    const backend = new ProvisioningCliExecutionBackend(ports);
    const scope = createScope('anthropic');

    await expect(backend.preflight({ scope, cancellation: cancellation(true) })).resolves.toEqual({
      status: 'rejected',
      reason: 'cancelled',
    });
    await expect(backend.recover({ scope, cancellation: cancellation(true) })).resolves.toEqual({
      status: 'cancelled',
    });
    expect(ports.calls).toEqual([]);
  });
});
