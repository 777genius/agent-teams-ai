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
  OpenCodeExecutionBackend,
  type OpenCodeExecutionCompatibilityPorts,
  type TeamRuntimeAdapterRegistryCompatiblePort,
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

interface FakeRuntimeAdapter {
  readonly providerId: TeamProviderId;
  readonly adapterId: string;
}

function hash(character: string): Sha256Hash {
  return `sha256:${character.repeat(64)}` as Sha256Hash;
}

function createScope(
  providerId: TeamProviderId = 'opencode',
  backend: RuntimeExecutionBackendKind = providerId === 'opencode' ? 'opencode' : 'provisioning_cli'
): LaneExecutionScope {
  const laneId = parseLaneId('primary');
  const plan = createCompositeRuntimePlan({
    teamId: parseTeamId(`team_${'e'.repeat(32)}`),
    runId: parseRunId(`run_${'f'.repeat(32)}`),
    generation: 2,
    leadProviderId: providerId,
    lanePlanResult: planTeamRuntimeLanes({
      leadProviderId: providerId,
      members: [{ name: 'worker', providerId }],
    }),
    rosterGeneration: 1,
    memberBindings: [
      {
        memberId: parseMemberId(`member_${'1'.repeat(32)}`),
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('worker'),
        providerId,
        laneId,
        policy: 'required',
      },
    ],
    laneCredentials: [{ laneId, requiredCredentialExposureSet: { secretRefs: [] } }],
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'2'.repeat(32)}`),
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
          bindingRevision: 4,
        },
        laneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId(`binary-${providerId}`),
          binaryRevision: 1,
          binaryHash: hash('2'),
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
    cancellationId: 'cancel-opencode-test' as RuntimeCancellationId,
    isCancellationRequested: () => cancelled,
  };
}

class FakeAdapterRegistry implements TeamRuntimeAdapterRegistryCompatiblePort<FakeRuntimeAdapter> {
  available = true;
  adapter: FakeRuntimeAdapter = { providerId: 'opencode', adapterId: 'adapter-1' };
  readonly calls: string[] = [];

  has(providerId: TeamProviderId): boolean {
    this.calls.push(`has:${providerId}`);
    return this.available;
  }

  get(providerId: TeamProviderId): FakeRuntimeAdapter {
    this.calls.push(`get:${providerId}`);
    return this.adapter;
  }
}

class FakeOpenCodePorts implements OpenCodeExecutionCompatibilityPorts<FakeRuntimeAdapter> {
  readonly registry = new FakeAdapterRegistry();
  capabilityRevision = 11;
  supported = true;
  readiness: 'ready' | 'not_ready' = 'ready';
  preflightOutcome: LaneExecutionPreflightDecision = { status: 'ready' };
  launchOutcome: LaneExecutionLaunchOutcome = {
    status: 'launched',
    executionRef: parseLaneExecutionRef('opencode-run-1'),
  };
  observeOutcome: LaneExecutionObserveOutcome = { status: 'starting' };
  stopOutcome: LaneExecutionStopOutcome = { status: 'stopped' };
  recoverOutcome: LaneExecutionRecoverOutcome = {
    status: 'recovered',
    executionRef: parseLaneExecutionRef('opencode-run-1'),
  };
  readonly calls: Array<{ readonly operation: string; readonly adapter: FakeRuntimeAdapter }> = [];

  readCapabilities(
    adapter: FakeRuntimeAdapter,
    request: LaneExecutionRequest
  ): Promise<readonly LaneExecutionProviderCapability[]> {
    this.calls.push({ operation: 'readCapabilities', adapter });
    return Promise.resolve(
      request.scope.requiredProviderIds.map((providerId) => ({
        backend: 'opencode',
        bindingId: request.scope.executionUnit.backendBinding.bindingId,
        bindingRevision: request.scope.executionUnit.backendBinding.bindingRevision,
        providerId,
        capabilityRevision: this.capabilityRevision,
        supported: this.supported,
        readiness: this.readiness,
      }))
    );
  }

  preflight(
    adapter: FakeRuntimeAdapter,
    _request: CancellableLaneExecutionRequest
  ): Promise<LaneExecutionPreflightDecision> {
    this.calls.push({ operation: 'preflight', adapter });
    return Promise.resolve(this.preflightOutcome);
  }

  launch(
    adapter: FakeRuntimeAdapter,
    _request: LaunchLaneExecutionRequest
  ): Promise<LaneExecutionLaunchOutcome> {
    this.calls.push({ operation: 'launch', adapter });
    return Promise.resolve(this.launchOutcome);
  }

  observe(
    adapter: FakeRuntimeAdapter,
    _request: ObserveLaneExecutionRequest
  ): Promise<LaneExecutionObserveOutcome> {
    this.calls.push({ operation: 'observe', adapter });
    return Promise.resolve(this.observeOutcome);
  }

  stop(
    adapter: FakeRuntimeAdapter,
    _request: StopLaneExecutionRequest
  ): Promise<LaneExecutionStopOutcome> {
    this.calls.push({ operation: 'stop', adapter });
    return Promise.resolve(this.stopOutcome);
  }

  recover(
    adapter: FakeRuntimeAdapter,
    _request: CancellableLaneExecutionRequest
  ): Promise<LaneExecutionRecoverOutcome> {
    this.calls.push({ operation: 'recover', adapter });
    return Promise.resolve(this.recoverOutcome);
  }
}

describe('OpenCodeExecutionBackend', () => {
  it('uses the injected registry-compatible adapter for the full lane lifecycle', async () => {
    const ports = new FakeOpenCodePorts();
    const backend = new OpenCodeExecutionBackend(ports);
    const scope = createScope();
    const activeCancellation = cancellation();
    const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
    if (preflight.status !== 'ready') throw new Error('expected ready fake preflight');
    const executionRef = parseLaneExecutionRef('opencode-run-1');

    expect(backend.validatePlan(scope)).toEqual({ status: 'accepted' });
    expect(preflight.readiness).toMatchObject({
      backend: 'opencode',
      bindingRevision: 4,
      providerRevisions: [{ providerId: 'opencode', capabilityRevision: 11 }],
    });
    await expect(
      backend.launch({ scope, cancellation: activeCancellation, readiness: preflight.readiness })
    ).resolves.toEqual({ status: 'launched', executionRef });
    await expect(backend.observe({ scope, executionRef })).resolves.toEqual({ status: 'starting' });
    await expect(
      backend.stop({ scope, executionRef, mode: 'graceful', cancellation: activeCancellation })
    ).resolves.toEqual({ status: 'stopped' });
    await expect(backend.recover({ scope, cancellation: activeCancellation })).resolves.toEqual({
      status: 'recovered',
      executionRef,
    });

    expect(ports.calls.map(({ operation }) => operation)).toEqual([
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
    expect(ports.calls.every(({ adapter }) => adapter === ports.registry.adapter)).toBe(true);
    expect(ports.registry.calls).toEqual(
      Array.from({ length: 5 }, () => ['has:opencode', 'get:opencode']).flat()
    );
  });

  it('preserves observe, stop, and recovery outcome distinctions', async () => {
    const ports = new FakeOpenCodePorts();
    ports.observeOutcome = { status: 'degraded' };
    ports.stopOutcome = { status: 'already_stopped' };
    ports.recoverOutcome = { status: 'operator_required' };
    const backend = new OpenCodeExecutionBackend(ports);
    const scope = createScope();
    const executionRef = parseLaneExecutionRef('opencode-run-2');

    await expect(backend.observe({ scope, executionRef })).resolves.toEqual({ status: 'degraded' });
    await expect(
      backend.stop({ scope, executionRef, mode: 'immediate', cancellation: cancellation() })
    ).resolves.toEqual({ status: 'already_stopped' });
    await expect(backend.recover({ scope, cancellation: cancellation() })).resolves.toEqual({
      status: 'operator_required',
    });
  });

  it('preserves an explicit unavailable outcome when the capability snapshot is ready', async () => {
    const ports = new FakeOpenCodePorts();
    ports.preflightOutcome = { status: 'rejected', reason: 'unavailable' };
    const backend = new OpenCodeExecutionBackend(ports);

    await expect(
      backend.preflight({ scope: createScope(), cancellation: cancellation() })
    ).resolves.toEqual({ status: 'rejected', reason: 'unavailable' });
  });

  it('fails closed when the registry is absent or returns the wrong provider adapter', async () => {
    const ports = new FakeOpenCodePorts();
    const backend = new OpenCodeExecutionBackend(ports);
    const scope = createScope();

    ports.registry.available = false;
    await expect(backend.preflight({ scope, cancellation: cancellation() })).resolves.toEqual({
      status: 'rejected',
      reason: 'unsupported',
    });
    expect(ports.calls).toEqual([]);
    expect(ports.registry.calls).toEqual(['has:opencode']);

    ports.registry.available = true;
    ports.registry.adapter = { providerId: 'codex', adapterId: 'wrong-adapter' };
    await expect(backend.preflight({ scope, cancellation: cancellation() })).resolves.toEqual({
      status: 'rejected',
      reason: 'capability_mismatch',
    });
    expect(ports.calls).toEqual([]);
  });

  it('rejects a provisioning lane and stale readiness without invoking launch', async () => {
    const ports = new FakeOpenCodePorts();
    const backend = new OpenCodeExecutionBackend(ports);
    const provisioningScope = createScope('anthropic');

    expect(backend.validatePlan(provisioningScope)).toEqual({
      status: 'rejected',
      reason: 'backend_mismatch',
    });
    await expect(
      backend.preflight({ scope: provisioningScope, cancellation: cancellation() })
    ).resolves.toEqual({ status: 'rejected', reason: 'invalid_plan' });
    expect(ports.registry.calls).toEqual([]);

    const scope = createScope();
    const preflight = await backend.preflight({ scope, cancellation: cancellation() });
    if (preflight.status !== 'ready') throw new Error('expected ready fake preflight');
    ports.capabilityRevision += 1;
    await expect(
      backend.launch({ scope, cancellation: cancellation(), readiness: preflight.readiness })
    ).resolves.toEqual({ status: 'rejected', reason: 'readiness_mismatch' });
    expect(ports.calls.map(({ operation }) => operation)).not.toContain('launch');
  });

  it('treats a readiness claim that contradicts capability facts as a mismatch', async () => {
    const ports = new FakeOpenCodePorts();
    ports.readiness = 'not_ready';
    ports.observeOutcome = { status: 'ready' };
    const backend = new OpenCodeExecutionBackend(ports);
    const scope = createScope();
    const executionRef = parseLaneExecutionRef('opencode-run-3');

    await expect(backend.preflight({ scope, cancellation: cancellation() })).resolves.toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
    await expect(backend.observe({ scope, executionRef })).resolves.toEqual({
      status: 'rejected',
      reason: 'readiness_mismatch',
    });
  });
});
