import {
  type LegacyMemberKey,
  type MemberId,
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';

import {
  COMPOSITE_RUNTIME_PLAN_VERSION,
  type CompositeRuntimePlan,
  type CredentialExposureSet,
  type ExecutionUnitId,
  HOSTED_CHILD_ENVIRONMENT_PROVENANCE,
  type HostedChildEnvironmentPolicy,
  type HostedChildEnvironmentVariablePolicy,
  type LaneId,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  parseSecretClass,
  parseSecretRefId,
  type ProcessExecutionUnit,
  type RegisteredWorkspaceRuntimeBinding,
  type ResolvedRuntimeBinaryPolicy,
  RUNTIME_TOPOLOGY_MODES,
  type RuntimeExecutionBackendBinding,
  type RuntimeExecutionBackendKind,
  type RuntimeLaneKind,
  type RuntimePlanLaneBinding,
  type RuntimePlanMemberBinding,
  type RuntimeResourcePolicy,
  type RuntimeTopologyMode,
  type SecretRefMetadata,
  type Sha256Hash,
} from '../../../contracts';
import {
  type CompositeRuntimePlanHashBody,
  createCompositeRuntimePlanHash,
  deepFreezeRuntimePlan,
} from '../../domain/CompositeRuntimePlan';
import { credentialExposureSetsOverlap, credentialRefKey } from '../../domain/ProcessExecutionUnit';
import { isRuntimeExecutionBackend } from '../../domain/RuntimeExecutionBackend';

import {
  type CompositeRuntimePlanErrorCode,
  CompositeRuntimePlanValidationError,
} from './CompositeRuntimePlanValidationError';

import type {
  PlannedRuntimeMember,
  TeamRuntimeLanePlan,
  TeamRuntimeLanePlanResult,
} from '@features/team-runtime-lanes';
import type { TeamProviderId } from '@shared/types';

export {
  type CompositeRuntimePlanErrorCode,
  CompositeRuntimePlanValidationError,
} from './CompositeRuntimePlanValidationError';

export interface ResolvedRuntimeLaneCredentialFact {
  readonly laneId: LaneId;
  readonly requiredCredentialExposureSet: CredentialExposureSet;
}

export interface ResolvedProcessExecutionUnitFact {
  readonly executionUnitId: ExecutionUnitId;
  readonly backendBinding: RuntimeExecutionBackendBinding;
  readonly laneId: LaneId;
  readonly binaryPolicy: ResolvedRuntimeBinaryPolicy;
  readonly environmentPolicy: HostedChildEnvironmentPolicy;
  readonly credentialExposureSet: CredentialExposureSet;
  readonly resourcePolicy: RuntimeResourcePolicy;
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

const TEAM_PROVIDER_IDS = Object.freeze([
  'anthropic',
  'codex',
  'gemini',
  'opencode',
] as const satisfies readonly TeamProviderId[]);
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
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
  const mappedPlan = mapExactLanePlan(
    input.lanePlanResult,
    input.leadProviderId,
    memberBindings,
    input.laneCredentials
  );
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
  validateTopology(topologyMode, record.leadProviderId, memberBindings, lanes);
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
  leadProviderId: TeamProviderId,
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
  const expectedPlanKeys =
    topologyMode === 'pure_opencode_solo'
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
  const lanesWithoutCredentials: Array<
    Omit<RuntimePlanLaneBinding, 'requiredCredentialExposureSet'>
  > = [
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
    if (sideLane.providerId !== 'opencode') {
      fail('lane_plan_mismatch', 'runtime-plan-side-lane-provider-invalid');
    }
    const [member] = validatePlannerMemberReferences(
      [sideLane.member],
      allMemberSet,
      assignedMembers,
      'sideLane.member'
    );
    if (!member || member.providerId !== 'opencode') {
      fail('lane_plan_mismatch', 'runtime-plan-side-lane-member-invalid');
    }
    secondaryMembers.push(member);
    const expectedLaneId = `secondary:opencode:${member.name}`;
    if (sideLane.laneId !== expectedLaneId) {
      fail('lane_plan_mismatch', 'runtime-plan-side-lane-id-mismatch');
    }
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
  validateExactPlannerTopology(plan, topologyMode, leadProviderId, plannedMembers, primaryMembers);
  const lanes = attachLaneCredentials(lanesWithoutCredentials, laneCredentialValue);
  validateMemberLaneMappings(members, lanes);
  validateTopology(topologyMode, leadProviderId, members, lanes);
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
    if (!binding || binding.providerId !== member.providerId) {
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

function validateExactPlannerTopology(
  plan: TeamRuntimeLanePlan,
  topologyMode: RuntimeTopologyMode,
  leadProviderId: TeamProviderId,
  allMembers: readonly PlannedRuntimeMember[],
  primaryMembers: readonly PlannedRuntimeMember[]
): void {
  const pureOpenCode =
    topologyMode === 'pure_opencode' ||
    topologyMode === 'pure_opencode_solo' ||
    topologyMode === 'pure_opencode_member_lanes';
  if (pureOpenCode !== (leadProviderId === 'opencode')) {
    fail('lane_plan_mismatch', 'runtime-plan-lane-planner-lead-mismatch');
  }
  if (pureOpenCode && allMembers.some((member) => member.providerId !== 'opencode')) {
    fail('lane_plan_mismatch', 'runtime-plan-lane-planner-pure-provider-mismatch');
  }
  if (topologyMode === 'primary_only') {
    if (plan.sideLanes.length !== 0 || primaryMembers.length !== allMembers.length) {
      fail('lane_plan_mismatch', 'runtime-plan-lane-planner-primary-shape-invalid');
    }
    if (allMembers.some((member) => member.providerId === 'opencode')) {
      fail('lane_plan_mismatch', 'runtime-plan-lane-planner-primary-provider-invalid');
    }
  }
  if (topologyMode === 'pure_opencode') {
    if (plan.sideLanes.length !== 0 || primaryMembers.length !== allMembers.length) {
      fail('lane_plan_mismatch', 'runtime-plan-lane-planner-pure-shape-invalid');
    }
  }
  if (topologyMode === 'pure_opencode_solo') {
    const soloPlan = plan as Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_solo' }>;
    if (
      allMembers.length !== 1 ||
      primaryMembers.length !== 1 ||
      plan.sideLanes.length !== 0 ||
      soloPlan.soloMember !== allMembers[0] ||
      allMembers[0]?.name !== 'solo'
    ) {
      fail('lane_plan_mismatch', 'runtime-plan-lane-planner-solo-shape-invalid');
    }
  }
  if (
    (topologyMode === 'pure_opencode_member_lanes' ||
      topologyMode === 'mixed_opencode_side_lanes') &&
    plan.sideLanes.length === 0
  ) {
    fail('lane_plan_mismatch', 'runtime-plan-lane-planner-side-lane-missing');
  }
  if (topologyMode === 'mixed_opencode_side_lanes') {
    if (
      primaryMembers.some((member) => member.providerId === 'opencode') ||
      plan.sideLanes.some((lane) => lane.member.providerId !== 'opencode')
    ) {
      fail('lane_plan_mismatch', 'runtime-plan-lane-planner-mixed-partition-invalid');
    }
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

function validateTopology(
  topology: RuntimeTopologyMode,
  leadProviderId: TeamProviderId,
  members: readonly RuntimePlanMemberBinding[],
  lanes: readonly RuntimePlanLaneBinding[]
): void {
  const hasSecondaryLanes = lanes.length > 1;
  const pureOpenCode =
    topology === 'pure_opencode' ||
    topology === 'pure_opencode_solo' ||
    topology === 'pure_opencode_member_lanes';
  if (pureOpenCode !== (leadProviderId === 'opencode')) {
    fail('unsupported_topology', 'runtime-plan-lead-provider-topology-unsupported');
  }
  if (
    ((topology === 'primary_only' ||
      topology === 'pure_opencode' ||
      topology === 'pure_opencode_solo') &&
      hasSecondaryLanes) ||
    ((topology === 'pure_opencode_member_lanes' || topology === 'mixed_opencode_side_lanes') &&
      !hasSecondaryLanes)
  ) {
    fail('unsupported_topology', 'runtime-plan-lane-topology-unsupported');
  }
  if (
    topology === 'pure_opencode_solo' &&
    (members.length !== 1 || members[0]?.legacyMemberKey !== 'solo')
  ) {
    fail('unsupported_topology', 'runtime-plan-solo-topology-member-invalid');
  }

  for (const member of members) {
    const lane = lanes.find((candidate) => candidate.laneId === member.laneId);
    if (!lane) {
      fail('missing_lane_binding', 'runtime-plan-member-lane-binding-missing');
    }
    if (lane.laneKind === 'secondary') {
      if (
        lane.memberIds.length !== 1 ||
        lane.laneId !== `secondary:opencode:${member.legacyMemberKey}`
      ) {
        fail('lane_plan_mismatch', 'runtime-plan-secondary-lane-identity-invalid');
      }
    }
    const providerMatches = pureOpenCode
      ? member.providerId === 'opencode'
      : topology === 'mixed_opencode_side_lanes'
        ? (lane.laneKind === 'secondary') === (member.providerId === 'opencode')
        : member.providerId !== 'opencode';
    if (!providerMatches) {
      fail('unsupported_topology', 'runtime-plan-member-provider-topology-unsupported');
    }
  }
}

function validateResolvedExecutionUnits(
  value: unknown,
  topology: RuntimeTopologyMode,
  members: readonly RuntimePlanMemberBinding[],
  lanes: readonly RuntimePlanLaneBinding[]
): readonly ProcessExecutionUnit[] {
  validateDenseNonEmptyArray(value, 'executionUnits');
  const facts = value;
  if (facts.length !== lanes.length) {
    fail('lane_plan_mismatch', 'runtime-plan-execution-unit-lane-count-mismatch');
  }
  const executionUnitIds = new Set<string>();
  const units = facts.map((candidate, index) => {
    assertExactRecord(
      candidate,
      [
        'backendBinding',
        'binaryPolicy',
        'credentialExposureSet',
        'environmentPolicy',
        'executionUnitId',
        'laneId',
        'resourcePolicy',
      ],
      'executionUnitFact'
    );
    const fact = candidate as unknown as ResolvedProcessExecutionUnitFact;
    validateIdentifier(() => parseExecutionUnitId(fact.executionUnitId), 'executionUnitId');
    if (executionUnitIds.has(fact.executionUnitId)) {
      fail('duplicate_execution_unit_id', 'runtime-plan-execution-unit-id-duplicate');
    }
    executionUnitIds.add(fact.executionUnitId);
    const lane = lanes[index];
    if (!lane || fact.laneId !== lane.laneId) {
      fail('lane_plan_mismatch', 'runtime-plan-execution-unit-lane-order-mismatch');
    }
    const backendBinding = validateBackendBinding(fact.backendBinding);
    if (backendBinding.backend !== expectedBackend(topology, lane.laneKind)) {
      fail('unsupported_topology', 'runtime-plan-execution-backend-topology-unsupported');
    }
    const credentialExposureSet = validateCredentialExposureSet(
      fact.credentialExposureSet,
      'executionUnit.credentialExposureSet'
    );
    validateMinimumCredentialExposure(lane.requiredCredentialExposureSet, credentialExposureSet);
    return {
      executionUnitId: fact.executionUnitId,
      backendBinding,
      laneId: fact.laneId,
      memberIds: Object.freeze([...lane.memberIds]),
      binaryPolicy: validateBinaryPolicy(fact.binaryPolicy),
      environmentPolicy: validateEnvironmentPolicy(fact.environmentPolicy, credentialExposureSet),
      credentialExposureSet,
      resourcePolicy: validateResourcePolicy(fact.resourcePolicy),
    };
  });

  return Object.freeze(
    units.map((unit, unitIndex) => {
      const overlaps = units.some(
        (candidate, candidateIndex) =>
          unitIndex !== candidateIndex &&
          credentialExposureSetsOverlap(unit.credentialExposureSet, candidate.credentialExposureSet)
      );
      const credentialIsolation =
        unit.backendBinding.backend === 'opencode' && unit.memberIds.length === 1 && !overlaps
          ? 'dedicated_execution_unit'
          : 'shared_execution_unit';
      return Object.freeze({ ...unit, credentialIsolation });
    })
  );
}

function validatePersistedExecutionUnits(
  value: unknown,
  topology: RuntimeTopologyMode,
  members: readonly RuntimePlanMemberBinding[],
  lanes: readonly RuntimePlanLaneBinding[]
): readonly ProcessExecutionUnit[] {
  validateDenseNonEmptyArray(value, 'executionUnits');
  const persistedUnits = value;
  const facts = persistedUnits.map((candidate) => {
    assertExactRecord(
      candidate,
      [
        'backendBinding',
        'binaryPolicy',
        'credentialExposureSet',
        'credentialIsolation',
        'environmentPolicy',
        'executionUnitId',
        'laneId',
        'memberIds',
        'resourcePolicy',
      ],
      'persistedExecutionUnit'
    );
    const unit = candidate as unknown as ProcessExecutionUnit;
    return {
      executionUnitId: unit.executionUnitId,
      backendBinding: unit.backendBinding,
      laneId: unit.laneId,
      binaryPolicy: unit.binaryPolicy,
      environmentPolicy: unit.environmentPolicy,
      credentialExposureSet: unit.credentialExposureSet,
      resourcePolicy: unit.resourcePolicy,
    };
  });
  const units = validateResolvedExecutionUnits(facts, topology, members, lanes);
  units.forEach((unit, index) => {
    const persisted = persistedUnits[index] as ProcessExecutionUnit;
    validateDenseArray(persisted.memberIds, 'executionUnit.memberIds');
    persisted.memberIds.forEach((memberId) =>
      validateIdentifier(() => parseMemberId(memberId), 'executionUnit.memberId')
    );
    if (!sameStringArray(persisted.memberIds, unit.memberIds)) {
      fail('persisted_plan_invalid', 'runtime-plan-execution-unit-members-not-derived');
    }
    if (persisted.credentialIsolation !== unit.credentialIsolation) {
      fail('persisted_plan_invalid', 'runtime-plan-credential-isolation-not-derived');
    }
  });
  return units;
}

function validateBackendBinding(value: unknown): RuntimeExecutionBackendBinding {
  assertExactRecord(value, ['backend', 'bindingId', 'bindingRevision'], 'backendBinding');
  const binding = value as unknown as RuntimeExecutionBackendBinding;
  if (!isRuntimeExecutionBackend(binding.backend)) {
    fail('unsupported_topology', 'runtime-plan-execution-backend-unsupported');
  }
  validateIdentifier(() => parseRuntimeBackendBindingId(binding.bindingId), 'bindingId');
  validatePositiveInteger(binding.bindingRevision, 'bindingRevision');
  return Object.freeze({
    backend: binding.backend,
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
  });
}

function validateBinaryPolicy(value: unknown): ResolvedRuntimeBinaryPolicy {
  assertExactRecord(value, ['binaryHash', 'binaryId', 'binaryRevision', 'policy'], 'binaryPolicy');
  const policy = value as unknown as ResolvedRuntimeBinaryPolicy;
  if (policy.policy !== 'registered_exact_binary') {
    fail('invalid_field', 'runtime-plan-binary-policy-unsupported');
  }
  validateIdentifier(() => parseRuntimeBinaryId(policy.binaryId), 'binaryId');
  validatePositiveInteger(policy.binaryRevision, 'binaryRevision');
  return Object.freeze({
    policy: policy.policy,
    binaryId: policy.binaryId,
    binaryRevision: policy.binaryRevision,
    binaryHash: validateSha256Hash(policy.binaryHash, 'binaryHash'),
  });
}

function validateWorkspaceBinding(value: unknown): RegisteredWorkspaceRuntimeBinding {
  assertExactRecord(
    value,
    ['bindingGeneration', 'mountGeneration', 'registrationRevision', 'workspaceId'],
    'workspaceBinding'
  );
  const binding = value as unknown as RegisteredWorkspaceRuntimeBinding;
  validateIdentifier(() => parseWorkspaceId(binding.workspaceId), 'workspaceId');
  validatePositiveInteger(binding.registrationRevision, 'registrationRevision');
  validatePositiveInteger(binding.bindingGeneration, 'bindingGeneration');
  validatePositiveInteger(binding.mountGeneration, 'mountGeneration');
  return Object.freeze({
    workspaceId: binding.workspaceId,
    registrationRevision: binding.registrationRevision,
    bindingGeneration: binding.bindingGeneration,
    mountGeneration: binding.mountGeneration,
  });
}

function validateCredentialExposureSet(value: unknown, field: string): CredentialExposureSet {
  assertExactRecord(value, ['secretRefs'], field);
  const exposureSet = value as unknown as CredentialExposureSet;
  validateDenseArray(exposureSet.secretRefs, `${field}.secretRefs`);
  const seenSecretRefIds = new Set<string>();
  let previousKey: string | null = null;
  const secretRefs = exposureSet.secretRefs.map((secretRef) => {
    const validated = validateSecretRef(secretRef, `${field}.secretRef`);
    const key = credentialRefKey(validated);
    if (seenSecretRefIds.has(validated.secretRefId)) {
      fail('invalid_field', 'runtime-plan-credential-ref-duplicate');
    }
    if (previousKey !== null && previousKey >= key) {
      fail('unstable_ordering', 'runtime-plan-credential-order-unstable');
    }
    seenSecretRefIds.add(validated.secretRefId);
    previousKey = key;
    return validated;
  });
  return Object.freeze({ secretRefs: Object.freeze(secretRefs) });
}

function validateSecretRef(value: unknown, field: string): SecretRefMetadata {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== 'secretClass,secretRefId') {
    fail('credential_metadata_only', 'runtime-plan-credential-metadata-only');
  }
  const secretRef = value as unknown as SecretRefMetadata;
  validateIdentifier(() => parseSecretRefId(secretRef.secretRefId), `${field}.secretRefId`);
  validateIdentifier(() => parseSecretClass(secretRef.secretClass), `${field}.secretClass`);
  return Object.freeze({
    secretRefId: secretRef.secretRefId,
    secretClass: secretRef.secretClass,
  });
}

function validateEnvironmentPolicy(
  value: unknown,
  credentialExposureSet: CredentialExposureSet
): HostedChildEnvironmentPolicy {
  assertExactRecord(value, ['policy', 'variables'], 'environmentPolicy');
  const policy = value as unknown as HostedChildEnvironmentPolicy;
  if (policy.policy !== 'explicit_allowlist') {
    fail('invalid_field', 'runtime-plan-environment-policy-unsupported');
  }
  validateDenseArray(policy.variables, 'environmentPolicy.variables');
  const allowedSecretRefs = new Set(credentialExposureSet.secretRefs.map(credentialRefKey));
  const names = new Set<string>();
  let previousName: string | null = null;
  const variables = policy.variables.map((candidate) => {
    assertPlainRecord(candidate, 'environmentVariable');
    const variable = candidate as HostedChildEnvironmentVariablePolicy;
    const secretProvenance = variable.provenance === 'secret_ref';
    assertExactRecord(
      candidate,
      secretProvenance ? ['name', 'provenance', 'secretRef'] : ['name', 'provenance'],
      'environmentVariable'
    );
    if (typeof variable.name !== 'string' || !ENVIRONMENT_NAME_PATTERN.test(variable.name)) {
      fail('invalid_field', 'runtime-plan-environment-name-invalid');
    }
    if (
      !(HOSTED_CHILD_ENVIRONMENT_PROVENANCE as readonly unknown[]).includes(variable.provenance)
    ) {
      fail('invalid_field', 'runtime-plan-environment-provenance-invalid');
    }
    if (names.has(variable.name)) {
      fail('invalid_field', 'runtime-plan-environment-name-duplicate');
    }
    if (previousName !== null && previousName >= variable.name) {
      fail('unstable_ordering', 'runtime-plan-environment-order-unstable');
    }
    names.add(variable.name);
    previousName = variable.name;
    if (secretProvenance) {
      const secretRef = validateSecretRef(variable.secretRef, 'environmentVariable.secretRef');
      if (!allowedSecretRefs.has(credentialRefKey(secretRef))) {
        fail('credential_exposure_widened', 'runtime-plan-environment-secret-not-exposed');
      }
      return Object.freeze({
        name: variable.name,
        provenance: variable.provenance,
        secretRef,
      });
    }
    return Object.freeze({ name: variable.name, provenance: variable.provenance });
  });
  return Object.freeze({ policy: 'explicit_allowlist', variables: Object.freeze(variables) });
}

function validateResourcePolicy(value: unknown): RuntimeResourcePolicy {
  assertExactRecord(
    value,
    ['gracefulStopMs', 'maxOutputBytes', 'maxProcessCount', 'maxRuntimeMs'],
    'resourcePolicy'
  );
  const policy = value as unknown as RuntimeResourcePolicy;
  validatePositiveInteger(policy.maxRuntimeMs, 'resourcePolicy.maxRuntimeMs');
  validatePositiveInteger(policy.gracefulStopMs, 'resourcePolicy.gracefulStopMs');
  validatePositiveInteger(policy.maxOutputBytes, 'resourcePolicy.maxOutputBytes');
  validatePositiveInteger(policy.maxProcessCount, 'resourcePolicy.maxProcessCount');
  if (policy.gracefulStopMs > policy.maxRuntimeMs) {
    fail('invalid_field', 'runtime-plan-resource-grace-exceeds-runtime');
  }
  return Object.freeze({
    maxRuntimeMs: policy.maxRuntimeMs,
    gracefulStopMs: policy.gracefulStopMs,
    maxOutputBytes: policy.maxOutputBytes,
    maxProcessCount: policy.maxProcessCount,
  });
}

function validateSecretRefClassConsistency(exposureSets: readonly CredentialExposureSet[]): void {
  const classBySecretRefId = new Map<string, string>();
  for (const exposureSet of exposureSets) {
    for (const secretRef of exposureSet.secretRefs) {
      const knownClass = classBySecretRefId.get(secretRef.secretRefId);
      if (knownClass !== undefined && knownClass !== secretRef.secretClass) {
        fail('invalid_field', 'runtime-plan-secret-ref-class-conflict');
      }
      classBySecretRefId.set(secretRef.secretRefId, secretRef.secretClass);
    }
  }
}

function validateMinimumCredentialExposure(
  required: CredentialExposureSet,
  actual: CredentialExposureSet
): void {
  const requiredKeys = new Set(required.secretRefs.map(credentialRefKey));
  const actualKeys = new Set(actual.secretRefs.map(credentialRefKey));
  if (actual.secretRefs.some((secretRef) => !requiredKeys.has(credentialRefKey(secretRef)))) {
    fail('credential_exposure_widened', 'runtime-plan-credential-exposure-widened');
  }
  if (required.secretRefs.some((secretRef) => !actualKeys.has(credentialRefKey(secretRef)))) {
    fail('credential_exposure_missing', 'runtime-plan-required-credential-exposure-missing');
  }
}

function expectedBackend(
  topology: RuntimeTopologyMode,
  laneKind: RuntimeLaneKind
): RuntimeExecutionBackendKind {
  if (
    topology === 'pure_opencode' ||
    topology === 'pure_opencode_solo' ||
    topology === 'pure_opencode_member_lanes' ||
    laneKind === 'secondary'
  ) {
    return 'opencode';
  }
  return 'provisioning_cli';
}

function validatePersistedLaneOrder(
  value: unknown,
  lanes: readonly RuntimePlanLaneBinding[]
): void {
  validateDenseNonEmptyArray(value, 'orderedLaneIds');
  const laneIds = value;
  laneIds.forEach((laneId) => validateIdentifier(() => parseLaneId(laneId), 'orderedLaneId'));
  if (
    !sameStringArray(
      laneIds as readonly string[],
      lanes.map((lane) => lane.laneId)
    )
  ) {
    fail('persisted_plan_invalid', 'runtime-plan-ordered-lanes-not-derived');
  }
}

function validateTopologyMode(value: unknown): RuntimeTopologyMode {
  if (!(RUNTIME_TOPOLOGY_MODES as readonly unknown[]).includes(value)) {
    fail('unsupported_topology', 'runtime-plan-topology-mode-unsupported');
  }
  return value as RuntimeTopologyMode;
}

function validateProvider(value: unknown, field: string): asserts value is TeamProviderId {
  if (!(TEAM_PROVIDER_IDS as readonly unknown[]).includes(value)) {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
}

function validateSha256Hash(value: unknown, field: string): Sha256Hash {
  if (typeof value !== 'string' || !SHA256_HASH_PATTERN.test(value)) {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
  return value as Sha256Hash;
}

function validatePositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
}

function validateDenseArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail('unstable_ordering', `runtime-plan-${field}-sparse`);
    }
  }
}

function validateDenseNonEmptyArray(
  value: unknown,
  field: string
): asserts value is readonly unknown[] {
  validateDenseArray(value, field);
  if (value.length === 0) {
    fail('invalid_field', `runtime-plan-${field}-empty`);
  }
}

function validateIdentifier(run: () => unknown, field: string): void {
  try {
    run();
  } catch {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
}

function validateIdentifierValue<T>(run: () => T, field: string): T {
  try {
    return run();
  } catch {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
}

function foldLegacyMemberKey(value: string): string {
  return value.toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(
  value: unknown,
  field: string
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail('invalid_field', `runtime-plan-${field}-record-invalid`);
  }
}

function assertExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
  code: CompositeRuntimePlanErrorCode = 'invalid_field'
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail(code, `runtime-plan-${field}-record-invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!sameStringArray(actual, expected)) {
    fail(code, `runtime-plan-${field}-shape-invalid`);
  }
}

function assertAllowedRecordKeys(
  value: unknown,
  allowedKeys: readonly string[],
  field: string
): asserts value is Record<string, unknown> {
  assertPlainRecord(value, field);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail('lane_plan_mismatch', `runtime-plan-${field}-shape-invalid`);
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(code: CompositeRuntimePlanErrorCode, message: string): never {
  throw new CompositeRuntimePlanValidationError(code, message);
}
