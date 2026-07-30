import {
  type LegacyMemberKey,
  type MemberId,
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';

import {
  COMPOSITE_RUNTIME_PLAN_VERSION,
  type CompositeRuntimePlan,
  type CredentialExposureSet,
  type LaneId,
  parseLaneId,
  type ProcessExecutionUnit,
  type RegisteredWorkspaceRuntimeBinding,
  type RuntimePlanLaneBinding,
  type RuntimePlanMemberBinding,
  type RuntimeTopologyMode,
} from '../../../contracts';
import {
  type CompositeRuntimePlanHashBody,
  createCompositeRuntimePlanHash,
  deepFreezeRuntimePlan,
} from '../../domain/CompositeRuntimePlan';

import {
  type ResolvedProcessExecutionUnitFact,
  validateCredentialExposureSet,
  validatePersistedExecutionUnits,
  validatePersistedLaneOrder,
  validateResolvedExecutionUnits,
  validateSecretRefClassConsistency,
  validateWorkspaceBinding,
} from './runtimeExecutionPlanValidation';
import {
  assertAllowedRecordKeys,
  assertExactRecord,
  assertPlainRecord,
  fail,
  foldLegacyMemberKey,
  validateDenseArray,
  validateDenseNonEmptyArray,
  validateIdentifier,
  validateIdentifierValue,
  validatePositiveInteger,
  validateProvider,
  validateSha256Hash,
  validateTopologyMode,
} from './runtimePlanValidationPrimitives';

export {
  type CompositeRuntimePlanErrorCode,
  CompositeRuntimePlanValidationError,
} from './CompositeRuntimePlanValidationError';
export type { ResolvedProcessExecutionUnitFact } from './runtimeExecutionPlanValidation';

type TeamProviderId = CompositeRuntimePlan['leadProviderId'];

export interface PlannedRuntimeMember {
  readonly name: string;
  readonly providerId: TeamProviderId;
  readonly role?: string;
  readonly workflow?: string;
  readonly isolation?: 'worktree';
  readonly cwd?: string;
  readonly providerBackendId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly fastMode?: string;
}

interface RuntimeLaneCapabilitySideLane {
  readonly laneId: string;
  readonly providerId: TeamProviderId;
  readonly member: PlannedRuntimeMember;
}

/**
 * Structural capability fact emitted by team-runtime-lanes. Provider policy and topology
 * selection stay with that feature; runtime-control only binds the resolved lanes to its plan.
 */
export interface TeamRuntimeLanePlan {
  readonly mode: RuntimeTopologyMode;
  readonly primaryMembers: readonly PlannedRuntimeMember[];
  readonly allMembers: readonly PlannedRuntimeMember[];
  readonly sideLanes: readonly RuntimeLaneCapabilitySideLane[];
  readonly soloMember?: PlannedRuntimeMember;
}

export type TeamRuntimeLanePlanResult =
  | { readonly ok: true; readonly plan: TeamRuntimeLanePlan }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly message: string;
    };

export interface ResolvedRuntimeLaneCredentialFact {
  readonly laneId: LaneId;
  readonly requiredCredentialExposureSet: CredentialExposureSet;
}

export interface CreateCompositeRuntimePlanInput {
  readonly teamId: CompositeRuntimePlan['teamId'];
  readonly runId: CompositeRuntimePlan['runId'];
  readonly generation: number;
  readonly leadProviderId: TeamProviderId;
  /** The exact success/error value returned by team-runtime-lanes for this generation. */
  readonly lanePlanResult: TeamRuntimeLanePlanResult;
  readonly rosterGeneration: number;
  readonly memberBindings: readonly RuntimePlanMemberBinding[];
  readonly laneCredentials: readonly ResolvedRuntimeLaneCredentialFact[];
  readonly workspaceBinding: RegisteredWorkspaceRuntimeBinding;
  readonly executionUnits: readonly ResolvedProcessExecutionUnitFact[];
}

const PLANNER_MEMBER_KEYS = Object.freeze([
  'cwd',
  'effort',
  'fastMode',
  'isolation',
  'model',
  'name',
  'providerBackendId',
  'providerId',
  'role',
  'workflow',
] as const);

export function createCompositeRuntimePlan(
  input: CreateCompositeRuntimePlanInput
): CompositeRuntimePlan {
  assertExactRecord(
    input,
    [
      'executionUnits',
      'generation',
      'laneCredentials',
      'lanePlanResult',
      'leadProviderId',
      'memberBindings',
      'rosterGeneration',
      'runId',
      'teamId',
      'workspaceBinding',
    ],
    'createInput'
  );
  validatePositiveInteger(input.generation, 'generation');
  validatePositiveInteger(input.rosterGeneration, 'rosterGeneration');
  validateIdentifier(() => parseTeamId(input.teamId), 'teamId');
  validateIdentifier(() => parseRunId(input.runId), 'runId');
  validateProvider(input.leadProviderId, 'leadProviderId');
  const memberBindings = validateMemberBindings(input.memberBindings);
  const mappedPlan = mapExactLanePlan(input.lanePlanResult, memberBindings, input.laneCredentials);
  const workspaceBinding = validateWorkspaceBinding(input.workspaceBinding);
  const executionUnits = validateResolvedExecutionUnits(
    input.executionUnits,
    mappedPlan.topologyMode,
    memberBindings,
    mappedPlan.lanes
  );

  return buildRuntimePlan({
    teamId: input.teamId,
    runId: input.runId,
    generation: input.generation,
    leadProviderId: input.leadProviderId,
    topologyMode: mappedPlan.topologyMode,
    lanes: mappedPlan.lanes,
    rosterGeneration: input.rosterGeneration,
    memberBindings,
    workspaceBinding,
    executionUnits,
  });
}

/** Strictly decodes persisted JSON and reruns every semantic invariant before rehydration. */
export function decodeCompositeRuntimePlan(value: unknown): CompositeRuntimePlan {
  assertExactRecord(
    value,
    [
      'executionUnits',
      'generation',
      'lanes',
      'leadProviderId',
      'memberBindings',
      'orderedLaneIds',
      'planHash',
      'planVersion',
      'rosterGeneration',
      'runId',
      'teamId',
      'topologyMode',
      'workspaceBinding',
    ],
    'persistedPlan',
    'persisted_plan_invalid'
  );
  const record = value;
  if (record.planVersion !== COMPOSITE_RUNTIME_PLAN_VERSION) {
    fail('persisted_plan_invalid', 'runtime-plan-version-unsupported');
  }
  const persistedHash = validateSha256Hash(record.planHash, 'planHash');
  validatePositiveInteger(record.generation, 'generation');
  validatePositiveInteger(record.rosterGeneration, 'rosterGeneration');
  validateIdentifier(() => parseTeamId(record.teamId), 'teamId');
  validateIdentifier(() => parseRunId(record.runId), 'runId');
  validateProvider(record.leadProviderId, 'leadProviderId');
  const topologyMode = validateTopologyMode(record.topologyMode);
  const memberBindings = validateMemberBindings(record.memberBindings);
  const lanes = validatePersistedLanes(record.lanes, memberBindings);
  validatePersistedLaneOrder(record.orderedLaneIds, lanes);
  const workspaceBinding = validateWorkspaceBinding(record.workspaceBinding);
  const executionUnits = validatePersistedExecutionUnits(
    record.executionUnits,
    topologyMode,
    memberBindings,
    lanes
  );

  const plan = buildRuntimePlan({
    teamId: record.teamId as CompositeRuntimePlan['teamId'],
    runId: record.runId as CompositeRuntimePlan['runId'],
    generation: record.generation,
    leadProviderId: record.leadProviderId,
    topologyMode,
    lanes,
    rosterGeneration: record.rosterGeneration,
    memberBindings,
    workspaceBinding,
    executionUnits,
  });
  if (plan.planHash !== persistedHash) {
    fail('plan_hash_mismatch', 'runtime-plan-persisted-hash-mismatch');
  }
  return plan;
}

export function isCurrentCompositeRuntimePlan(value: unknown): value is CompositeRuntimePlan {
  try {
    decodeCompositeRuntimePlan(value);
    return true;
  } catch {
    return false;
  }
}

interface ValidatedPlanBody {
  readonly teamId: CompositeRuntimePlan['teamId'];
  readonly runId: CompositeRuntimePlan['runId'];
  readonly generation: number;
  readonly leadProviderId: TeamProviderId;
  readonly topologyMode: RuntimeTopologyMode;
  readonly lanes: readonly RuntimePlanLaneBinding[];
  readonly rosterGeneration: number;
  readonly memberBindings: readonly RuntimePlanMemberBinding[];
  readonly workspaceBinding: RegisteredWorkspaceRuntimeBinding;
  readonly executionUnits: readonly ProcessExecutionUnit[];
}

function buildRuntimePlan(body: ValidatedPlanBody): CompositeRuntimePlan {
  const hashBody: CompositeRuntimePlanHashBody = {
    planVersion: COMPOSITE_RUNTIME_PLAN_VERSION,
    teamId: body.teamId,
    runId: body.runId,
    generation: body.generation,
    leadProviderId: body.leadProviderId,
    topologyMode: body.topologyMode,
    orderedLaneIds: Object.freeze(body.lanes.map((lane) => lane.laneId)),
    lanes: body.lanes,
    rosterGeneration: body.rosterGeneration,
    memberBindings: body.memberBindings,
    workspaceBinding: body.workspaceBinding,
    executionUnits: body.executionUnits,
  };
  return deepFreezeRuntimePlan({
    ...hashBody,
    planHash: createCompositeRuntimePlanHash(hashBody),
  });
}

function validateMemberBindings(value: unknown): readonly RuntimePlanMemberBinding[] {
  validateDenseArray(value, 'memberBindings');
  const bindings = value;
  const memberIds = new Set<string>();
  const legacyKeys = new Set<string>();
  const foldedLegacyKeys = new Set<string>();

  return bindings.map((candidate) => {
    assertExactRecord(
      candidate,
      ['laneId', 'legacyMemberKey', 'memberId', 'memberRevision', 'policy', 'providerId'],
      'memberBinding'
    );
    const binding = candidate as unknown as RuntimePlanMemberBinding;
    validateIdentifier(() => parseMemberId(binding.memberId), 'memberId');
    validateIdentifier(() => parseLegacyMemberKey(binding.legacyMemberKey), 'legacyMemberKey');
    validateIdentifier(() => parseLaneId(binding.laneId), 'laneId');
    validatePositiveInteger(binding.memberRevision, 'memberRevision');
    validateProvider(binding.providerId, 'memberProviderId');
    if (binding.policy !== 'required' && binding.policy !== 'optional') {
      fail('invalid_field', 'runtime-plan-member-policy-invalid');
    }
    if (memberIds.has(binding.memberId)) {
      fail('duplicate_member_id', 'runtime-plan-member-id-duplicate');
    }
    if (legacyKeys.has(binding.legacyMemberKey)) {
      fail('duplicate_legacy_member_key', 'runtime-plan-legacy-member-key-duplicate');
    }
    const foldedLegacyKey = foldLegacyMemberKey(binding.legacyMemberKey);
    if (foldedLegacyKeys.has(foldedLegacyKey)) {
      fail('case_fold_ambiguity', 'runtime-plan-legacy-member-key-case-ambiguous');
    }
    memberIds.add(binding.memberId);
    legacyKeys.add(binding.legacyMemberKey);
    foldedLegacyKeys.add(foldedLegacyKey);
    return Object.freeze({
      memberId: binding.memberId,
      memberRevision: binding.memberRevision,
      legacyMemberKey: binding.legacyMemberKey,
      providerId: binding.providerId,
      laneId: binding.laneId,
      policy: binding.policy,
    });
  });
}

function mapExactLanePlan(
  result: TeamRuntimeLanePlanResult,
  members: readonly RuntimePlanMemberBinding[],
  laneCredentialValue: unknown
): {
  readonly topologyMode: RuntimeTopologyMode;
  readonly lanes: readonly RuntimePlanLaneBinding[];
} {
  assertPlainRecord(result, 'lanePlanResult');
  if (result.ok !== true) {
    if (result.ok === false) {
      assertExactRecord(result, ['message', 'ok', 'reason'], 'lanePlanResult');
      fail('lane_plan_rejected', 'runtime-plan-lane-planner-rejected');
    }
    fail('lane_plan_mismatch', 'runtime-plan-lane-planner-result-invalid');
  }
  assertExactRecord(result, ['ok', 'plan'], 'lanePlanResult');
  const plan = result.plan;
  assertPlainRecord(plan, 'lanePlan');
  const topologyMode = validateTopologyMode(plan.mode);
  const expectedPlanKeys = Object.prototype.hasOwnProperty.call(plan, 'soloMember')
    ? ['allMembers', 'mode', 'primaryMembers', 'sideLanes', 'soloMember']
    : ['allMembers', 'mode', 'primaryMembers', 'sideLanes'];
  assertExactRecord(plan, expectedPlanKeys, 'lanePlan');
  validateDenseArray(plan.allMembers, 'lanePlan.allMembers');
  validateDenseArray(plan.primaryMembers, 'lanePlan.primaryMembers');
  validateDenseArray(plan.sideLanes, 'lanePlan.sideLanes');

  const bindingByLegacyKey = new Map(members.map((member) => [member.legacyMemberKey, member]));
  const plannedMembers = validatePlannerMembers(plan.allMembers, bindingByLegacyKey);
  if (plannedMembers.length !== members.length) {
    fail('lane_plan_mismatch', 'runtime-plan-lane-planner-roster-incomplete');
  }
  if (plannedMembers.some((member, index) => members[index]?.legacyMemberKey !== member.name)) {
    fail('lane_plan_mismatch', 'runtime-plan-lane-planner-roster-order-mismatch');
  }
  const allMemberSet = new Set(plannedMembers);
  const assignedMembers = new Set<PlannedRuntimeMember>();
  const primaryMembers = validatePlannerMemberReferences(
    plan.primaryMembers,
    allMemberSet,
    assignedMembers,
    'primaryMembers'
  );
  const secondaryMembers: PlannedRuntimeMember[] = [];
  const lanesWithoutCredentials: Omit<RuntimePlanLaneBinding, 'requiredCredentialExposureSet'>[] = [
    {
      laneId: parseLaneId('primary'),
      laneKind: 'primary',
      ordinal: 0,
      memberIds: Object.freeze(
        primaryMembers.map(
          (member) => requirePlannerMemberBinding(member, bindingByLegacyKey).memberId
        )
      ),
    },
  ];

  for (const [index, sideCandidate] of plan.sideLanes.entries()) {
    assertExactRecord(sideCandidate, ['laneId', 'member', 'providerId'], 'lanePlan.sideLane');
    const sideLane = sideCandidate as (typeof plan.sideLanes)[number];
    const [member] = validatePlannerMemberReferences(
      [sideLane.member],
      allMemberSet,
      assignedMembers,
      'sideLane.member'
    );
    if (member?.providerId !== sideLane.providerId) {
      fail('lane_plan_mismatch', 'runtime-plan-side-lane-provider-mismatch');
    }
    secondaryMembers.push(member);
    lanesWithoutCredentials.push({
      laneId: validateIdentifierValue(() => parseLaneId(sideLane.laneId), 'laneId'),
      laneKind: 'secondary',
      ordinal: index + 1,
      memberIds: Object.freeze([requirePlannerMemberBinding(member, bindingByLegacyKey).memberId]),
    });
  }

  if (assignedMembers.size !== plannedMembers.length) {
    fail('lane_plan_mismatch', 'runtime-plan-lane-planner-member-dropped');
  }
  validatePlannerSubsequenceOrder(primaryMembers, plannedMembers, 'primaryMembers');
  validatePlannerSubsequenceOrder(secondaryMembers, plannedMembers, 'sideLanes');
  validateExactLaneCapabilityShape(plan, plannedMembers, primaryMembers);
  const lanes = attachLaneCredentials(lanesWithoutCredentials, laneCredentialValue);
  validateMemberLaneMappings(members, lanes);
  return { topologyMode, lanes };
}

function validatePlannerMembers(
  value: readonly PlannedRuntimeMember[],
  bindingByLegacyKey: ReadonlyMap<LegacyMemberKey, RuntimePlanMemberBinding>
): readonly PlannedRuntimeMember[] {
  const exactNames = new Set<string>();
  const foldedNames = new Set<string>();
  return value.map((member) => {
    assertAllowedRecordKeys(member, PLANNER_MEMBER_KEYS, 'lanePlan.member');
    if (typeof member.name !== 'string' || member.name !== member.name.trim()) {
      fail('lane_plan_mismatch', 'runtime-plan-lane-planner-member-name-invalid');
    }
    validateIdentifier(() => parseLegacyMemberKey(member.name), 'lanePlan.member.name');
    validateProvider(member.providerId, 'lanePlan.member.providerId');
    if (exactNames.has(member.name)) {
      fail('duplicate_legacy_member_key', 'runtime-plan-lane-planner-member-duplicate');
    }
    const foldedName = foldLegacyMemberKey(member.name);
    if (foldedNames.has(foldedName)) {
      fail('case_fold_ambiguity', 'runtime-plan-lane-planner-member-case-ambiguous');
    }
    const binding = bindingByLegacyKey.get(member.name as LegacyMemberKey);
    if (binding?.providerId !== member.providerId) {
      fail('lane_plan_mismatch', 'runtime-plan-lane-planner-roster-mismatch');
    }
    exactNames.add(member.name);
    foldedNames.add(foldedName);
    return member;
  });
}

function validatePlannerMemberReferences(
  value: readonly PlannedRuntimeMember[],
  allMemberSet: ReadonlySet<PlannedRuntimeMember>,
  assignedMembers: Set<PlannedRuntimeMember>,
  field: string
): readonly PlannedRuntimeMember[] {
  return value.map((member) => {
    if (!allMemberSet.has(member)) {
      fail('lane_plan_mismatch', `runtime-plan-lane-planner-${field}-not-exact-member`);
    }
    if (assignedMembers.has(member)) {
      fail('lane_plan_mismatch', `runtime-plan-lane-planner-${field}-member-merged`);
    }
    assignedMembers.add(member);
    return member;
  });
}

function validatePlannerSubsequenceOrder(
  members: readonly PlannedRuntimeMember[],
  allMembers: readonly PlannedRuntimeMember[],
  field: string
): void {
  const plannerOrder = new Map(allMembers.map((member, index) => [member, index]));
  let previousOrder = -1;
  for (const member of members) {
    const order = plannerOrder.get(member);
    if (order === undefined || order <= previousOrder) {
      fail('unstable_ordering', `runtime-plan-lane-planner-${field}-order-unstable`);
    }
    previousOrder = order;
  }
}

function validateExactLaneCapabilityShape(
  plan: TeamRuntimeLanePlan,
  allMembers: readonly PlannedRuntimeMember[],
  primaryMembers: readonly PlannedRuntimeMember[]
): void {
  if (
    Object.prototype.hasOwnProperty.call(plan, 'soloMember') &&
    (allMembers.length !== 1 ||
      primaryMembers.length !== 1 ||
      plan.sideLanes.length !== 0 ||
      plan.soloMember !== allMembers[0])
  ) {
    fail('lane_plan_mismatch', 'runtime-plan-lane-planner-single-member-shape-invalid');
  }
}

function requirePlannerMemberBinding(
  member: PlannedRuntimeMember,
  bindingByLegacyKey: ReadonlyMap<LegacyMemberKey, RuntimePlanMemberBinding>
): RuntimePlanMemberBinding {
  const binding = bindingByLegacyKey.get(member.name as LegacyMemberKey);
  if (!binding) {
    fail('missing_member_binding', 'runtime-plan-lane-planner-member-binding-missing');
  }
  return binding;
}

function attachLaneCredentials(
  lanes: readonly Omit<RuntimePlanLaneBinding, 'requiredCredentialExposureSet'>[],
  value: unknown
): readonly RuntimePlanLaneBinding[] {
  validateDenseNonEmptyArray(value, 'laneCredentials');
  const credentials = value;
  if (credentials.length !== lanes.length) {
    fail('lane_plan_mismatch', 'runtime-plan-lane-credential-count-mismatch');
  }
  const attached = lanes.map((lane, index) => {
    const candidate = credentials[index];
    assertExactRecord(candidate, ['laneId', 'requiredCredentialExposureSet'], 'laneCredential');
    const credential = candidate as unknown as ResolvedRuntimeLaneCredentialFact;
    validateIdentifier(() => parseLaneId(credential.laneId), 'laneCredential.laneId');
    if (credential.laneId !== lane.laneId) {
      fail('lane_plan_mismatch', 'runtime-plan-lane-credential-order-mismatch');
    }
    return Object.freeze({
      ...lane,
      memberIds: Object.freeze([...lane.memberIds]),
      requiredCredentialExposureSet: validateCredentialExposureSet(
        credential.requiredCredentialExposureSet,
        'lane.requiredCredentialExposureSet'
      ),
    });
  });
  validateSecretRefClassConsistency(attached.map((lane) => lane.requiredCredentialExposureSet));
  return Object.freeze(attached);
}

function validatePersistedLanes(
  value: unknown,
  members: readonly RuntimePlanMemberBinding[]
): readonly RuntimePlanLaneBinding[] {
  validateDenseNonEmptyArray(value, 'lanes');
  const lanes = value;
  const laneIds = new Set<string>();
  const memberById = new Map(members.map((member) => [member.memberId, member]));
  const boundMemberIds = new Set<MemberId>();
  const memberOrder = new Map(members.map((member, index) => [member.memberId, index]));

  const copied = lanes.map((candidate, index) => {
    assertExactRecord(
      candidate,
      ['laneId', 'laneKind', 'memberIds', 'ordinal', 'requiredCredentialExposureSet'],
      'lane'
    );
    const lane = candidate as unknown as RuntimePlanLaneBinding;
    validateIdentifier(() => parseLaneId(lane.laneId), 'laneId');
    if (laneIds.has(lane.laneId)) {
      fail('duplicate_lane_id', 'runtime-plan-lane-id-duplicate');
    }
    if (lane.ordinal !== index) {
      fail('unstable_ordering', 'runtime-plan-lane-ordinal-unstable');
    }
    if (
      (index === 0 && lane.laneKind !== 'primary') ||
      (index > 0 && lane.laneKind !== 'secondary')
    ) {
      fail('unstable_ordering', 'runtime-plan-primary-lane-order-invalid');
    }
    if (index === 0 && lane.laneId !== 'primary') {
      fail('unstable_ordering', 'runtime-plan-primary-lane-id-invalid');
    }
    validateDenseArray(lane.memberIds, 'lane.memberIds');
    if (index > 0 && lane.memberIds.length !== 1) {
      fail('lane_plan_mismatch', 'runtime-plan-secondary-lane-cardinality-invalid');
    }
    let previousMemberOrder = -1;
    const laneMemberIds = lane.memberIds.map((memberId) => {
      validateIdentifier(() => parseMemberId(memberId), 'lane.memberId');
      const member = memberById.get(memberId);
      if (!member) {
        fail('missing_member_binding', 'runtime-plan-lane-member-binding-missing');
      }
      if (member.laneId !== lane.laneId || boundMemberIds.has(memberId)) {
        fail('missing_lane_binding', 'runtime-plan-member-lane-binding-inconsistent');
      }
      const order = memberOrder.get(memberId) ?? -1;
      if (order <= previousMemberOrder) {
        fail('unstable_ordering', 'runtime-plan-lane-member-order-unstable');
      }
      previousMemberOrder = order;
      boundMemberIds.add(memberId);
      return memberId;
    });
    laneIds.add(lane.laneId);
    return Object.freeze({
      laneId: lane.laneId,
      laneKind: lane.laneKind,
      ordinal: lane.ordinal,
      memberIds: Object.freeze(laneMemberIds),
      requiredCredentialExposureSet: validateCredentialExposureSet(
        lane.requiredCredentialExposureSet,
        'lane.requiredCredentialExposureSet'
      ),
    });
  });
  validateMemberLaneMappings(members, copied);
  validateSecretRefClassConsistency(copied.map((lane) => lane.requiredCredentialExposureSet));
  return Object.freeze(copied);
}

function validateMemberLaneMappings(
  members: readonly RuntimePlanMemberBinding[],
  lanes: readonly RuntimePlanLaneBinding[]
): void {
  const laneIds = new Set(lanes.map((lane) => lane.laneId));
  const boundMemberIds = new Set(lanes.flatMap((lane) => lane.memberIds));
  for (const member of members) {
    const lane = lanes.find((candidate) => candidate.laneId === member.laneId);
    if (!laneIds.has(member.laneId) || !boundMemberIds.has(member.memberId) || !lane) {
      fail('missing_lane_binding', 'runtime-plan-member-lane-binding-missing');
    }
    if (!lane.memberIds.includes(member.memberId)) {
      fail('missing_lane_binding', 'runtime-plan-member-lane-binding-inconsistent');
    }
  }
  if (boundMemberIds.size !== members.length) {
    fail('missing_member_binding', 'runtime-plan-lane-member-binding-incomplete');
  }
}
