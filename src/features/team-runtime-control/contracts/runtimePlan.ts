import type {
  LegacyMemberKey,
  MemberId,
  RunId,
  TeamId,
  WorkspaceId,
} from '@shared/contracts/hosted';
import type { TeamProviderId } from '@shared/types';

declare const runtimePlanIdBrand: unique symbol;
declare const compositeRuntimePlanHashBrand: unique symbol;

type RuntimePlanId<Name extends string> = string & {
  readonly [runtimePlanIdBrand]: Name;
};

export type LaneId = RuntimePlanId<'LaneId'>;
export type ExecutionUnitId = RuntimePlanId<'ExecutionUnitId'>;
export type RuntimeBackendBindingId = RuntimePlanId<'RuntimeBackendBindingId'>;
export type RuntimeBinaryId = RuntimePlanId<'RuntimeBinaryId'>;
export type SecretRefId = RuntimePlanId<'SecretRefId'>;
export type SecretClass = RuntimePlanId<'SecretClass'>;

export const COMPOSITE_RUNTIME_PLAN_VERSION = 1 as const;
export type CompositeRuntimePlanVersion = typeof COMPOSITE_RUNTIME_PLAN_VERSION;

export const RUNTIME_TOPOLOGY_MODES = Object.freeze([
  'primary_only',
  'pure_opencode',
  'pure_opencode_solo',
  'pure_opencode_member_lanes',
  'mixed_opencode_side_lanes',
] as const);
export type RuntimeTopologyMode = (typeof RUNTIME_TOPOLOGY_MODES)[number];

export const RUNTIME_EXECUTION_BACKENDS = Object.freeze(['provisioning_cli', 'opencode'] as const);
export type RuntimeExecutionBackendKind = (typeof RUNTIME_EXECUTION_BACKENDS)[number];

export const HOSTED_CHILD_ENVIRONMENT_PROVENANCE = Object.freeze([
  'provider_static',
  'runtime_metadata',
  'workspace_metadata',
  'secret_ref',
] as const);
export type HostedChildEnvironmentProvenance = (typeof HOSTED_CHILD_ENVIRONMENT_PROVENANCE)[number];

export type RuntimeLaneKind = 'primary' | 'secondary';
export type RuntimeMemberPolicy = 'required' | 'optional';
export type CredentialIsolation = 'shared_execution_unit' | 'dedicated_execution_unit';
export type Sha256Hash = `sha256:${string}`;
export type CompositeRuntimePlanHash = Sha256Hash & {
  readonly [compositeRuntimePlanHashBrand]: 'CompositeRuntimePlanHash';
};

/** Metadata only. Secret values are resolved by an owning output adapter. */
export interface SecretRefMetadata {
  readonly secretRefId: SecretRefId;
  readonly secretClass: SecretClass;
}

export interface CredentialExposureSet {
  readonly secretRefs: readonly SecretRefMetadata[];
}

export interface RuntimeExecutionBackendBinding {
  readonly backend: RuntimeExecutionBackendKind;
  readonly bindingId: RuntimeBackendBindingId;
  readonly bindingRevision: number;
}

/** Opaque registered binary identity. It deliberately carries no executable path. */
export interface ResolvedRuntimeBinaryPolicy {
  readonly policy: 'registered_exact_binary';
  readonly binaryId: RuntimeBinaryId;
  readonly binaryRevision: number;
  readonly binaryHash: Sha256Hash;
}

export interface HostedChildEnvironmentVariablePolicy {
  readonly name: string;
  readonly provenance: HostedChildEnvironmentProvenance;
  readonly secretRef?: SecretRefMetadata;
}

/** Allowlist-first metadata. It never contains inherited environment values or secret material. */
export interface HostedChildEnvironmentPolicy {
  readonly policy: 'explicit_allowlist';
  readonly variables: readonly HostedChildEnvironmentVariablePolicy[];
}

export interface RuntimeResourcePolicy {
  readonly maxRuntimeMs: number;
  readonly gracefulStopMs: number;
  readonly maxOutputBytes: number;
  readonly maxProcessCount: number;
}

export interface RuntimePlanLaneBinding {
  readonly laneId: LaneId;
  readonly laneKind: RuntimeLaneKind;
  readonly ordinal: number;
  readonly memberIds: readonly MemberId[];
  readonly requiredCredentialExposureSet: CredentialExposureSet;
}

export interface ProcessExecutionUnit {
  readonly executionUnitId: ExecutionUnitId;
  readonly backendBinding: RuntimeExecutionBackendBinding;
  /** One exact planner lane per unit. Combining planner lanes is not admitted. */
  readonly laneId: LaneId;
  readonly memberIds: readonly MemberId[];
  readonly binaryPolicy: ResolvedRuntimeBinaryPolicy;
  readonly environmentPolicy: HostedChildEnvironmentPolicy;
  readonly credentialExposureSet: CredentialExposureSet;
  readonly credentialIsolation: CredentialIsolation;
  readonly resourcePolicy: RuntimeResourcePolicy;
}

export interface RuntimePlanMemberBinding {
  readonly memberId: MemberId;
  readonly memberRevision: number;
  readonly legacyMemberKey: LegacyMemberKey;
  readonly providerId: TeamProviderId;
  readonly laneId: LaneId;
  readonly policy: RuntimeMemberPolicy;
}

export interface RegisteredWorkspaceRuntimeBinding {
  readonly workspaceId: WorkspaceId;
  readonly registrationRevision: number;
  readonly bindingGeneration: number;
  readonly mountGeneration: number;
}

export interface CompositeRuntimePlan {
  readonly planVersion: CompositeRuntimePlanVersion;
  readonly planHash: CompositeRuntimePlanHash;
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly generation: number;
  readonly leadProviderId: TeamProviderId;
  readonly topologyMode: RuntimeTopologyMode;
  readonly orderedLaneIds: readonly LaneId[];
  readonly lanes: readonly RuntimePlanLaneBinding[];
  readonly rosterGeneration: number;
  readonly memberBindings: readonly RuntimePlanMemberBinding[];
  readonly workspaceBinding: RegisteredWorkspaceRuntimeBinding;
  readonly executionUnits: readonly ProcessExecutionUnit[];
}

const RUNTIME_PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parseRuntimePlanId<Name extends string>(
  value: unknown,
  diagnostic: string
): RuntimePlanId<Name> {
  if (typeof value !== 'string' || !RUNTIME_PLAN_ID_PATTERN.test(value)) {
    throw new TypeError(diagnostic);
  }
  return value as RuntimePlanId<Name>;
}

export const parseLaneId = (value: unknown): LaneId =>
  parseRuntimePlanId<'LaneId'>(value, 'runtime-plan-lane-id-invalid');
export const parseExecutionUnitId = (value: unknown): ExecutionUnitId =>
  parseRuntimePlanId<'ExecutionUnitId'>(value, 'runtime-plan-execution-unit-id-invalid');
export const parseRuntimeBackendBindingId = (value: unknown): RuntimeBackendBindingId =>
  parseRuntimePlanId<'RuntimeBackendBindingId'>(value, 'runtime-plan-backend-binding-id-invalid');
export const parseRuntimeBinaryId = (value: unknown): RuntimeBinaryId =>
  parseRuntimePlanId<'RuntimeBinaryId'>(value, 'runtime-plan-binary-id-invalid');
export const parseSecretRefId = (value: unknown): SecretRefId =>
  parseRuntimePlanId<'SecretRefId'>(value, 'runtime-plan-secret-ref-id-invalid');
export const parseSecretClass = (value: unknown): SecretClass =>
  parseRuntimePlanId<'SecretClass'>(value, 'runtime-plan-secret-class-invalid');
