import {
  createCompositeRuntimePlan,
  type LaneId,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  type RuntimeExecutionBackendKind,
  type Sha256Hash,
} from '@features/team-runtime-control';
import {
  ExecutionBackendRegistry,
  ExecutionBackendRegistryConfigurationError,
  type LaneExecutionBackend,
} from '@features/team-runtime-control/core/application/backends';
import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { TeamProviderId } from '@shared/types';

function hash(character: string): Sha256Hash {
  return `sha256:${character.repeat(64)}` as Sha256Hash;
}

function createMixedPlan() {
  const primaryLaneId = parseLaneId('primary');
  const secondaryLaneId = parseLaneId('secondary:opencode:reviewer');
  const lanePlanResult = planTeamRuntimeLanes({
    leadProviderId: 'anthropic',
    members: [
      { name: 'builder', providerId: 'codex' },
      { name: 'reviewer', providerId: 'opencode' },
    ],
  });
  return createCompositeRuntimePlan({
    teamId: parseTeamId(`team_${'a'.repeat(32)}`),
    runId: parseRunId(`run_${'b'.repeat(32)}`),
    generation: 1,
    leadProviderId: 'anthropic',
    lanePlanResult,
    rosterGeneration: 1,
    memberBindings: [
      {
        memberId: parseMemberId(`member_${'c'.repeat(32)}`),
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('builder'),
        providerId: 'codex',
        laneId: primaryLaneId,
        policy: 'required',
      },
      {
        memberId: parseMemberId(`member_${'d'.repeat(32)}`),
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('reviewer'),
        providerId: 'opencode',
        laneId: secondaryLaneId,
        policy: 'required',
      },
    ],
    laneCredentials: [primaryLaneId, secondaryLaneId].map((laneId) => ({
      laneId,
      requiredCredentialExposureSet: { secretRefs: [] },
    })),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'e'.repeat(32)}`),
      registrationRevision: 1,
      bindingGeneration: 1,
      mountGeneration: 1,
    },
    executionUnits: [
      executionUnit('primary-unit', primaryLaneId, 'provisioning_cli', '1'),
      executionUnit('opencode-unit', secondaryLaneId, 'opencode', '2'),
    ],
  });
}

function executionUnit(
  suffix: string,
  laneId: LaneId,
  backend: RuntimeExecutionBackendKind,
  hashCharacter: string
) {
  return {
    executionUnitId: parseExecutionUnitId(`unit-${suffix}`),
    backendBinding: {
      backend,
      bindingId: parseRuntimeBackendBindingId(`binding-${suffix}`),
      bindingRevision: 1,
    },
    laneId,
    binaryPolicy: {
      policy: 'registered_exact_binary' as const,
      binaryId: parseRuntimeBinaryId(`binary-${suffix}`),
      binaryRevision: 1,
      binaryHash: hash(hashCharacter),
    },
    environmentPolicy: { policy: 'explicit_allowlist' as const, variables: [] },
    credentialExposureSet: { secretRefs: [] },
    resourcePolicy: {
      maxRuntimeMs: 30_000,
      gracefulStopMs: 2_000,
      maxOutputBytes: 100_000,
      maxProcessCount: 2,
    },
  };
}

function fakeBackend(
  backend: RuntimeExecutionBackendKind,
  supportedProviderIds: readonly TeamProviderId[],
  accepted = true
): LaneExecutionBackend {
  return {
    backend,
    supportedProviderIds,
    validatePlan: vi.fn(() =>
      accepted
        ? ({ status: 'accepted' as const } as const)
        : ({ status: 'rejected' as const, reason: 'invalid_plan' as const } as const)
    ),
    preflight: vi.fn(() =>
      Promise.resolve({ status: 'rejected' as const, reason: 'unavailable' as const })
    ),
    launch: vi.fn(() =>
      Promise.resolve({ status: 'rejected' as const, reason: 'unavailable' as const })
    ),
    observe: vi.fn(() => Promise.resolve({ status: 'operator_required' as const })),
    stop: vi.fn(() => Promise.resolve({ status: 'operator_required' as const })),
    recover: vi.fn(() => Promise.resolve({ status: 'operator_required' as const })),
  };
}

describe('ExecutionBackendRegistry', () => {
  it('resolves each immutable planner lane to exactly one backend', () => {
    const provisioning = fakeBackend('provisioning_cli', ['anthropic', 'codex', 'gemini']);
    const openCode = fakeBackend('opencode', ['opencode']);
    const registry = new ExecutionBackendRegistry([openCode, provisioning]);
    const plan = createMixedPlan();

    const primary = registry.resolve(plan, parseLaneId('primary'));
    const secondary = registry.resolve(plan, parseLaneId('secondary:opencode:reviewer'));

    expect(primary).toMatchObject({
      status: 'resolved',
      backend: provisioning,
      scope: { requiredProviderIds: ['anthropic', 'codex'] },
    });
    expect(secondary).toMatchObject({
      status: 'resolved',
      backend: openCode,
      scope: { requiredProviderIds: ['opencode'] },
    });
    expect(provisioning.validatePlan).toHaveBeenCalledOnce();
    expect(openCode.validatePlan).toHaveBeenCalledOnce();
  });

  it('has deterministic backend order independent of registration order', () => {
    const provisioning = fakeBackend('provisioning_cli', ['anthropic', 'codex', 'gemini']);
    const openCode = fakeBackend('opencode', ['opencode']);

    expect(
      new ExecutionBackendRegistry([openCode, provisioning])
        .backends()
        .map(({ backend }) => backend)
    ).toEqual(['provisioning_cli', 'opencode']);
    expect(
      new ExecutionBackendRegistry([provisioning, openCode])
        .backends()
        .map(({ backend }) => backend)
    ).toEqual(['provisioning_cli', 'opencode']);
  });

  it('rejects duplicate backend or provider ownership at registration', () => {
    const provisioning = fakeBackend('provisioning_cli', ['anthropic']);

    expect(
      () => new ExecutionBackendRegistry([provisioning, fakeBackend('provisioning_cli', ['codex'])])
    ).toThrow(
      expect.objectContaining<Partial<ExecutionBackendRegistryConfigurationError>>({
        code: 'duplicate_backend',
      })
    );
    expect(
      () => new ExecutionBackendRegistry([provisioning, fakeBackend('opencode', ['anthropic'])])
    ).toThrow(
      expect.objectContaining<Partial<ExecutionBackendRegistryConfigurationError>>({
        code: 'duplicate_provider',
      })
    );
  });

  it('fails closed for missing ownership, missing lanes, stale plans, and backend rejection', () => {
    const plan = createMixedPlan();
    const provisioning = fakeBackend('provisioning_cli', ['anthropic', 'codex', 'gemini']);
    const openCode = fakeBackend('opencode', ['opencode']);

    expect(
      new ExecutionBackendRegistry([provisioning]).resolve(plan, plan.orderedLaneIds[1]!)
    ).toEqual({ status: 'rejected', reason: 'backend_not_registered' });
    expect(new ExecutionBackendRegistry([openCode]).resolve(plan, plan.orderedLaneIds[0]!)).toEqual(
      {
        status: 'rejected',
        reason: 'backend_not_registered',
      }
    );
    expect(
      new ExecutionBackendRegistry([provisioning, openCode]).resolve(
        plan,
        parseLaneId('missing-lane')
      )
    ).toEqual({ status: 'rejected', reason: 'lane_not_found' });

    const stalePlan = { ...plan, generation: plan.generation + 1 };
    expect(
      new ExecutionBackendRegistry([provisioning, openCode]).resolve(
        stalePlan as typeof plan,
        plan.orderedLaneIds[0]!
      )
    ).toEqual({ status: 'rejected', reason: 'invalid_plan' });

    const rejecting = fakeBackend('provisioning_cli', ['anthropic', 'codex', 'gemini'], false);
    expect(
      new ExecutionBackendRegistry([rejecting, openCode]).resolve(plan, plan.orderedLaneIds[0]!)
    ).toMatchObject({ status: 'rejected', reason: 'backend_rejected' });
  });
});
