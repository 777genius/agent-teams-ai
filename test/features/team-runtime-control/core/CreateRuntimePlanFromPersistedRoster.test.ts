import {
  type CompositeRuntimePlanErrorCode,
  CompositeRuntimePlanValidationError,
  CreateRuntimePlanFromPersistedRoster,
  type CreateRuntimePlanFromPersistedRosterInput,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  parseSecretClass,
  parseSecretRefId,
  type PersistedTeamRosterPlanSource,
  type SecretRefMetadata,
  type Sha256Hash,
} from '@features/team-runtime-control';
import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const sha256 = (character: string): Sha256Hash => `sha256:${character.repeat(64)}` as Sha256Hash;
const secretRef = (id: string, secretClass: string): SecretRefMetadata => ({
  secretRefId: parseSecretRefId(id),
  secretClass: parseSecretClass(secretClass),
});
const teamId = parseTeamId(`team_${'a'.repeat(32)}`);

function input(): CreateRuntimePlanFromPersistedRosterInput {
  const primaryLaneId = parseLaneId('primary');
  const sideLaneId = parseLaneId('secondary:opencode:bob');
  const primarySecret = secretRef('secret-primary', 'provider-api-key');
  const sideSecret = secretRef('secret-side', 'provider-account');
  return {
    teamId,
    runId: parseRunId(`run_${'1'.repeat(32)}`),
    generation: 7,
    leadProviderId: 'anthropic',
    lanePlanResult: planTeamRuntimeLanes({
      leadProviderId: 'anthropic',
      members: [
        { name: 'alice', providerId: 'anthropic' },
        { name: 'bob', providerId: 'opencode' },
      ],
    }),
    laneCredentials: [
      {
        laneId: primaryLaneId,
        requiredCredentialExposureSet: { secretRefs: [primarySecret] },
      },
      {
        laneId: sideLaneId,
        requiredCredentialExposureSet: { secretRefs: [sideSecret] },
      },
    ],
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
      registrationRevision: 2,
      bindingGeneration: 4,
      mountGeneration: 9,
    },
    executionUnits: [
      {
        executionUnitId: parseExecutionUnitId('unit-primary'),
        backendBinding: {
          backend: 'provisioning_cli',
          bindingId: parseRuntimeBackendBindingId('backend-provisioning'),
          bindingRevision: 6,
        },
        laneId: primaryLaneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId('binary-provisioning'),
          binaryRevision: 8,
          binaryHash: sha256('1'),
        },
        environmentPolicy: {
          policy: 'explicit_allowlist',
          variables: [
            { name: 'PROVIDER_API_KEY', provenance: 'secret_ref', secretRef: primarySecret },
            { name: 'RUNTIME_TEAM_ID', provenance: 'runtime_metadata' },
          ],
        },
        credentialExposureSet: { secretRefs: [primarySecret] },
        resourcePolicy: {
          maxRuntimeMs: 60_000,
          gracefulStopMs: 5_000,
          maxOutputBytes: 1_000_000,
          maxProcessCount: 8,
        },
      },
      {
        executionUnitId: parseExecutionUnitId('unit-opencode-bob'),
        backendBinding: {
          backend: 'opencode',
          bindingId: parseRuntimeBackendBindingId('backend-opencode'),
          bindingRevision: 3,
        },
        laneId: sideLaneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId('binary-opencode'),
          binaryRevision: 4,
          binaryHash: sha256('3'),
        },
        environmentPolicy: {
          policy: 'explicit_allowlist',
          variables: [
            { name: 'OPENCODE_PROFILE', provenance: 'workspace_metadata' },
            { name: 'PROVIDER_ACCOUNT', provenance: 'secret_ref', secretRef: sideSecret },
          ],
        },
        credentialExposureSet: { secretRefs: [sideSecret] },
        resourcePolicy: {
          maxRuntimeMs: 120_000,
          gracefulStopMs: 10_000,
          maxOutputBytes: 2_000_000,
          maxProcessCount: 4,
        },
      },
    ],
  };
}

function source(
  overrides: Partial<
    Awaited<ReturnType<PersistedTeamRosterPlanSource['getPersistedTeamRoster']>>
  > = {}
) {
  const getPersistedTeamRoster = vi.fn(async () => ({
    teamId,
    rosterGeneration: 11,
    members: [
      {
        memberId: parseMemberId(`member_${'a'.repeat(32)}`),
        legacyMemberKey: parseLegacyMemberKey('alice'),
        memberRevision: 3,
        state: 'active' as const,
        providerId: 'anthropic' as const,
        model: null,
        role: null,
        workflow: null,
        isolation: null,
      },
      {
        memberId: parseMemberId(`member_${'b'.repeat(32)}`),
        legacyMemberKey: parseLegacyMemberKey('bob'),
        memberRevision: 5,
        state: 'active' as const,
        providerId: 'opencode' as const,
        model: null,
        role: null,
        workflow: null,
        isolation: null,
      },
      {
        memberId: parseMemberId(`member_${'c'.repeat(32)}`),
        legacyMemberKey: parseLegacyMemberKey('retired'),
        memberRevision: 7,
        state: 'removed' as const,
        providerId: 'anthropic' as const,
        model: null,
        role: null,
        workflow: null,
        isolation: null,
      },
    ],
    ...overrides,
  }));
  return { getPersistedTeamRoster };
}

describe('CreateRuntimePlanFromPersistedRoster', () => {
  it('reads one aggregate snapshot and binds its exact generation, MemberIds, and revisions', async () => {
    const rosterSource = source();
    const plan = await new CreateRuntimePlanFromPersistedRoster(rosterSource).execute(input());

    expect(rosterSource.getPersistedTeamRoster).toHaveBeenCalledTimes(1);
    expect(rosterSource.getPersistedTeamRoster).toHaveBeenCalledWith(teamId);
    expect(plan.rosterGeneration).toBe(11);
    expect(plan.memberBindings).toEqual([
      expect.objectContaining({
        memberId: parseMemberId(`member_${'a'.repeat(32)}`),
        memberRevision: 3,
        legacyMemberKey: 'alice',
        laneId: 'primary',
      }),
      expect.objectContaining({
        memberId: parseMemberId(`member_${'b'.repeat(32)}`),
        memberRevision: 5,
        legacyMemberKey: 'bob',
        laneId: 'secondary:opencode:bob',
      }),
    ]);
    expect(plan.memberBindings.some(({ legacyMemberKey }) => legacyMemberKey === 'retired')).toBe(
      false
    );
  });

  it('fails closed when the persisted roster is absent or cannot exactly cover the planner', async () => {
    await expectPlanError(
      () =>
        new CreateRuntimePlanFromPersistedRoster({
          getPersistedTeamRoster: async () => null,
        }).execute(input()),
      'persisted_roster_missing'
    );
    await expectPlanError(
      () =>
        new CreateRuntimePlanFromPersistedRoster(
          source({
            members: [
              {
                memberId: parseMemberId(`member_${'a'.repeat(32)}`),
                legacyMemberKey: parseLegacyMemberKey('ALICE'),
                memberRevision: 3,
                state: 'active',
                providerId: 'anthropic',
                model: null,
                role: null,
                workflow: null,
                isolation: null,
              },
            ],
          })
        ).execute(input()),
      'persisted_roster_mismatch'
    );
    await expectPlanError(
      () =>
        new CreateRuntimePlanFromPersistedRoster(
          source({
            members: [
              {
                memberId: parseMemberId(`member_${'a'.repeat(32)}`),
                legacyMemberKey: parseLegacyMemberKey('alice'),
                memberRevision: 3,
                state: 'active',
                providerId: 'anthropic',
                model: null,
                role: null,
                workflow: null,
                isolation: null,
              },
              {
                memberId: parseMemberId(`member_${'b'.repeat(32)}`),
                legacyMemberKey: parseLegacyMemberKey('alice-2'),
                memberRevision: 5,
                state: 'active',
                providerId: 'opencode',
                model: null,
                role: null,
                workflow: null,
                isolation: null,
              },
            ],
          })
        ).execute(input()),
      'persisted_roster_mismatch'
    );
    const mismatchedPlannerInput = {
      ...input(),
      lanePlanResult: planTeamRuntimeLanes({
        leadProviderId: 'anthropic',
        members: [
          { name: 'alice', providerId: 'anthropic', model: 'caller-authored-model' },
          { name: 'bob', providerId: 'opencode' },
        ],
      }),
    };
    await expectPlanError(
      () => new CreateRuntimePlanFromPersistedRoster(source()).execute(mismatchedPlannerInput),
      'persisted_roster_mismatch'
    );
  });
});

async function expectPlanError(
  run: () => Promise<unknown>,
  code: CompositeRuntimePlanErrorCode
): Promise<void> {
  try {
    await run();
    throw new Error('expected runtime-plan rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(CompositeRuntimePlanValidationError);
    expect((error as CompositeRuntimePlanValidationError).code).toBe(code);
  }
}
