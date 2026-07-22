import { createHash } from 'node:crypto';

import {
  type CompositeRuntimePlan,
  type CompositeRuntimePlanErrorCode,
  CompositeRuntimePlanValidationError,
  createCompositeRuntimePlan,
  type CreateCompositeRuntimePlanInput,
  decodeCompositeRuntimePlan,
  isCurrentCompositeRuntimePlan,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  parseSecretClass,
  parseSecretRefId,
  type SecretRefMetadata,
  type Sha256Hash,
} from '@features/team-runtime-control';
import * as teamRuntimeControlApi from '@features/team-runtime-control';
import { planTeamRuntimeLanes, type TeamRuntimeLanePlanResult } from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const sha256 = (character: string): Sha256Hash => `sha256:${character.repeat(64)}` as Sha256Hash;
const memberId = (character: string) => parseMemberId(`member_${character.repeat(32)}`);

const secretRef = (id: string, secretClass = 'provider-api-key'): SecretRefMetadata => ({
  secretRefId: parseSecretRefId(id),
  secretClass: parseSecretClass(secretClass),
});

type MutableCreateCompositeRuntimePlanInput = {
  -readonly [Key in keyof CreateCompositeRuntimePlanInput]: CreateCompositeRuntimePlanInput[Key];
};

function createInput(
  overrides: Partial<CreateCompositeRuntimePlanInput> = {}
): MutableCreateCompositeRuntimePlanInput {
  const primaryLaneId = parseLaneId('primary');
  const sideLaneId = parseLaneId('secondary:opencode:bob');
  const primarySecret = secretRef('secret-primary');
  const sideSecret = secretRef('secret-side', 'provider-account');

  return {
    teamId: parseTeamId(`team_${'a'.repeat(32)}`),
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
    rosterGeneration: 11,
    memberBindings: [
      {
        memberId: memberId('a'),
        memberRevision: 3,
        legacyMemberKey: parseLegacyMemberKey('alice'),
        providerId: 'anthropic',
        laneId: primaryLaneId,
        policy: 'required',
      },
      {
        memberId: memberId('b'),
        memberRevision: 5,
        legacyMemberKey: parseLegacyMemberKey('bob'),
        providerId: 'opencode',
        laneId: sideLaneId,
        policy: 'optional',
      },
    ],
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
    ...overrides,
  };
}

function expectPlanError(run: () => unknown, code: CompositeRuntimePlanErrorCode): void {
  try {
    run();
    throw new Error('expected runtime-plan rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(CompositeRuntimePlanValidationError);
    expect((error as CompositeRuntimePlanValidationError).code).toBe(code);
  }
}

type MutableRecord = Record<string, unknown>;
type MutablePersistedMemberBinding = MutableRecord & {
  legacyMemberKey: string;
  memberId: string;
  laneId: string;
};
type MutablePersistedExecutionUnit = MutableRecord & {
  backendBinding: MutableRecord;
  credentialIsolation: string;
  environmentPolicy: MutableRecord & { variables: unknown[] };
  laneId: string;
  memberIds: string[];
  resourcePolicy: MutableRecord;
};
type MutablePersistedPlan = MutableRecord & {
  executionUnits: MutablePersistedExecutionUnit[];
  generation: number;
  lanes: Array<MutableRecord & { laneId: string }>;
  memberBindings: MutablePersistedMemberBinding[];
  orderedLaneIds: string[];
  planHash: string;
};

function mutablePersistedPlan(plan: CompositeRuntimePlan): MutablePersistedPlan {
  return JSON.parse(JSON.stringify(plan)) as MutablePersistedPlan;
}

function recomputePlanHash(plan: MutablePersistedPlan): void {
  const { planHash: _planHash, ...body } = plan;
  plan.planHash = `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

describe('team-runtime-control root API', () => {
  it('publishes only the explicit runtime-plan value surface', () => {
    expect(Object.keys(teamRuntimeControlApi).sort()).toEqual([
      'COMPOSITE_RUNTIME_PLAN_VERSION',
      'CompositeRuntimePlanValidationError',
      'HOSTED_CHILD_ENVIRONMENT_PROVENANCE',
      'RUNTIME_EXECUTION_BACKENDS',
      'RUNTIME_TOPOLOGY_MODES',
      'createCompositeRuntimePlan',
      'decodeCompositeRuntimePlan',
      'isCurrentCompositeRuntimePlan',
      'parseExecutionUnitId',
      'parseLaneId',
      'parseRuntimeBackendBindingId',
      'parseRuntimeBinaryId',
      'parseSecretClass',
      'parseSecretRefId',
    ]);
  });
});

describe('createCompositeRuntimePlan', () => {
  it('maps the exact team-runtime-lanes result without accepting caller-authored topology', () => {
    const first = createCompositeRuntimePlan(createInput());
    const second = createCompositeRuntimePlan(createInput());
    const { planHash: _planHash, ...hashBody } = first;

    expect(first).toEqual(second);
    expect(first.planHash).toBe(
      `sha256:${createHash('sha256').update(canonicalJson(hashBody)).digest('hex')}`
    );
    expect(first.topologyMode).toBe('mixed_opencode_side_lanes');
    expect(first.orderedLaneIds).toEqual([
      parseLaneId('primary'),
      parseLaneId('secondary:opencode:bob'),
    ]);
    expect(first.lanes.map((lane) => lane.memberIds)).toEqual([[memberId('a')], [memberId('b')]]);

    expectPlanError(
      () =>
        createCompositeRuntimePlan({
          ...createInput(),
          topologyMode: 'primary_only',
          lanes: [],
        } as unknown as CreateCompositeRuntimePlanInput),
      'invalid_field'
    );
  });

  it('rejects rejected planner results, cloned planner members, and lane merging', () => {
    expectPlanError(
      () =>
        createCompositeRuntimePlan(
          createInput({
            lanePlanResult: planTeamRuntimeLanes({
              leadProviderId: 'opencode',
              members: [{ name: 'alice', providerId: 'anthropic' }],
            }),
          })
        ),
      'lane_plan_rejected'
    );

    const clonedMemberInput = createInput();
    const clonedResult = clonedMemberInput.lanePlanResult;
    if (!clonedResult.ok) throw new Error('fixture planner unexpectedly rejected');
    clonedMemberInput.lanePlanResult = {
      ok: true,
      plan: {
        ...clonedResult.plan,
        primaryMembers: [{ ...clonedResult.plan.primaryMembers[0]! }],
      },
    } as TeamRuntimeLanePlanResult;
    expectPlanError(() => createCompositeRuntimePlan(clonedMemberInput), 'lane_plan_mismatch');

    const mergedLaneInput = createInput();
    const mergedResult = mergedLaneInput.lanePlanResult;
    if (!mergedResult.ok) throw new Error('fixture planner unexpectedly rejected');
    mergedLaneInput.lanePlanResult = {
      ok: true,
      plan: { ...mergedResult.plan, primaryMembers: [...mergedResult.plan.allMembers] },
    } as TeamRuntimeLanePlanResult;
    expectPlanError(() => createCompositeRuntimePlan(mergedLaneInput), 'lane_plan_mismatch');
  });

  it('accepts exact empty and non-lexical primary roster order emitted by the planner', () => {
    const emptyInput = createInput();
    const emptyPlan = createCompositeRuntimePlan({
      ...emptyInput,
      lanePlanResult: planTeamRuntimeLanes({ leadProviderId: 'anthropic', members: [] }),
      memberBindings: [],
      laneCredentials: [emptyInput.laneCredentials[0]!],
      executionUnits: [emptyInput.executionUnits[0]!],
    });
    expect(emptyPlan.topologyMode).toBe('primary_only');
    expect(emptyPlan.memberBindings).toEqual([]);
    expect(emptyPlan.lanes[0]?.memberIds).toEqual([]);
    expect(isCurrentCompositeRuntimePlan(emptyPlan)).toBe(true);

    const orderedInput = createInput();
    const orderedPlan = createCompositeRuntimePlan({
      ...orderedInput,
      lanePlanResult: planTeamRuntimeLanes({
        leadProviderId: 'anthropic',
        members: [
          { name: 'alice', providerId: 'anthropic' },
          { name: 'bob', providerId: 'anthropic' },
        ],
      }),
      memberBindings: [
        { ...orderedInput.memberBindings[0]!, memberId: memberId('b') },
        {
          ...orderedInput.memberBindings[1]!,
          memberId: memberId('a'),
          providerId: 'anthropic',
          laneId: parseLaneId('primary'),
        },
      ],
      laneCredentials: [orderedInput.laneCredentials[0]!],
      executionUnits: [orderedInput.executionUnits[0]!],
    });
    expect(orderedPlan.lanes[0]?.memberIds).toEqual([memberId('b'), memberId('a')]);
    expect(isCurrentCompositeRuntimePlan(orderedPlan)).toBe(true);
  });

  it('rejects canonical-id lookalikes and exact or case-folded legacy-key ambiguity', () => {
    expect(() => parseMemberId(`member_${'A'.repeat(32)}`)).toThrow(
      'hosted-contract-canonical-identifier-invalid'
    );
    expect(() => parseRunId('run-001')).toThrow('hosted-contract-canonical-identifier-invalid');

    const duplicate = createInput();
    duplicate.memberBindings = [
      duplicate.memberBindings[0]!,
      { ...duplicate.memberBindings[1]!, legacyMemberKey: parseLegacyMemberKey('alice') },
    ];
    expectPlanError(() => createCompositeRuntimePlan(duplicate), 'duplicate_legacy_member_key');

    const caseFolded = createInput();
    caseFolded.memberBindings = [
      caseFolded.memberBindings[0]!,
      { ...caseFolded.memberBindings[1]!, legacyMemberKey: parseLegacyMemberKey('ALICE') },
    ];
    expectPlanError(() => createCompositeRuntimePlan(caseFolded), 'case_fold_ambiguity');
  });

  it('binds the hash to lifecycle, roster, workspace, environment, and resource policy', () => {
    const original = createCompositeRuntimePlan(createInput());
    const variants = [
      createCompositeRuntimePlan(createInput({ generation: 8 })),
      createCompositeRuntimePlan(createInput({ rosterGeneration: 12 })),
      createCompositeRuntimePlan(
        createInput({
          workspaceBinding: { ...createInput().workspaceBinding, mountGeneration: 10 },
        })
      ),
      createCompositeRuntimePlan({
        ...createInput(),
        executionUnits: createInput().executionUnits.map((unit, index) =>
          index === 0
            ? {
                ...unit,
                resourcePolicy: { ...unit.resourcePolicy, maxOutputBytes: 1_000_001 },
              }
            : unit
        ),
      }),
    ];

    expect(new Set([original.planHash, ...variants.map((plan) => plan.planHash)]).size).toBe(5);
  });

  it('enforces exact credential exposure and explicit environment provenance', () => {
    const widened = createInput();
    widened.executionUnits = widened.executionUnits.map((unit, index) =>
      index === 0
        ? {
            ...unit,
            credentialExposureSet: {
              secretRefs: [secretRef('secret-primary'), secretRef('secret-z-extra')],
            },
          }
        : unit
    );
    expectPlanError(() => createCompositeRuntimePlan(widened), 'credential_exposure_widened');

    const missing = createInput();
    missing.executionUnits = missing.executionUnits.map((unit, index) =>
      index === 0 ? { ...unit, credentialExposureSet: { secretRefs: [] } } : unit
    );
    expectPlanError(() => createCompositeRuntimePlan(missing), 'credential_exposure_missing');

    const secretNotExposed = createInput();
    secretNotExposed.executionUnits = secretNotExposed.executionUnits.map((unit, index) =>
      index === 0
        ? {
            ...unit,
            environmentPolicy: {
              policy: 'explicit_allowlist' as const,
              variables: [
                {
                  name: 'FOREIGN_SECRET',
                  provenance: 'secret_ref' as const,
                  secretRef: secretRef('secret-foreign'),
                },
              ],
            },
          }
        : unit
    );
    expectPlanError(
      () => createCompositeRuntimePlan(secretNotExposed),
      'credential_exposure_widened'
    );

    const inheritedEnvironment = createInput();
    inheritedEnvironment.executionUnits = inheritedEnvironment.executionUnits.map((unit, index) =>
      index === 0
        ? {
            ...unit,
            environmentPolicy: {
              policy: 'inherit_process_environment',
              variables: [],
            } as unknown as typeof unit.environmentPolicy,
          }
        : unit
    );
    expectPlanError(() => createCompositeRuntimePlan(inheritedEnvironment), 'invalid_field');

    const valueBearing = createInput();
    valueBearing.executionUnits = valueBearing.executionUnits.map((unit, index) =>
      index === 0
        ? {
            ...unit,
            credentialExposureSet: {
              secretRefs: [
                {
                  ...secretRef('secret-primary'),
                  value: 'must-not-enter-plan',
                } as SecretRefMetadata,
              ],
            },
          }
        : unit
    );
    expectPlanError(() => createCompositeRuntimePlan(valueBearing), 'credential_metadata_only');
  });

  it('derives isolation per exact planner lane and never merges execution units', () => {
    const plan = createCompositeRuntimePlan(createInput());

    expect(plan.executionUnits).toHaveLength(plan.lanes.length);
    expect(plan.executionUnits.map((unit) => unit.laneId)).toEqual(plan.orderedLaneIds);
    expect(plan.executionUnits.map((unit) => unit.credentialIsolation)).toEqual([
      'shared_execution_unit',
      'dedicated_execution_unit',
    ]);

    const missingUnit = createInput();
    missingUnit.executionUnits = [missingUnit.executionUnits[0]!];
    expectPlanError(() => createCompositeRuntimePlan(missingUnit), 'lane_plan_mismatch');

    const mergedUnit = createInput();
    mergedUnit.executionUnits = [
      {
        ...mergedUnit.executionUnits[0]!,
        laneId: parseLaneId('primary'),
      },
      {
        ...mergedUnit.executionUnits[1]!,
        laneId: parseLaneId('primary'),
      },
    ];
    expectPlanError(() => createCompositeRuntimePlan(mergedUnit), 'lane_plan_mismatch');
  });

  it('rejects unstable ordering rather than sorting authoritative facts', () => {
    const memberOrder = createInput();
    memberOrder.memberBindings = [...memberOrder.memberBindings].reverse();
    expectPlanError(() => createCompositeRuntimePlan(memberOrder), 'lane_plan_mismatch');

    const plannerOrder = createInput();
    const primaryOnlyResult = planTeamRuntimeLanes({
      leadProviderId: 'anthropic',
      members: [
        { name: 'alice', providerId: 'anthropic' },
        { name: 'bob', providerId: 'anthropic' },
      ],
    });
    if (!primaryOnlyResult.ok || primaryOnlyResult.plan.mode !== 'primary_only') {
      throw new Error('fixture planner returned unexpected topology');
    }
    plannerOrder.lanePlanResult = {
      ok: true,
      plan: {
        ...primaryOnlyResult.plan,
        primaryMembers: [...primaryOnlyResult.plan.primaryMembers].reverse(),
      },
    };
    plannerOrder.memberBindings = [
      plannerOrder.memberBindings[0]!,
      {
        ...plannerOrder.memberBindings[1]!,
        providerId: 'anthropic',
        laneId: parseLaneId('primary'),
      },
    ];
    plannerOrder.laneCredentials = [plannerOrder.laneCredentials[0]!];
    plannerOrder.executionUnits = [plannerOrder.executionUnits[0]!];
    expectPlanError(() => createCompositeRuntimePlan(plannerOrder), 'unstable_ordering');

    const unitOrder = createInput();
    unitOrder.executionUnits = [...unitOrder.executionUnits].reverse();
    expectPlanError(() => createCompositeRuntimePlan(unitOrder), 'lane_plan_mismatch');

    const credentialOrder = createInput();
    credentialOrder.executionUnits = credentialOrder.executionUnits.map((unit, index) =>
      index === 0
        ? {
            ...unit,
            environmentPolicy: {
              policy: 'explicit_allowlist' as const,
              variables: [...unit.environmentPolicy.variables].reverse(),
            },
          }
        : unit
    );
    expectPlanError(() => createCompositeRuntimePlan(credentialOrder), 'unstable_ordering');
  });

  it('returns a deeply frozen snapshot detached from mutable inputs', () => {
    const input = createInput();
    const plan = createCompositeRuntimePlan(input);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.lanes[0]?.requiredCredentialExposureSet.secretRefs)).toBe(true);
    expect(Object.isFrozen(plan.executionUnits[0]?.environmentPolicy.variables)).toBe(true);
    expect(() => {
      (plan as unknown as { generation: number }).generation = 99;
    }).toThrow();

    (input.executionUnits[0]!.credentialExposureSet.secretRefs as SecretRefMetadata[]).push(
      secretRef('secret-z-after-plan')
    );
    expect(plan.executionUnits[0]?.credentialExposureSet.secretRefs).toHaveLength(1);
  });
});

describe('decodeCompositeRuntimePlan', () => {
  it('rehydrates only a complete semantically valid persisted plan', () => {
    const original = createCompositeRuntimePlan(createInput());
    const decoded = decodeCompositeRuntimePlan(mutablePersistedPlan(original));

    expect(decoded).toEqual(original);
    expect(decoded).not.toBe(original);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.executionUnits[0]?.resourcePolicy)).toBe(true);
    expect(isCurrentCompositeRuntimePlan(mutablePersistedPlan(original))).toBe(true);
  });

  it('rejects malicious semantic changes even when their hash is recomputed', () => {
    const original = createCompositeRuntimePlan(createInput());
    const cases: Array<{
      code: CompositeRuntimePlanErrorCode;
      mutate: (plan: MutablePersistedPlan) => void;
    }> = [
      {
        code: 'missing_lane_binding',
        mutate: (plan) => {
          plan.memberBindings[1]!.laneId = 'primary';
        },
      },
      {
        code: 'persisted_plan_invalid',
        mutate: (plan) => {
          plan.executionUnits[1]!.memberIds = [plan.memberBindings[0]!.memberId];
        },
      },
      {
        code: 'persisted_plan_invalid',
        mutate: (plan) => {
          plan.executionUnits[1]!.credentialIsolation = 'shared_execution_unit';
        },
      },
      {
        code: 'unsupported_topology',
        mutate: (plan) => {
          plan.executionUnits[1]!.backendBinding.backend = 'provisioning_cli';
        },
      },
      {
        code: 'lane_plan_mismatch',
        mutate: (plan) => {
          const forgedLaneId = 'secondary:opencode:not-bob';
          plan.orderedLaneIds[1] = forgedLaneId;
          plan.lanes[1]!.laneId = forgedLaneId;
          plan.memberBindings[1]!.laneId = forgedLaneId;
          plan.executionUnits[1]!.laneId = forgedLaneId;
        },
      },
      {
        code: 'case_fold_ambiguity',
        mutate: (plan) => {
          plan.memberBindings[1]!.legacyMemberKey = 'ALICE';
        },
      },
      {
        code: 'invalid_field',
        mutate: (plan) => {
          plan.executionUnits[0]!.resourcePolicy.gracefulStopMs = 60_001;
        },
      },
      {
        code: 'credential_exposure_widened',
        mutate: (plan) => {
          plan.executionUnits[0]!.environmentPolicy.variables = [
            {
              name: 'FOREIGN_SECRET',
              provenance: 'secret_ref',
              secretRef: {
                secretRefId: 'secret-foreign',
                secretClass: 'provider-api-key',
              },
            },
          ];
        },
      },
    ];

    for (const adversary of cases) {
      const persisted = mutablePersistedPlan(original);
      adversary.mutate(persisted);
      recomputePlanHash(persisted);
      expectPlanError(() => decodeCompositeRuntimePlan(persisted), adversary.code);
      expect(isCurrentCompositeRuntimePlan(persisted)).toBe(false);
    }
  });

  it('rejects unknown persisted fields and content changes with a stale hash', () => {
    const original = createCompositeRuntimePlan(createInput());
    const unknownField = mutablePersistedPlan(original);
    unknownField.cwd = '/forbidden/raw/authority';
    expectPlanError(() => decodeCompositeRuntimePlan(unknownField), 'persisted_plan_invalid');

    const staleHash = mutablePersistedPlan(original);
    staleHash.generation += 1;
    expectPlanError(() => decodeCompositeRuntimePlan(staleHash), 'plan_hash_mismatch');
  });
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
