import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  type LaneExecutionBackend,
  type LaneExecutionLaunchOutcome,
  type LaneExecutionObserveOutcome,
  type LaneExecutionPreflightDecision,
  type LaneExecutionProviderCapability,
  type LaneExecutionRecoverOutcome,
  type LaneExecutionRequest,
  type LaneExecutionScope,
  type LaneExecutionStopOutcome,
  parseLaneExecutionRef,
} from '@features/team-runtime-control/core/application/backends';
import {
  OpenCodeExecutionBackend,
  type OpenCodeExecutionCompatibilityPorts,
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

interface FakeRegistryAdapter {
  readonly providerId: 'opencode';
}

interface MutableOutcomes {
  preflight: unknown;
  launch: unknown;
  observe: unknown;
  stop: unknown;
  recover: unknown;
}

function hash(character: string): Sha256Hash {
  return `sha256:${character.repeat(64)}` as Sha256Hash;
}

function createScope(providerId: TeamProviderId): LaneExecutionScope {
  const backend: RuntimeExecutionBackendKind =
    providerId === 'opencode' ? 'opencode' : 'provisioning_cli';
  const laneId = parseLaneId('primary');
  const plan = createCompositeRuntimePlan({
    teamId: parseTeamId(`team_${providerId === 'opencode' ? '3'.repeat(32) : '4'.repeat(32)}`),
    runId: parseRunId(`run_${providerId === 'opencode' ? '5'.repeat(32) : '6'.repeat(32)}`),
    generation: 1,
    leadProviderId: providerId,
    lanePlanResult: planTeamRuntimeLanes({
      leadProviderId: providerId,
      members: [{ name: 'worker', providerId }],
    }),
    rosterGeneration: 1,
    memberBindings: [
      {
        memberId: parseMemberId(
          `member_${providerId === 'opencode' ? '7'.repeat(32) : '8'.repeat(32)}`
        ),
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('worker'),
        providerId,
        laneId,
        policy: 'required',
      },
    ],
    laneCredentials: [{ laneId, requiredCredentialExposureSet: { secretRefs: [] } }],
    workspaceBinding: {
      workspaceId: parseWorkspaceId(
        `workspace_${providerId === 'opencode' ? '9'.repeat(32) : 'a'.repeat(32)}`
      ),
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
          bindingRevision: 1,
        },
        laneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId(`binary-${providerId}`),
          binaryRevision: 1,
          binaryHash: hash('3'),
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

function cancellation(): RuntimeCancellation {
  return {
    cancellationId: 'cancel-conformance' as RuntimeCancellationId,
    isCancellationRequested: () => false,
  };
}

function capabilities(request: LaneExecutionRequest): readonly LaneExecutionProviderCapability[] {
  return request.scope.requiredProviderIds.map((providerId) => ({
    backend: request.scope.executionUnit.backendBinding.backend,
    bindingId: request.scope.executionUnit.backendBinding.bindingId,
    bindingRevision: request.scope.executionUnit.backendBinding.bindingRevision,
    providerId,
    capabilityRevision: 1,
    supported: true,
    readiness: 'ready',
  }));
}

function createProvisioningBackend(outcomes: MutableOutcomes): LaneExecutionBackend {
  const ports: ProvisioningCliDeterministicExecutionPorts = {
    readCapabilities: (request) => Promise.resolve(capabilities(request)),
    preflight: () => Promise.resolve(outcomes.preflight as LaneExecutionPreflightDecision),
    launch: () => Promise.resolve(outcomes.launch as LaneExecutionLaunchOutcome),
    observe: () => Promise.resolve(outcomes.observe as LaneExecutionObserveOutcome),
    stop: () => Promise.resolve(outcomes.stop as LaneExecutionStopOutcome),
    recover: () => Promise.resolve(outcomes.recover as LaneExecutionRecoverOutcome),
  };
  return new ProvisioningCliExecutionBackend(ports);
}

function createOpenCodeBackend(outcomes: MutableOutcomes): LaneExecutionBackend {
  const adapter: FakeRegistryAdapter = { providerId: 'opencode' };
  const ports: OpenCodeExecutionCompatibilityPorts<FakeRegistryAdapter> = {
    registry: {
      has: (providerId) => providerId === 'opencode',
      get: () => adapter,
    },
    readCapabilities: (_adapter, request) => Promise.resolve(capabilities(request)),
    preflight: () => Promise.resolve(outcomes.preflight as LaneExecutionPreflightDecision),
    launch: () => Promise.resolve(outcomes.launch as LaneExecutionLaunchOutcome),
    observe: () => Promise.resolve(outcomes.observe as LaneExecutionObserveOutcome),
    stop: () => Promise.resolve(outcomes.stop as LaneExecutionStopOutcome),
    recover: () => Promise.resolve(outcomes.recover as LaneExecutionRecoverOutcome),
  };
  return new OpenCodeExecutionBackend(ports);
}

const cases = [
  {
    name: 'provisioning CLI',
    providerId: 'anthropic' as const,
    providers: ['anthropic', 'codex', 'gemini'],
    create: createProvisioningBackend,
  },
  {
    name: 'OpenCode',
    providerId: 'opencode' as const,
    providers: ['opencode'],
    create: createOpenCodeBackend,
  },
] as const;

describe('lane execution backend conformance', () => {
  it.each(cases)(
    '$name implements the same bounded lifecycle outcome contract',
    async (fixture) => {
      const outcomes: MutableOutcomes = {
        preflight: { status: 'ready' },
        launch: { status: 'launched', executionRef: 'conformance-run' },
        observe: { status: 'stopping' },
        stop: { status: 'stopped' },
        recover: { status: 'not_started' },
      };
      const backend = fixture.create(outcomes);
      const scope = createScope(fixture.providerId);
      const activeCancellation = cancellation();
      const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
      if (preflight.status !== 'ready') throw new Error('expected ready conformance preflight');
      const executionRef = parseLaneExecutionRef('conformance-run');

      expect(backend.supportedProviderIds).toEqual(fixture.providers);
      expect(backend.validatePlan(scope)).toEqual({ status: 'accepted' });
      await expect(
        backend.launch({ scope, cancellation: activeCancellation, readiness: preflight.readiness })
      ).resolves.toEqual({ status: 'launched', executionRef });
      await expect(backend.observe({ scope, executionRef })).resolves.toEqual({
        status: 'stopping',
      });
      await expect(
        backend.stop({ scope, executionRef, mode: 'graceful', cancellation: activeCancellation })
      ).resolves.toEqual({ status: 'stopped' });
      await expect(backend.recover({ scope, cancellation: activeCancellation })).resolves.toEqual({
        status: 'not_started',
      });
    }
  );

  it.each(cases)('$name contains malformed compatibility outcomes', async (fixture) => {
    const outcomes: MutableOutcomes = {
      preflight: { status: 'ready' },
      launch: { status: 'launched', executionRef: 'invalid execution ref' },
      observe: { status: 'invented-state' },
      stop: { status: 'invented-state' },
      recover: { status: 'recovered', executionRef: '' },
    };
    const backend = fixture.create(outcomes);
    const scope = createScope(fixture.providerId);
    const activeCancellation = cancellation();
    const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
    if (preflight.status !== 'ready') throw new Error('expected ready conformance preflight');
    const executionRef = parseLaneExecutionRef('conformance-run');
    const rejected = { status: 'rejected', reason: 'capability_mismatch' };
    const ambiguous = { status: 'operator_required' };

    await expect(
      backend.launch({ scope, cancellation: activeCancellation, readiness: preflight.readiness })
    ).resolves.toEqual(ambiguous);
    await expect(backend.observe({ scope, executionRef })).resolves.toEqual(rejected);
    await expect(
      backend.stop({ scope, executionRef, mode: 'graceful', cancellation: activeCancellation })
    ).resolves.toEqual(ambiguous);
    await expect(backend.recover({ scope, cancellation: activeCancellation })).resolves.toEqual(
      ambiguous
    );
  });

  it.each(cases)(
    '$name preserves explicit unavailable outcomes with ready capability snapshots',
    async (fixture) => {
      const unavailable = { status: 'rejected', reason: 'unavailable' } as const;
      const outcomes: MutableOutcomes = {
        preflight: { status: 'ready' },
        launch: unavailable,
        observe: unavailable,
        stop: unavailable,
        recover: unavailable,
      };
      const backend = fixture.create(outcomes);
      const scope = createScope(fixture.providerId);
      const activeCancellation = cancellation();
      const preflight = await backend.preflight({ scope, cancellation: activeCancellation });
      if (preflight.status !== 'ready') throw new Error('expected ready conformance preflight');
      const executionRef = parseLaneExecutionRef('conformance-run');

      outcomes.preflight = unavailable;
      await expect(backend.preflight({ scope, cancellation: activeCancellation })).resolves.toEqual(
        unavailable
      );
      await expect(
        backend.launch({ scope, cancellation: activeCancellation, readiness: preflight.readiness })
      ).resolves.toEqual(unavailable);
      await expect(backend.observe({ scope, executionRef })).resolves.toEqual(unavailable);
      await expect(
        backend.stop({ scope, executionRef, mode: 'graceful', cancellation: activeCancellation })
      ).resolves.toEqual(unavailable);
      await expect(backend.recover({ scope, cancellation: activeCancellation })).resolves.toEqual(
        unavailable
      );
    }
  );

  it('keeps product adapters free of alternate planners, process creation, and shell globals', () => {
    const productionPaths = [
      'src/features/team-runtime-control/main/adapters/output/backends/ProvisioningCliExecutionBackend.ts',
      'src/features/team-runtime-control/main/adapters/output/backends/OpenCodeExecutionBackend.ts',
    ];
    for (const path of productionPaths) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      expect(source).not.toMatch(/planTeamRuntimeLanes|createCompositeRuntimePlan/);
      expect(source).not.toMatch(/node:child_process|child_process|\.spawn\s*\(|\.exec\s*\(/);
      expect(source).not.toMatch(/electron|window\.|process\.env/);
      expect(source).not.toMatch(/claudePath|apiKey|secretValue|tokenValue/);
    }
  });
});
