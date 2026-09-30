import { compileHostedPromotionPlan } from '@features/team-configuration';
import {
  type HostedRosterConfiguration,
  parseHostedRosterConfiguration,
} from '@features/team-configuration/contracts';
import {
  type CompositeRuntimePlan,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  type RuntimePlanMemberBinding,
  type Sha256Hash,
} from '@features/team-runtime-control/contracts';
import {
  createCompositeRuntimePlan,
  type CreateCompositeRuntimePlanInput,
  type HostedOwnerProjectionAuthority,
  HostedOwnerProjectionError,
  type HostedOwnerProjectionErrorCode,
  type HostedOwnerProjectorCapabilities,
  type HostedOwnerResolvedMemberFact,
  type PlannedRuntimeMember,
  projectHostedOwnerLaunchPlan,
  type ProjectHostedOwnerLaunchPlanInput,
} from '@features/team-runtime-control/core/application/planning';
import {
  planTeamRuntimeLanes,
  type RuntimeLanePlannerMemberInput,
} from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { isTeamEffortLevelForProvider } from '@shared/utils/effortLevels';
import { sha256Hex } from '@shared/utils/sha256';
import { describe, expect, it } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const workspaceId = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const runId = parseRunId(`run_${'c'.repeat(32)}`);
const memberId = (character: string) => parseMemberId(`member_${character.repeat(32)}`);
const hash = (character: string): Sha256Hash => `sha256:${character.repeat(64)}` as Sha256Hash;
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
const projectorCapabilities: HostedOwnerProjectorCapabilities = {
  sha256Utf8: sha256Hex,
  isEffortAllowedForProvider: isTeamEffortLevelForProvider,
};

const fourProviderConfiguration = parseHostedRosterConfiguration({
  schemaVersion: 1,
  toolApprovalMode: 'auto',
  lanes: [
    {
      kind: 'native',
      provider: 'anthropic',
      members: [{ name: 'alpha', prompt: 'Lead.', model: 'claude-opus-4-6' }],
    },
    {
      kind: 'opencode',
      provider: 'opencode',
      selectedModel: 'openai/gpt-6',
      effort: 'medium',
      members: [
        { name: 'team-lead', prompt: 'A.' },
        { name: 'open-b', prompt: 'B.', model: 'google/gemini-3.1-pro', effort: 'high' },
      ],
    },
    {
      kind: 'native',
      provider: 'codex',
      members: [{ name: 'coder', prompt: 'Code.', model: 'gpt-5.6', effort: 'medium' }],
    },
    {
      kind: 'native',
      provider: 'gemini',
      members: [{ name: 'gem', prompt: 'UX.', model: 'gemini-3.1-pro' }],
    },
  ],
});

const openCodeConfiguration = parseHostedRosterConfiguration({
  schemaVersion: 1,
  toolApprovalMode: 'auto',
  lanes: [
    {
      kind: 'opencode',
      provider: 'opencode',
      selectedModel: 'openai/gpt-6',
      members: [
        { name: 'team-lead', prompt: 'A.' },
        { name: 'open-b', prompt: 'B.', model: 'google/gemini-3.1-pro', effort: 'high' },
      ],
    },
    {
      kind: 'opencode',
      provider: 'opencode',
      selectedModel: 'anthropic/claude-sonnet-4-6',
      effort: 'low',
      members: [{ name: 'open-c', prompt: 'C.' }],
    },
  ],
});

type TestRuntimeMember = PlannedRuntimeMember & RuntimeLanePlannerMemberInput;

const fourProviderMembers: readonly TestRuntimeMember[] = [
  { name: 'team-lead', providerId: 'opencode' as const, model: 'openai/gpt-6', effort: 'medium' },
  { name: 'alpha', providerId: 'anthropic' as const, model: 'claude-opus-4-6' },
  { name: 'coder', providerId: 'codex' as const, model: 'gpt-5.6', effort: 'medium' },
  {
    name: 'open-b',
    providerId: 'opencode' as const,
    model: 'google/gemini-3.1-pro',
    effort: 'high',
  },
  { name: 'gem', providerId: 'gemini' as const, model: 'gemini-3.1-pro' },
];

const openCodeMembers: readonly TestRuntimeMember[] = [
  {
    name: 'open-c',
    providerId: 'opencode' as const,
    model: 'anthropic/claude-sonnet-4-6',
    effort: 'low',
  },
  { name: 'team-lead', providerId: 'opencode' as const, model: 'openai/gpt-6', effort: 'medium' },
  {
    name: 'open-b',
    providerId: 'opencode' as const,
    model: 'google/gemini-3.1-pro',
    effort: 'high',
  },
];

const ids = new Map([
  ['team-lead', memberId('1')],
  ['alpha', memberId('2')],
  ['coder', memberId('3')],
  ['open-b', memberId('4')],
  ['gem', memberId('5')],
  ['open-c', memberId('6')],
]);

function createRealProductPlan(input: {
  members: readonly TestRuntimeMember[];
  leadProviderId: 'anthropic' | 'opencode';
  leadModel?: string;
  toolApprovalMode?: 'auto' | 'manual';
}): CompositeRuntimePlan {
  const lanePlanResult = planTeamRuntimeLanes({
    leadProviderId: input.leadProviderId,
    leadModel: input.leadModel,
    members: [...input.members],
  });
  if (!lanePlanResult.ok) throw new Error(lanePlanResult.reason);
  const laneFor = new Map(
    lanePlanResult.plan.sideLanes.map((lane) => [lane.member.name, lane.laneId])
  );
  const memberBindings = input.members.map(
    (member): RuntimePlanMemberBinding => ({
      memberId: ids.get(member.name)!,
      memberRevision: 7,
      legacyMemberKey: parseLegacyMemberKey(member.name),
      providerId: member.providerId,
      laneId: parseLaneId(laneFor.get(member.name) ?? 'primary'),
      policy: 'required',
    })
  );
  const plannedLanes = [
    {
      laneId: parseLaneId('primary'),
      backend:
        input.leadProviderId === 'opencode'
          ? ('opencode' as const)
          : ('provisioning_cli' as const),
    },
    ...lanePlanResult.plan.sideLanes.map((lane) => ({
      laneId: parseLaneId(lane.laneId),
      backend: 'opencode' as const,
    })),
  ];
  const createInput: CreateCompositeRuntimePlanInput = {
    teamId,
    runId,
    generation: 19,
    toolApprovalMode: input.toolApprovalMode ?? 'auto',
    leadProviderId: input.leadProviderId,
    lanePlanResult,
    rosterGeneration: 13,
    memberBindings,
    laneCredentials: plannedLanes.map(({ laneId }) => ({
      laneId,
      requiredCredentialExposureSet: { secretRefs: [] },
    })),
    workspaceBinding: {
      workspaceId,
      registrationRevision: 3,
      bindingGeneration: 5,
      mountGeneration: 8,
    },
    executionUnits: plannedLanes.map(({ laneId, backend }, index) => ({
      executionUnitId: parseExecutionUnitId(`unit-${index}`),
      backendBinding: {
        backend,
        bindingId: parseRuntimeBackendBindingId(`backend-${index}`),
        bindingRevision: 2,
      },
      laneId,
      binaryPolicy: {
        policy: 'registered_exact_binary',
        binaryId: parseRuntimeBinaryId(`binary-${index}`),
        binaryRevision: 4,
        binaryHash: hash(String(index + 1)),
      },
      environmentPolicy: { policy: 'explicit_allowlist', variables: [] },
      credentialExposureSet: { secretRefs: [] },
      resourcePolicy: {
        maxRuntimeMs: 60_000,
        gracefulStopMs: 5_000,
        maxOutputBytes: 1_000_000,
        maxProcessCount: 8,
      },
    })),
  };
  return createCompositeRuntimePlan(createInput);
}

function resolvedFacts(
  configuration: HostedRosterConfiguration,
  productPlan: CompositeRuntimePlan
): HostedOwnerResolvedMemberFact[] {
  const configured = new Map(
    configuration.lanes.flatMap((lane) =>
      lane.members.map((member) => [
        member.name,
        {
          model: member.model ?? (lane.kind === 'opencode' ? lane.selectedModel : ''),
          modelSource: member.model === undefined ? ('lane' as const) : ('member' as const),
          effort:
            member.effort !== undefined
              ? ({ kind: 'resolved', source: 'member', value: member.effort } as const)
              : lane.kind === 'opencode' && lane.effort !== undefined
                ? ({ kind: 'resolved', source: 'lane', value: lane.effort } as const)
                : ({ kind: 'resolved', source: 'provider_default', value: 'medium' } as const),
        },
      ] as const)
    )
  );
  return productPlan.memberBindings.map((binding) => ({
    memberId: binding.memberId,
    memberRevision: binding.memberRevision,
    legacyMemberKey: binding.legacyMemberKey,
    providerId: binding.providerId,
    ...configured.get(binding.legacyMemberKey)!,
  }));
}

function createInput(options: {
  capabilities?: HostedOwnerProjectorCapabilities;
  configuration?: HostedRosterConfiguration;
  members?: readonly TestRuntimeMember[];
  leadProviderId?: 'anthropic' | 'opencode';
  leadModel?: string;
  toolApprovalMode?: 'auto' | 'manual';
  primary?: string;
} = {}): ProjectHostedOwnerLaunchPlanInput {
  const configuration = options.configuration ?? openCodeConfiguration;
  const members = options.members ?? openCodeMembers;
  const originalProductPlan = createRealProductPlan({
    members,
    leadProviderId: options.leadProviderId ?? 'opencode',
    leadModel: options.leadModel,
    toolApprovalMode: options.toolApprovalMode,
  });
  const laneIds = configuration.lanes.map((_, index) =>
    `lane_${String(index + 1).repeat(32)}`
  );
  const planJson = compileHostedPromotionPlan({
    runtimeWorkspaceId: workspaceId,
    originalTeamId: teamId,
    admittedWorkspaceRoot: '/srv/workspaces/project',
    configuration,
    laneIds,
  });
  const planSha256 = sha256Hex(planJson);
  const runtimePlanRef = {
    teamId: originalProductPlan.teamId,
    runId: originalProductPlan.runId,
    generation: originalProductPlan.generation,
    planHash: originalProductPlan.planHash,
  };
  const resolutionSnapshot = deepFreeze({
    frozenPromotionSha256: planSha256,
    runtimePlanRef,
    productRevision: 23,
    resolutionRevision: 29,
    resolverRevision: 31,
    designatedPrimaryMemberId: ids.get(options.primary ?? 'open-b')!,
    members: resolvedFacts(configuration, originalProductPlan),
  });
  return {
    frozenPromotion: {
      planJson,
      planSha256,
      runtimeWorkspaceId: workspaceId,
      originalTeamId: teamId,
      admittedWorkspaceRoot: '/srv/workspaces/project',
      laneIds,
      configuration,
    },
    originalProductPlan,
    capabilities: options.capabilities ?? projectorCapabilities,
    authority: {
      runtimePlanRef,
      workspaceBinding: originalProductPlan.workspaceBinding,
      workspaceRoot: '/srv/workspaces/project',
      productRevision: 23,
      resolutionSnapshot,
      isCurrent: () => true,
    },
  };
}

function expectProjectionError(run: () => unknown, code: HostedOwnerProjectionErrorCode): void {
  try {
    run();
    throw new Error('expected projection rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(HostedOwnerProjectionError);
    expect((error as HostedOwnerProjectionError).code).toBe(code);
  }
}

describe('projectHostedOwnerLaunchPlan', () => {
  it('projects repeated provider lanes, interleaved ordinals and a later primary', () => {
    const input = createInput({ leadModel: 'openai/gpt-6' });
    const originalBytes = JSON.stringify(input.originalProductPlan);
    const result = projectHostedOwnerLaunchPlan(input);

    expect(result.binding.originalProductPlan).toBe(input.originalProductPlan);
    expect(JSON.stringify(input.originalProductPlan)).toBe(originalBytes);
    expect(result.plan.primaryOrdinal).toBe(2);
    expect(result.plan.lanes.map((lane) => lane.members.map((member) => member.ordinal))).toEqual([
      [1, 2],
      [0],
    ]);
    expect(result.binding.members.map((member) => member.ordinal)).toEqual([0, 1, 2]);
    expect(result.binding.members[0]).toMatchObject({
      ownerLaneId: `lane_${'2'.repeat(32)}`,
      ownerMemberIndex: 0,
      agentId: ids.get('open-c'),
    });
    expect(result.binding.ownerPlanGeneration).toBe(
      `plan-generation_${sha256Hex(result.planJson)}`
    );
    expect(result.binding.resolutionRevision).toBe(29);
    expect(result.binding.resolverRevision).toBe(31);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.binding.members)).toBe(true);
  });

  it('fails closed for the real grouped native four-provider topology without rewriting it', () => {
    const input = createInput({
      configuration: fourProviderConfiguration,
      members: fourProviderMembers,
      leadProviderId: 'anthropic',
      primary: 'gem',
    });
    const productIdentity = input.originalProductPlan;
    const productBytes = JSON.stringify(productIdentity);
    const promotionBytes = input.frozenPromotion.planJson;

    expectProjectionError(() => projectHostedOwnerLaunchPlan(input), 'unsupported_native_topology');
    expect(input.originalProductPlan).toBe(productIdentity);
    expect(JSON.stringify(input.originalProductPlan)).toBe(productBytes);
    expect(input.frozenPromotion.planJson).toBe(promotionBytes);
  });

  it('does not treat a singleton Product unit as Owner native recipe evidence', () => {
    const configuration = parseHostedRosterConfiguration({
      schemaVersion: 1,
      toolApprovalMode: 'auto',
      lanes: [
        {
          kind: 'native',
          provider: 'codex',
          members: [{ name: 'team-lead', prompt: 'Code.', model: 'gpt-5.6' }],
        },
      ],
    });
    const input = createInput({
      configuration,
      members: [{ name: 'team-lead', providerId: 'codex', model: 'gpt-5.6' }],
      leadProviderId: 'anthropic',
      primary: 'team-lead',
    });
    expect(input.originalProductPlan.executionUnits[0]?.memberIds).toEqual([ids.get('team-lead')]);
    expectProjectionError(() => projectHostedOwnerLaunchPlan(input), 'unsupported_native_topology');
  });

  it('captures original, receiver and method before callback mutation', () => {
    const capabilities = {
      hashCalls: 0,
      effortCalls: 0,
      sha256Utf8(value: string) {
        this.hashCalls += 1;
        return sha256Hex(value);
      },
      isEffortAllowedForProvider(
        value: Parameters<typeof isTeamEffortLevelForProvider>[0],
        providerId: Parameters<typeof isTeamEffortLevelForProvider>[1]
      ) {
        this.effortCalls += 1;
        return isTeamEffortLevelForProvider(value, providerId);
      },
    } satisfies HostedOwnerProjectorCapabilities & {
      hashCalls: number;
      effortCalls: number;
    };
    const input = createInput({ leadModel: 'openai/gpt-6', capabilities });
    const originalPlan = input.originalProductPlan;
    const authority = input.authority as HostedOwnerProjectionAuthority & {
      current: boolean;
      calls: number;
      isCurrent(binding: unknown): boolean;
    };
    authority.current = true;
    authority.calls = 0;
    authority.isCurrent = function () {
      this.calls += 1;
      const mutableInput = input as unknown as Record<string, unknown>;
      const mutableAuthority = authority as unknown as Record<string, unknown>;
      mutableInput.originalProductPlan = createInput().originalProductPlan;
      mutableInput.authority = { ...authority, isCurrent: () => true };
      mutableInput.capabilities = projectorCapabilities;
      mutableAuthority.productRevision = 999;
      mutableAuthority.resolutionSnapshot = createInput().authority.resolutionSnapshot;
      capabilities.sha256Utf8 = () => 'invalid';
      capabilities.isEffortAllowedForProvider = (_value): _value is never => false;
      return this.current;
    };

    const result = projectHostedOwnerLaunchPlan(input);
    expect(result.binding.originalProductPlan).toBe(originalPlan);
    expect(result.binding.productRevision).toBe(23);
    expect(result.binding.resolutionRevision).toBe(29);
    expect(authority.calls).toBe(1);
    expect(capabilities.hashCalls).toBe(2);
    expect(capabilities.effortCalls).toBe(3);
    (input as unknown as { originalProductPlan: CompositeRuntimePlan }).originalProductPlan =
      createInput().originalProductPlan;
    (input as unknown as { authority: HostedOwnerProjectionAuthority }).authority = {
      ...authority,
      isCurrent: () => true,
    };
    authority.isCurrent = () => true;
    authority.current = false;
    expect(result.binding.isCurrent()).toBe(false);
    expect(authority.calls).toBe(2);
  });

  it('rejects invalid SHA-256 capability output for either exact byte sequence', () => {
    const invalidPromotionHash = createInput({
      capabilities: {
        ...projectorCapabilities,
        sha256Utf8: () => 'A'.repeat(64),
      },
    });
    expectProjectionError(
      () => projectHostedOwnerLaunchPlan(invalidPromotionHash),
      'frozen_promotion_invalid'
    );

    let calls = 0;
    const invalidSchema3Hash = createInput({
      capabilities: {
        ...projectorCapabilities,
        sha256Utf8(value) {
          calls += 1;
          return calls === 1 ? sha256Hex(value) : 'not-a-sha256';
        },
      },
    });
    expectProjectionError(
      () => projectHostedOwnerLaunchPlan(invalidSchema3Hash),
      'frozen_promotion_invalid'
    );
    expect(calls).toBe(2);
  });

  it('binds resolved settings and primary to the authority snapshot', () => {
    const base = createInput({ leadModel: 'openai/gpt-6' });
    const facts = base.authority.resolutionSnapshot.members;
    const replaceFacts = (members: readonly HostedOwnerResolvedMemberFact[]) => ({
      ...base,
      authority: {
        ...base.authority,
        resolutionSnapshot: deepFreeze({ ...base.authority.resolutionSnapshot, members }),
      },
    });
    expect(facts.find((fact) => fact.legacyMemberKey === 'team-lead')?.effort).toEqual({
      kind: 'resolved',
      source: 'provider_default',
      value: 'medium',
    });
    expect(facts.find((fact) => fact.legacyMemberKey === 'open-c')?.effort).toEqual({
      kind: 'resolved',
      source: 'lane',
      value: 'low',
    });
    for (const members of [
      facts.map((fact) =>
        fact.legacyMemberKey === 'open-b' ? { ...fact, model: 'openai/other' } : fact
      ),
      facts.map((fact) =>
        fact.legacyMemberKey === 'team-lead'
          ? {
              ...fact,
              effort: { kind: 'resolved', source: 'provider_default', value: 'ultra' } as const,
            }
          : fact
      ),
      facts.map((fact) =>
        fact.legacyMemberKey === 'open-c'
          ? {
              ...fact,
              effort: {
                kind: 'resolved',
                source: 'provider_default',
                value: 'low',
              } as const,
            }
          : fact
      ),
    ]) {
      expectProjectionError(
        () => projectHostedOwnerLaunchPlan(replaceFacts(members)),
        'resolved_configuration_mismatch'
      );
    }
    expectProjectionError(
      () =>
        projectHostedOwnerLaunchPlan({
          ...base,
          authority: {
            ...base.authority,
            resolutionSnapshot: deepFreeze({
              ...base.authority.resolutionSnapshot,
              designatedPrimaryMemberId: memberId('f'),
            }),
          },
        }),
      'primary_member_invalid'
    );
  });

  it('rejects stale scope, unauthenticated facts and manual Product promotion', () => {
    const base = createInput({ leadModel: 'openai/gpt-6' });
    expectProjectionError(
      () =>
        projectHostedOwnerLaunchPlan({
          ...base,
          authority: {
            ...base.authority,
            resolutionSnapshot: deepFreeze({
              ...base.authority.resolutionSnapshot,
              resolutionRevision: 30,
            }),
            isCurrent(binding) {
              return binding.resolutionSnapshot.resolutionRevision === 29;
            },
          },
        }),
      'projection_stale'
    );
    const changedConfiguration = parseHostedRosterConfiguration({
      ...openCodeConfiguration,
      lanes: openCodeConfiguration.lanes.map((lane, index) =>
        index === 0 ? { ...lane, effort: 'high' } : lane
      ),
    });
    const changedMembers = openCodeMembers.map((member) =>
      member.name === 'team-lead' ? { ...member, effort: 'high' as const } : member
    );
    const changedModelConfiguration = parseHostedRosterConfiguration({
      ...openCodeConfiguration,
      lanes: openCodeConfiguration.lanes.map((lane, laneIndex) => ({
        ...lane,
        members: lane.members.map((member) =>
          laneIndex === 0 && member.name === 'open-b'
            ? { ...member, model: 'openai/other' }
            : member
        ),
      })),
    });
    const changedModelMembers = openCodeMembers.map((member) =>
      member.name === 'open-b' ? { ...member, model: 'openai/other' } : member
    );
    const unauthenticatedCandidates = [
      createInput({
        configuration: changedConfiguration,
        members: changedMembers,
        leadProviderId: 'opencode',
        leadModel: 'openai/gpt-6',
      }),
      createInput({
        configuration: changedModelConfiguration,
        members: changedModelMembers,
        leadProviderId: 'opencode',
        leadModel: 'openai/gpt-6',
      }),
    ];
    for (const selfConsistentButUnauthenticated of unauthenticatedCandidates) {
      expect(selfConsistentButUnauthenticated.originalProductPlan.planHash).toBe(
        base.originalProductPlan.planHash
      );
      expectProjectionError(
        () =>
          projectHostedOwnerLaunchPlan({
            ...selfConsistentButUnauthenticated,
            authority: {
              ...selfConsistentButUnauthenticated.authority,
              isCurrent(binding) {
                return (
                  binding.resolutionSnapshot.frozenPromotionSha256 ===
                  base.authority.resolutionSnapshot.frozenPromotionSha256
                );
              },
            },
          }),
        'projection_stale'
      );
    }
    const manual = createInput({
      configuration: openCodeConfiguration,
      members: openCodeMembers,
      leadProviderId: 'opencode',
      toolApprovalMode: 'manual',
    });
    expectProjectionError(() => projectHostedOwnerLaunchPlan(manual), 'runtime_identity_mismatch');
  });

  it('keeps the canonical OpenCode-led mixed limitation explicit', () => {
    expect(
      planTeamRuntimeLanes({
        leadProviderId: 'opencode',
        members: [
          { name: 'team-lead', providerId: 'opencode' },
          { name: 'coder', providerId: 'codex' },
        ],
      })
    ).toMatchObject({ ok: false, reason: 'unsupported_opencode_led_mixed_team' });
  });
});
