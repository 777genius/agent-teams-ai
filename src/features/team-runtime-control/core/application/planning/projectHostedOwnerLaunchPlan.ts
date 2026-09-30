import {
  type HostedRosterConfiguration,
  parseHostedRosterConfiguration,
} from '@features/team-configuration/contracts';
import {
  type LegacyMemberKey,
  type MemberId,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
  type RunId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import { decodeCompositeRuntimePlan } from './createCompositeRuntimePlan';

import type {
  CompositeRuntimePlan,
  CompositeRuntimePlanHash,
  ExecutionUnitId,
  LaneId,
  RegisteredWorkspaceRuntimeBinding,
} from '../../../contracts';

type ProviderId = CompositeRuntimePlan['leadProviderId'];
type Effort = NonNullable<HostedRosterConfiguration['lanes'][number]['members'][number]['effort']>;

export type HostedOwnerProjectionErrorCode =
  | 'frozen_promotion_invalid'
  | 'frozen_promotion_hash_mismatch'
  | 'runtime_plan_invalid'
  | 'runtime_identity_mismatch'
  | 'workspace_binding_mismatch'
  | 'resolved_configuration_mismatch'
  | 'member_bijection_mismatch'
  | 'primary_member_invalid'
  | 'unsupported_native_topology'
  | 'projection_stale';

export class HostedOwnerProjectionError extends Error {
  constructor(
    readonly code: HostedOwnerProjectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HostedOwnerProjectionError';
  }
}

export interface TrustedFrozenHostedPromotion {
  readonly planJson: string;
  /** Bare lowercase SHA-256, as retained by HostedPromotionRecord. */
  readonly planSha256: string;
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly originalTeamId: TeamId;
  readonly admittedWorkspaceRoot: string;
  readonly laneIds: readonly string[];
  readonly configuration: HostedRosterConfiguration;
}

export interface HostedOwnerRuntimePlanRef {
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly generation: number;
  readonly planHash: CompositeRuntimePlanHash;
}

export type HostedOwnerResolvedEffort = Readonly<{
  kind: 'resolved';
  source: 'member' | 'lane' | 'provider_default';
  value: Effort;
}>;

/** Exact output retained by the reconstruction caller's real model/profile/default resolver. */
export interface HostedOwnerResolvedMemberFact {
  readonly memberId: MemberId;
  readonly memberRevision: number;
  readonly legacyMemberKey: LegacyMemberKey;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly modelSource: 'member' | 'lane';
  readonly effort: HostedOwnerResolvedEffort;
}

/** Immutable authority-owned snapshot for one reconstruction/default-resolution revision. */
export interface HostedOwnerResolutionSnapshot {
  readonly frozenPromotionSha256: string;
  readonly runtimePlanRef: HostedOwnerRuntimePlanRef;
  readonly productRevision: number;
  readonly resolutionRevision: number;
  readonly resolverRevision: number;
  readonly designatedPrimaryMemberId: MemberId;
  readonly members: readonly HostedOwnerResolvedMemberFact[];
}

export interface HostedOwnerProjectionCurrentnessBinding {
  readonly frozenPromotionSha256: string;
  readonly runtimePlanRef: HostedOwnerRuntimePlanRef;
  readonly workspaceBinding: RegisteredWorkspaceRuntimeBinding;
  readonly workspaceRoot: string;
  readonly productRevision: number;
  readonly resolutionSnapshot: HostedOwnerResolutionSnapshot;
}

/** Trusted synchronous authority captured at reconstruction time; never a wire input. */
export interface HostedOwnerProjectionAuthority {
  readonly runtimePlanRef: HostedOwnerRuntimePlanRef;
  readonly workspaceBinding: RegisteredWorkspaceRuntimeBinding;
  readonly workspaceRoot: string;
  readonly productRevision: number;
  readonly resolutionSnapshot: HostedOwnerResolutionSnapshot;
  isCurrent(binding: HostedOwnerProjectionCurrentnessBinding): boolean;
}

/** Trusted technical capabilities supplied by a future production composition caller. */
export interface HostedOwnerProjectorCapabilities {
  /** SHA-256 of the exact UTF-8 encoding of value, returned as bare lowercase 64-hex. */
  sha256Utf8(value: string): string;
  /** Allowed-value validation only; this capability must not select or normalize an effort. */
  isEffortAllowedForProvider(value: Effort, providerId: ProviderId): boolean;
}

export interface HostedOwnerLaunchMemberV3 {
  readonly name: string;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly ordinal: number;
  readonly agentId: MemberId;
}

export type HostedOwnerLaunchLaneV3 =
  | Readonly<{
      laneId: string;
      kind: 'native';
      provider: Exclude<ProviderId, 'opencode'>;
      members: readonly HostedOwnerLaunchMemberV3[];
    }>
  | Readonly<{
      laneId: string;
      kind: 'opencode';
      provider: 'opencode';
      selectedModel: string;
      effort?: Effort;
      members: readonly HostedOwnerLaunchMemberV3[];
    }>;

export interface HostedOwnerLaunchPlanV3 {
  readonly schemaVersion: 3;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly workspaceRoot: string;
  readonly toolApprovalMode: 'auto';
  readonly runtimePlanRef: HostedOwnerRuntimePlanRef;
  readonly primaryOrdinal: number;
  readonly lanes: readonly HostedOwnerLaunchLaneV3[];
}

export interface HostedOwnerMemberProjectionBinding {
  readonly ordinal: number;
  readonly agentId: MemberId;
  readonly ownerLaneId: string;
  readonly ownerMemberIndex: number;
  readonly productLaneId: LaneId;
  readonly executionUnitId: ExecutionUnitId;
}

export interface HostedOwnerLaunchProjectionBinding {
  readonly ownerPlanGeneration: `plan-generation_${string}`;
  readonly frozenPromotionSha256: string;
  readonly runtimePlanRef: HostedOwnerRuntimePlanRef;
  /** Exact admitted Product object, retained unchanged by identity. */
  readonly originalProductPlan: CompositeRuntimePlan;
  readonly productRevision: number;
  readonly resolutionRevision: number;
  readonly resolverRevision: number;
  readonly primaryOrdinal: number;
  readonly members: readonly HostedOwnerMemberProjectionBinding[];
  readonly isCurrent: () => boolean;
}

export interface ProjectHostedOwnerLaunchPlanInput {
  readonly frozenPromotion: TrustedFrozenHostedPromotion;
  readonly originalProductPlan: CompositeRuntimePlan;
  readonly authority: HostedOwnerProjectionAuthority;
  readonly capabilities: HostedOwnerProjectorCapabilities;
}

export interface ProjectHostedOwnerLaunchPlanResult {
  readonly plan: HostedOwnerLaunchPlanV3;
  readonly planJson: string;
  readonly binding: HostedOwnerLaunchProjectionBinding;
}

export function projectHostedOwnerLaunchPlan(
  input: ProjectHostedOwnerLaunchPlanInput
): ProjectHostedOwnerLaunchPlanResult {
  if (!input || typeof input !== 'object') {
    fail('frozen_promotion_invalid', 'hosted-owner-projection-input-invalid');
  }

  // No caller-owned input is reread after the authority callback.
  const frozenPromotion = input.frozenPromotion;
  const originalProductPlan = input.originalProductPlan;
  const authorityReceiver = input.authority;
  const authorityIsCurrent = authorityReceiver?.isCurrent;
  const authorityResolutionSnapshot = authorityReceiver?.resolutionSnapshot;
  const capabilityReceiver = input.capabilities;
  const capabilitySha256Utf8 = capabilityReceiver?.sha256Utf8;
  const capabilityIsEffortAllowedForProvider = capabilityReceiver?.isEffortAllowedForProvider;

  const promotion = validateFrozenPromotion(
    frozenPromotion,
    capabilityReceiver,
    capabilitySha256Utf8
  );
  const productPlan = validateOriginalProductPlan(originalProductPlan);
  const authorityBinding = validateAuthority(
    authorityReceiver,
    authorityResolutionSnapshot,
    promotion,
    productPlan
  );
  const resolvedByKey = validateResolutionSnapshot(
    authorityBinding.resolutionSnapshot,
    promotion,
    productPlan,
    capabilityReceiver,
    capabilityIsEffortAllowedForProvider
  );
  if (productPlan.toolApprovalMode !== promotion.configuration.toolApprovalMode) {
    fail('runtime_identity_mismatch', 'hosted-owner-tool-approval-mode-mismatch');
  }

  const productByKey = new Map(
    productPlan.memberBindings.map((member, ordinal) => [
      member.legacyMemberKey,
      { member, ordinal },
    ])
  );
  const productMemberIds = new Set(productPlan.memberBindings.map(({ memberId }) => memberId));
  let projectedCount = 0;
  const projectionRows: HostedOwnerMemberProjectionBinding[] = [];
  const lanes = promotion.configuration.lanes.map((lane, ownerLaneIndex) => {
    const ownerLaneId = promotion.laneIds[ownerLaneIndex];
    if (!ownerLaneId) fail('frozen_promotion_invalid', 'hosted-owner-promotion-lane-missing');
    let previousOrdinal = -1;
    const members = lane.members.map((member, ownerMemberIndex) => {
      const product = productByKey.get(member.name as LegacyMemberKey);
      const resolved = resolvedByKey.get(member.name as LegacyMemberKey);
      if (
        !product ||
        !resolved ||
        resolved.memberId !== product.member.memberId ||
        resolved.memberRevision !== product.member.memberRevision ||
        product.member.providerId !== lane.provider
      ) {
        fail('member_bijection_mismatch', 'hosted-owner-member-binding-missing');
      }
      if (product.ordinal <= previousOrdinal) {
        fail('member_bijection_mismatch', 'hosted-owner-member-lane-order-unstable');
      }
      previousOrdinal = product.ordinal;
      const executionUnit = productPlan.executionUnits.find((unit) =>
        unit.memberIds.includes(product.member.memberId)
      );
      if (!executionUnit || executionUnit.laneId !== product.member.laneId) {
        fail('member_bijection_mismatch', 'hosted-owner-member-execution-unit-missing');
      }
      if (lane.kind === 'native') {
        if (
          executionUnit.memberIds.length !== 1 ||
          executionUnit.memberIds[0] !== product.member.memberId ||
          executionUnit.backendBinding.backend !== 'provisioning_cli'
        ) {
          fail(
            'unsupported_native_topology',
            'hosted-owner-native-singleton-execution-evidence-unavailable'
          );
        }
        // CompositeRuntimePlan deliberately carries no Owner executable/argv/workdir recipe join.
        // A singleton unit alone therefore cannot authorize native Owner material in this slice.
        fail(
          'unsupported_native_topology',
          'hosted-owner-native-launch-recipe-evidence-unavailable'
        );
      }
      projectionRows.push(
        Object.freeze({
          ordinal: product.ordinal,
          agentId: product.member.memberId,
          ownerLaneId,
          ownerMemberIndex,
          productLaneId: product.member.laneId,
          executionUnitId: executionUnit.executionUnitId,
        })
      );
      projectedCount += 1;
      return Object.freeze({
        name: member.name,
        prompt: member.prompt,
        ...(member.model === undefined ? {} : { model: member.model }),
        ...(member.effort === undefined ? {} : { effort: member.effort }),
        ordinal: product.ordinal,
        agentId: product.member.memberId,
      });
    });
    return Object.freeze({
      laneId: ownerLaneId,
      kind: lane.kind,
      provider: lane.provider,
      ...(lane.kind === 'opencode'
        ? {
            selectedModel: lane.selectedModel,
            ...(lane.effort === undefined ? {} : { effort: lane.effort }),
          }
        : {}),
      members: Object.freeze(members),
    }) as HostedOwnerLaunchLaneV3;
  });

  if (
    projectedCount !== productPlan.memberBindings.length ||
    projectionRows.length !== productMemberIds.size ||
    new Set(projectionRows.map(({ agentId }) => agentId)).size !== productMemberIds.size ||
    projectionRows.some(({ agentId }) => !productMemberIds.has(agentId))
  ) {
    fail('member_bijection_mismatch', 'hosted-owner-member-bijection-incomplete');
  }
  const designatedPrimaryMemberId = authorityBinding.resolutionSnapshot.designatedPrimaryMemberId;
  const primaryOrdinal = productPlan.memberBindings.findIndex(
    ({ memberId }) => memberId === designatedPrimaryMemberId
  );
  if (primaryOrdinal < 0) {
    fail('primary_member_invalid', 'hosted-owner-designated-primary-missing');
  }

  const plan = deepFreeze({
    schemaVersion: 3 as const,
    workspaceId: promotion.runtimeWorkspaceId,
    teamId: promotion.originalTeamId,
    workspaceRoot: promotion.admittedWorkspaceRoot,
    toolApprovalMode: 'auto' as const,
    runtimePlanRef: authorityBinding.runtimePlanRef,
    primaryOrdinal,
    lanes: Object.freeze(lanes),
  });
  const planJson = JSON.stringify(plan);
  if (new TextEncoder().encode(planJson).byteLength > 256 * 1024) {
    fail('frozen_promotion_invalid', 'hosted-owner-schema3-plan-too-large');
  }
  if (
    typeof authorityIsCurrent !== 'function' ||
    authorityIsCurrent.call(authorityReceiver, authorityBinding) !== true
  ) {
    fail('projection_stale', 'hosted-owner-projection-source-stale');
  }
  const ownerPlanGeneration = `plan-generation_${exactUtf8Sha256(
    planJson,
    capabilityReceiver,
    capabilitySha256Utf8
  )}` as const;
  const binding = Object.freeze({
    ownerPlanGeneration,
    frozenPromotionSha256: promotion.planSha256,
    runtimePlanRef: authorityBinding.runtimePlanRef,
    originalProductPlan,
    productRevision: authorityBinding.productRevision,
    resolutionRevision: authorityBinding.resolutionSnapshot.resolutionRevision,
    resolverRevision: authorityBinding.resolutionSnapshot.resolverRevision,
    primaryOrdinal,
    members: Object.freeze([...projectionRows].sort((left, right) => left.ordinal - right.ordinal)),
    isCurrent: () => authorityIsCurrent.call(authorityReceiver, authorityBinding) === true,
  });
  return Object.freeze({ plan, planJson, binding });
}

function validateFrozenPromotion(
  value: TrustedFrozenHostedPromotion,
  capabilityReceiver: HostedOwnerProjectorCapabilities,
  capabilitySha256Utf8: HostedOwnerProjectorCapabilities['sha256Utf8'] | undefined
): TrustedFrozenHostedPromotion {
  if (
    typeof value?.planJson !== 'string' ||
    new TextEncoder().encode(value.planJson).byteLength > 256 * 1024 ||
    typeof value.planSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.planSha256)
  ) {
    fail('frozen_promotion_invalid', 'hosted-owner-frozen-promotion-invalid');
  }
  if (
    exactUtf8Sha256(value.planJson, capabilityReceiver, capabilitySha256Utf8) !== value.planSha256
  ) {
    fail('frozen_promotion_hash_mismatch', 'hosted-owner-frozen-promotion-hash-mismatch');
  }
  let workspaceId: WorkspaceId;
  let teamId: TeamId;
  try {
    workspaceId = parseWorkspaceId(value.runtimeWorkspaceId);
    teamId = parseTeamId(value.originalTeamId);
  } catch {
    fail('frozen_promotion_invalid', 'hosted-owner-frozen-promotion-identity-invalid');
  }
  if (
    typeof value.admittedWorkspaceRoot !== 'string' ||
    !value.admittedWorkspaceRoot.startsWith('/') ||
    value.admittedWorkspaceRoot.includes('\0') ||
    value.admittedWorkspaceRoot.length > 4096 ||
    !dense(value.laneIds) ||
    new Set(value.laneIds).size !== value.laneIds.length ||
    value.laneIds.some(
      (laneId) => typeof laneId !== 'string' || !/^lane_[0-9a-f]{32}$/.test(laneId)
    )
  ) {
    fail('frozen_promotion_invalid', 'hosted-owner-frozen-promotion-scope-invalid');
  }
  let configuration: HostedRosterConfiguration;
  try {
    configuration = parseHostedRosterConfiguration(value.configuration);
  } catch {
    fail('frozen_promotion_invalid', 'hosted-owner-frozen-configuration-invalid');
  }
  if (configuration.toolApprovalMode !== 'auto') {
    fail('frozen_promotion_invalid', 'hosted-owner-manual-activation-unavailable');
  }
  if (value.laneIds.length !== configuration.lanes.length) {
    fail('frozen_promotion_invalid', 'hosted-owner-frozen-promotion-lane-count-mismatch');
  }
  const expectedBytes = encodeLegacyPlan({
    workspaceId,
    teamId,
    workspaceRoot: value.admittedWorkspaceRoot,
    laneIds: value.laneIds,
    configuration,
    agentLanguage: frozenAgentLanguage(value.planJson),
  });
  if (expectedBytes !== value.planJson) {
    fail('frozen_promotion_invalid', 'hosted-owner-frozen-promotion-bytes-mismatch');
  }
  return Object.freeze({
    ...value,
    runtimeWorkspaceId: workspaceId,
    originalTeamId: teamId,
    laneIds: Object.freeze([...value.laneIds]),
    configuration,
  });
}

function validateOriginalProductPlan(value: CompositeRuntimePlan): CompositeRuntimePlan {
  try {
    const decoded = decodeCompositeRuntimePlan(value);
    if (JSON.stringify(decoded) !== JSON.stringify(value) || !deeplyFrozen(value)) {
      fail('runtime_plan_invalid', 'hosted-owner-original-product-plan-not-canonical-frozen');
    }
    return decoded;
  } catch (error) {
    if (error instanceof HostedOwnerProjectionError) throw error;
    fail('runtime_plan_invalid', 'hosted-owner-original-product-plan-invalid');
  }
}

function validateAuthority(
  authority: HostedOwnerProjectionAuthority,
  resolutionSnapshot: HostedOwnerResolutionSnapshot | undefined,
  promotion: TrustedFrozenHostedPromotion,
  plan: CompositeRuntimePlan
): HostedOwnerProjectionCurrentnessBinding {
  if (
    !authority ||
    typeof authority !== 'object' ||
    !authority.runtimePlanRef ||
    !authority.workspaceBinding ||
    !resolutionSnapshot
  ) {
    fail('runtime_identity_mismatch', 'hosted-owner-runtime-authority-missing');
  }
  try {
    parseTeamId(authority.runtimePlanRef.teamId);
    parseRunId(authority.runtimePlanRef.runId);
    parseWorkspaceId(authority.workspaceBinding.workspaceId);
  } catch {
    fail('runtime_identity_mismatch', 'hosted-owner-runtime-authority-identity-invalid');
  }
  if (
    authority.runtimePlanRef.teamId !== plan.teamId ||
    authority.runtimePlanRef.runId !== plan.runId ||
    authority.runtimePlanRef.generation !== plan.generation ||
    authority.runtimePlanRef.planHash !== plan.planHash ||
    authority.runtimePlanRef.teamId !== promotion.originalTeamId ||
    !Number.isSafeInteger(authority.runtimePlanRef.generation) ||
    authority.runtimePlanRef.generation < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(authority.runtimePlanRef.planHash)
  ) {
    fail('runtime_identity_mismatch', 'hosted-owner-runtime-plan-reference-mismatch');
  }
  if (
    authority.workspaceBinding.workspaceId !== plan.workspaceBinding.workspaceId ||
    authority.workspaceBinding.registrationRevision !==
      plan.workspaceBinding.registrationRevision ||
    authority.workspaceBinding.bindingGeneration !== plan.workspaceBinding.bindingGeneration ||
    authority.workspaceBinding.mountGeneration !== plan.workspaceBinding.mountGeneration ||
    authority.workspaceBinding.workspaceId !== promotion.runtimeWorkspaceId ||
    authority.workspaceRoot !== promotion.admittedWorkspaceRoot
  ) {
    fail('workspace_binding_mismatch', 'hosted-owner-workspace-binding-mismatch');
  }
  if (
    !Number.isSafeInteger(authority.productRevision) ||
    authority.productRevision < 1 ||
    typeof authority.isCurrent !== 'function'
  ) {
    fail('projection_stale', 'hosted-owner-product-revision-invalid');
  }
  const snapshot = copyAndValidateResolutionScope(
    resolutionSnapshot,
    promotion,
    plan,
    authority.productRevision
  );
  return deepFreeze({
    frozenPromotionSha256: promotion.planSha256,
    runtimePlanRef: { ...authority.runtimePlanRef },
    workspaceBinding: { ...authority.workspaceBinding },
    workspaceRoot: authority.workspaceRoot,
    productRevision: authority.productRevision,
    resolutionSnapshot: snapshot,
  });
}

function copyAndValidateResolutionScope(
  value: HostedOwnerResolutionSnapshot,
  promotion: TrustedFrozenHostedPromotion,
  plan: CompositeRuntimePlan,
  productRevision: number
): HostedOwnerResolutionSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !value.runtimePlanRef ||
    value.frozenPromotionSha256 !== promotion.planSha256 ||
    value.productRevision !== productRevision ||
    value.runtimePlanRef.teamId !== plan.teamId ||
    value.runtimePlanRef.runId !== plan.runId ||
    value.runtimePlanRef.generation !== plan.generation ||
    value.runtimePlanRef.planHash !== plan.planHash ||
    !Number.isSafeInteger(value.resolutionRevision) ||
    value.resolutionRevision < 1 ||
    !Number.isSafeInteger(value.resolverRevision) ||
    value.resolverRevision < 1
  ) {
    fail('resolved_configuration_mismatch', 'hosted-owner-resolution-scope-mismatch');
  }
  let designatedPrimaryMemberId: MemberId;
  try {
    designatedPrimaryMemberId = parseMemberId(value.designatedPrimaryMemberId);
  } catch {
    fail('primary_member_invalid', 'hosted-owner-designated-primary-invalid');
  }
  if (!dense(value.members)) {
    fail('resolved_configuration_mismatch', 'hosted-owner-resolved-member-count-mismatch');
  }
  return deepFreeze({
    frozenPromotionSha256: value.frozenPromotionSha256,
    runtimePlanRef: { ...value.runtimePlanRef },
    productRevision: value.productRevision,
    resolutionRevision: value.resolutionRevision,
    resolverRevision: value.resolverRevision,
    designatedPrimaryMemberId,
    members: value.members.map((member) => deepFreeze(copyResolvedMemberFact(member))),
  });
}

function copyResolvedMemberFact(
  fact: HostedOwnerResolvedMemberFact
): HostedOwnerResolvedMemberFact {
  if (
    !fact ||
    typeof fact !== 'object' ||
    !exactKeys(fact, [
      'effort',
      'legacyMemberKey',
      'memberId',
      'memberRevision',
      'model',
      'modelSource',
      'providerId',
    ]) ||
    !fact.effort ||
    typeof fact.effort !== 'object' ||
    !exactKeys(fact.effort, ['kind', 'source', 'value'])
  ) {
    fail('resolved_configuration_mismatch', 'hosted-owner-resolved-member-invalid');
  }
  return {
    memberId: fact.memberId,
    memberRevision: fact.memberRevision,
    legacyMemberKey: fact.legacyMemberKey,
    providerId: fact.providerId,
    model: fact.model,
    modelSource: fact.modelSource,
    effort: { ...fact.effort },
  };
}

function validateResolutionSnapshot(
  snapshot: HostedOwnerResolutionSnapshot,
  promotion: TrustedFrozenHostedPromotion,
  plan: CompositeRuntimePlan,
  capabilityReceiver: HostedOwnerProjectorCapabilities,
  capabilityIsEffortAllowedForProvider:
    | HostedOwnerProjectorCapabilities['isEffortAllowedForProvider']
    | undefined
): ReadonlyMap<LegacyMemberKey, HostedOwnerResolvedMemberFact> {
  if (snapshot.members.length !== plan.memberBindings.length) {
    fail('resolved_configuration_mismatch', 'hosted-owner-resolved-member-count-mismatch');
  }
  const configured = new Map<
    LegacyMemberKey,
    {
      providerId: ProviderId;
      model: string;
      modelSource: 'member' | 'lane';
      explicitEffort?: Effort;
      effortSource?: 'member' | 'lane';
    }
  >();
  for (const lane of promotion.configuration.lanes) {
    for (const member of lane.members) {
      configured.set(member.name as LegacyMemberKey, {
        providerId: lane.provider,
        model: member.model ?? (lane.kind === 'opencode' ? lane.selectedModel : ''),
        modelSource: member.model === undefined ? 'lane' : 'member',
        ...(member.effort !== undefined
          ? { explicitEffort: member.effort, effortSource: 'member' as const }
          : lane.kind === 'opencode' && lane.effort !== undefined
            ? { explicitEffort: lane.effort, effortSource: 'lane' as const }
            : {}),
      });
    }
  }
  const resolved = new Map<LegacyMemberKey, HostedOwnerResolvedMemberFact>();
  snapshot.members.forEach((fact, ordinal) => {
    const binding = plan.memberBindings[ordinal];
    const expected = configured.get(fact.legacyMemberKey);
    const expectedEffortMatches = expected?.explicitEffort
      ? fact.effort.kind === 'resolved' &&
        fact.effort.source === expected.effortSource &&
        fact.effort.value === expected.explicitEffort
      : fact.effort.kind === 'resolved' && fact.effort.source === 'provider_default';
    if (
      binding?.memberId !== fact.memberId ||
      binding.memberRevision !== fact.memberRevision ||
      binding.legacyMemberKey !== fact.legacyMemberKey ||
      binding.providerId !== fact.providerId ||
      expected?.providerId !== fact.providerId ||
      expected.model !== fact.model ||
      expected.modelSource !== fact.modelSource ||
      !expectedEffortMatches ||
      !effortAllowedForProvider(
        fact.effort.value,
        fact.providerId,
        capabilityReceiver,
        capabilityIsEffortAllowedForProvider
      ) ||
      !Number.isSafeInteger(fact.memberRevision) ||
      fact.memberRevision < 1 ||
      resolved.has(fact.legacyMemberKey)
    ) {
      fail('resolved_configuration_mismatch', 'hosted-owner-resolved-member-mismatch');
    }
    resolved.set(fact.legacyMemberKey, fact);
  });
  if (resolved.size !== configured.size) {
    fail('member_bijection_mismatch', 'hosted-owner-configured-member-bijection-incomplete');
  }
  return resolved;
}

function exactUtf8Sha256(
  value: string,
  receiver: HostedOwnerProjectorCapabilities,
  sha256Utf8: HostedOwnerProjectorCapabilities['sha256Utf8'] | undefined
): string {
  if (typeof sha256Utf8 !== 'function') {
    fail('frozen_promotion_invalid', 'hosted-owner-sha256-capability-missing');
  }
  const digest = sha256Utf8.call(receiver, value);
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    fail('frozen_promotion_invalid', 'hosted-owner-sha256-capability-result-invalid');
  }
  return digest;
}

function effortAllowedForProvider(
  value: Effort,
  providerId: ProviderId,
  receiver: HostedOwnerProjectorCapabilities,
  isAllowed: HostedOwnerProjectorCapabilities['isEffortAllowedForProvider'] | undefined
): boolean {
  return typeof isAllowed === 'function' && isAllowed.call(receiver, value, providerId) === true;
}

function encodeLegacyPlan(source: {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly workspaceRoot: string;
  readonly laneIds: readonly string[];
  readonly configuration: HostedRosterConfiguration;
  readonly agentLanguage: string | undefined;
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    workspaceId: source.workspaceId,
    teamId: source.teamId,
    workspaceRoot: source.workspaceRoot,
    toolApprovalMode: source.configuration.toolApprovalMode,
    agentLanguage: source.agentLanguage,
    lanes: source.configuration.lanes.map((lane, index) => ({
      laneId: source.laneIds[index],
      kind: lane.kind,
      provider: lane.provider,
      ...(lane.kind === 'opencode'
        ? {
            selectedModel: lane.selectedModel,
            ...(lane.effort === undefined ? {} : { effort: lane.effort }),
          }
        : {}),
      members: lane.members.map((member) => ({
        name: member.name,
        prompt: member.prompt,
        ...(member.model === undefined ? {} : { model: member.model }),
        ...(member.effort === undefined ? {} : { effort: member.effort }),
      })),
    })),
  });
}

/** The resolved agent language the frozen plan carries; the byte comparison proves the rest. */
function frozenAgentLanguage(planJson: string): string | undefined {
  try {
    const language = (JSON.parse(planJson) as { agentLanguage?: unknown }).agentLanguage;
    return typeof language === 'string' ? language : undefined;
  } catch {
    return undefined;
  }
}

function dense(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return Reflect.ownKeys(value).length === value.length + 1;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && expected.delete(key)) &&
    expected.size === 0
  );
}

function deeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object') return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function fail(code: HostedOwnerProjectionErrorCode, message: string): never {
  throw new HostedOwnerProjectionError(code, message);
}
