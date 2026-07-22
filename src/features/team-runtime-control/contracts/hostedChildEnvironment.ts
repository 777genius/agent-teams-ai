import type {
  CredentialExposureSet,
  ExecutionUnitId,
  LaneId,
  RuntimeExecutionBackendKind,
  SecretRefMetadata,
  Sha256Hash,
} from './runtimePlan';
import type { RunId } from '@shared/contracts/hosted';
import type { TeamProviderId } from '@shared/types';

declare const hostedChildEnvironmentHashBrand: unique symbol;

export type HostedChildEnvironmentKeyProvenanceHash = Sha256Hash & {
  readonly [hostedChildEnvironmentHashBrand]: 'HostedChildEnvironmentKeyProvenanceHash';
};

export const HOSTED_CHILD_ENVIRONMENT_NON_SECRET_PROVENANCE = Object.freeze([
  'provider_static',
  'runtime_metadata',
  'workspace_metadata',
] as const);
export type HostedChildEnvironmentNonSecretProvenance =
  (typeof HOSTED_CHILD_ENVIRONMENT_NON_SECRET_PROVENANCE)[number];

export const HOSTED_CHILD_ENVIRONMENT_NON_SECRET_AUTHORITIES = Object.freeze([
  'runtime-provider-management',
  'team-runtime-control',
  'workspace-registry',
] as const);
export type HostedChildEnvironmentNonSecretAuthority =
  (typeof HOSTED_CHILD_ENVIRONMENT_NON_SECRET_AUTHORITIES)[number];

/**
 * Controller-owned values can never become provider-child inputs, even through an otherwise valid
 * provider declaration. Loader/runtime injection keys are intentionally not listed here: they remain
 * subject to explicit provider declaration and provenance policy.
 */
export const HOSTED_CHILD_ENVIRONMENT_CONTROLLER_ONLY_DENIAL = Object.freeze({
  exactNames: Object.freeze([
    'CONTROLLER_SECRET_CANARY',
    'HOSTED_BROWSER_SESSION_SECRET',
    'HOSTED_CSRF_KEY',
    'HOSTED_DATABASE_ENCRYPTION_KEY',
    'HOSTED_INSTANCE_LEASE_DESCRIPTOR',
    'HOSTED_INTERNAL_CONTROL_CREDENTIAL',
    'HOSTED_LAUNCHER_CONTROL_PIPE',
    'HOSTED_PAIRING_SECRET',
    'HOSTED_PRIVATE_METRICS_CREDENTIAL',
    'HOSTED_PRIVATE_READINESS_CREDENTIAL',
    'HOSTED_RUNTIME_INGRESS_BEARER',
    'HOSTED_STATE_ENCRYPTION_KEY',
    'HOSTED_TERMINAL_TICKET',
  ] as const),
  prefixes: Object.freeze([
    'AGENT_TEAMS_CONTROLLER_',
    'AGENT_TEAMS_HOSTED_',
    'CLAUDE_TEAM_CONTROLLER_',
    'HOSTED_CONTROLLER_',
  ] as const),
});

export interface HostedChildEnvironmentIdentity {
  readonly providerId: TeamProviderId;
  readonly backend: RuntimeExecutionBackendKind;
  readonly executionUnitId: ExecutionUnitId;
  readonly laneId: LaneId;
  readonly runId: RunId;
}

export interface HostedChildEnvironmentNonSecretVariable {
  readonly name: string;
  readonly provenance: HostedChildEnvironmentNonSecretProvenance;
  readonly authority: HostedChildEnvironmentNonSecretAuthority;
}

export interface HostedChildEnvironmentSecretVariable {
  readonly name: string;
  readonly provenance: 'secret_ref';
  readonly secretRef: SecretRefMetadata;
}

export type HostedChildEnvironmentVariable =
  | HostedChildEnvironmentNonSecretVariable
  | HostedChildEnvironmentSecretVariable;

/** Provider-authored metadata only. Values and ambient environment sources are not contract fields. */
export interface HostedChildEnvironmentProviderDeclaration {
  readonly providerId: TeamProviderId;
  readonly backend: RuntimeExecutionBackendKind;
  readonly secretRefs: readonly SecretRefMetadata[];
  readonly variables: readonly HostedChildEnvironmentVariable[];
}

export interface CreateHostedChildEnvironmentPolicyInput {
  readonly identity: HostedChildEnvironmentIdentity;
  readonly providerDeclaration: HostedChildEnvironmentProviderDeclaration;
  readonly requestedVariables: readonly HostedChildEnvironmentVariable[];
  readonly acceptedCredentialExposureSet: CredentialExposureSet;
  readonly inheritance: 'none';
}

/**
 * Immutable allowlist-first policy. It is structurally compatible with the launch-plan policy shape,
 * while binding its provenance to one provider, backend, execution unit, lane and run.
 */
export interface HostedChildEnvironmentPolicy {
  readonly policy: 'explicit_allowlist';
  readonly inheritance: 'none';
  readonly identity: HostedChildEnvironmentIdentity;
  readonly variables: readonly HostedChildEnvironmentVariable[];
  readonly acceptedCredentialExposureSet: CredentialExposureSet;
  readonly keyProvenanceHash: HostedChildEnvironmentKeyProvenanceHash;
}

export const HOSTED_CHILD_ENVIRONMENT_POLICY_ERROR_CODES = Object.freeze([
  'invalid_contract',
  'environment_inheritance_forbidden',
  'contract_secret_value_forbidden',
  'identity_mismatch',
  'duplicate_key',
  'duplicate_secret_ref',
  'unknown_key',
  'forbidden_key',
  'secret_ref_not_declared',
  'credential_exposure_widening',
  'credential_exposure_mismatch',
  'policy_not_immutable',
  'policy_hash_mismatch',
  'value_resolution_failed',
  'resolved_value_invalid',
] as const);
export type HostedChildEnvironmentPolicyErrorCode =
  (typeof HOSTED_CHILD_ENVIRONMENT_POLICY_ERROR_CODES)[number];

/** Safe typed diagnostics contain identifiers only, never resolved or contract-supplied values. */
export interface HostedChildEnvironmentPolicyError {
  readonly code: HostedChildEnvironmentPolicyErrorCode;
  readonly key?: string;
}

export type CreateHostedChildEnvironmentPolicyResult =
  | { readonly status: 'accepted'; readonly policy: HostedChildEnvironmentPolicy }
  | { readonly status: 'rejected'; readonly error: HostedChildEnvironmentPolicyError };
