import type { InstanceLeaseAnchorEvidence } from './instanceLeaseContracts';
import type {
  RuntimeInstanceContext,
  RuntimeRootReference,
} from '@features/runtime-instance-context';
import type { WorkspaceMountBindingRef } from '@features/workspace-registry/contracts';

export const PHASE3_MUTATION_ADMISSION_DIMENSIONS = Object.freeze([
  'instanceLease',
  'runtimeBinding',
  'workspaceBinding',
  'storage',
  'filesystem',
  'externalWriter',
  'recoveryOutbox',
] as const);

export const MAX_PHASE3_MUTATION_ASSESSMENT_TIMEOUT_MS = 30_000;

export type Phase3MutationAdmissionDimension =
  (typeof PHASE3_MUTATION_ADMISSION_DIMENSIONS)[number];
export type Phase3MutationAdmissionDecisionStatus = 'verified' | 'denied';
export type Phase3EvidenceAvailability = 'unavailable' | 'unknown';

export type Phase3InstanceLeaseDiagnosticCode =
  | 'instance_lease_held'
  | 'instance_lease_unavailable'
  | 'instance_lease_evidence_timeout'
  | 'instance_lease_invalid'
  | 'instance_lease_released'
  | 'instance_lease_changed';

export type Phase3RuntimeBindingDiagnosticCode =
  | 'runtime_binding_verified'
  | 'runtime_context_unavailable'
  | 'runtime_binding_evidence_unavailable'
  | 'runtime_binding_evidence_timeout'
  | 'runtime_binding_evidence_unknown'
  | 'runtime_binding_evidence_stale'
  | 'runtime_binding_evidence_invalid'
  | 'runtime_binding_deployment_mismatch'
  | 'runtime_binding_boot_mismatch'
  | 'runtime_binding_roots_mismatch'
  | 'runtime_binding_lease_anchor_unverified'
  | 'runtime_binding_lease_anchor_mismatch';

export type Phase3WorkspaceBindingDiagnosticCode =
  | 'workspace_binding_verified'
  | 'workspace_binding_context_unavailable'
  | 'workspace_binding_evidence_unavailable'
  | 'workspace_binding_evidence_timeout'
  | 'workspace_binding_evidence_unknown'
  | 'workspace_binding_evidence_stale'
  | 'workspace_binding_evidence_invalid'
  | 'workspace_binding_workspace_mismatch'
  | 'workspace_binding_boot_mismatch'
  | 'workspace_binding_mount_generation_mismatch'
  | 'workspace_binding_root_mismatch'
  | 'workspace_binding_registration_mismatch'
  | 'workspace_binding_not_writable';

export type Phase3StorageDiagnosticCode =
  | 'storage_ready'
  | 'storage_evidence_unavailable'
  | 'storage_evidence_timeout'
  | 'storage_evidence_unknown'
  | 'storage_evidence_stale'
  | 'storage_evidence_invalid'
  | 'storage_binding_mismatch'
  | 'storage_backend_unavailable'
  | 'storage_compatibility_unverified'
  | 'storage_schema_mismatch'
  | 'storage_migration_incomplete'
  | 'storage_integrity_unverified'
  | 'storage_critical_fallback_enabled';

export type Phase3FilesystemDiagnosticCode =
  | 'filesystem_ready'
  | 'filesystem_evidence_unavailable'
  | 'filesystem_evidence_timeout'
  | 'filesystem_evidence_unknown'
  | 'filesystem_evidence_stale'
  | 'filesystem_evidence_invalid'
  | 'filesystem_binding_mismatch'
  | 'filesystem_unsupported'
  | 'filesystem_permission_unverified'
  | 'filesystem_free_space_insufficient'
  | 'filesystem_atomic_replace_unverified'
  | 'filesystem_directory_durability_unverified';

export type Phase3ExternalWriterDiagnosticCode =
  | 'external_writer_coordinated'
  | 'external_writer_evidence_unavailable'
  | 'external_writer_evidence_timeout'
  | 'external_writer_evidence_unknown'
  | 'external_writer_evidence_stale'
  | 'external_writer_evidence_invalid'
  | 'external_writer_binding_mismatch'
  | 'external_writer_class_unknown'
  | 'external_writer_class_unavailable'
  | 'external_writer_coordination_unverified'
  | 'external_writer_observation_dirty';

export type Phase3RecoveryOutboxDiagnosticCode =
  | 'recovery_outbox_ready'
  | 'recovery_outbox_evidence_unavailable'
  | 'recovery_outbox_evidence_timeout'
  | 'recovery_outbox_evidence_unknown'
  | 'recovery_outbox_evidence_stale'
  | 'recovery_outbox_evidence_invalid'
  | 'recovery_outbox_binding_mismatch'
  | 'recovery_scan_incomplete'
  | 'recovery_pending'
  | 'recovery_operator_required'
  | 'recovery_unknown_records'
  | 'outbox_unavailable';

export type Phase3MutationAdmissionDiagnosticCode =
  | Phase3InstanceLeaseDiagnosticCode
  | Phase3RuntimeBindingDiagnosticCode
  | Phase3WorkspaceBindingDiagnosticCode
  | Phase3StorageDiagnosticCode
  | Phase3FilesystemDiagnosticCode
  | Phase3ExternalWriterDiagnosticCode
  | Phase3RecoveryOutboxDiagnosticCode;

export interface Phase3MutationDimensionDecision<
  TDimension extends Phase3MutationAdmissionDimension,
  TCode extends Phase3MutationAdmissionDiagnosticCode,
> {
  readonly dimension: TDimension;
  readonly status: Phase3MutationAdmissionDecisionStatus;
  readonly code: TCode;
}

export type Phase3InstanceLeaseDecision = Phase3MutationDimensionDecision<
  'instanceLease',
  Phase3InstanceLeaseDiagnosticCode
>;
export type Phase3RuntimeBindingDecision = Phase3MutationDimensionDecision<
  'runtimeBinding',
  Phase3RuntimeBindingDiagnosticCode
>;
export type Phase3WorkspaceBindingDecision = Phase3MutationDimensionDecision<
  'workspaceBinding',
  Phase3WorkspaceBindingDiagnosticCode
>;
export type Phase3StorageDecision = Phase3MutationDimensionDecision<
  'storage',
  Phase3StorageDiagnosticCode
>;
export type Phase3FilesystemDecision = Phase3MutationDimensionDecision<
  'filesystem',
  Phase3FilesystemDiagnosticCode
>;
export type Phase3ExternalWriterDecision = Phase3MutationDimensionDecision<
  'externalWriter',
  Phase3ExternalWriterDiagnosticCode
>;
export type Phase3RecoveryOutboxDecision = Phase3MutationDimensionDecision<
  'recoveryOutbox',
  Phase3RecoveryOutboxDiagnosticCode
>;

export interface Phase3MutationAdmissionDecisions {
  readonly instanceLease: Phase3InstanceLeaseDecision;
  readonly runtimeBinding: Phase3RuntimeBindingDecision;
  readonly workspaceBinding: Phase3WorkspaceBindingDecision;
  readonly storage: Phase3StorageDecision;
  readonly filesystem: Phase3FilesystemDecision;
  readonly externalWriter: Phase3ExternalWriterDecision;
  readonly recoveryOutbox: Phase3RecoveryOutboxDecision;
}

/**
 * Diagnostic evidence assessment only. It is deliberately not mutation
 * authority and cannot be converted into a reusable capability. A future
 * one-shot mutation capability must acquire and hold both the writer fence and
 * mount fence, then revalidate every dimension under one evidence generation
 * while those fences remain held.
 */
export interface Phase3MutationAdmissionAssessment {
  readonly kind: 'phase3_mutation_admission_diagnostic';
  readonly assessment: 'all_evidence_verified' | 'denied';
  readonly authoritativeForMutation: false;
  readonly decisions: Phase3MutationAdmissionDecisions;
  readonly diagnosticCodes: readonly Phase3MutationAdmissionDiagnosticCode[];
}

export interface Phase3MutationAdmissionWorkspaceTarget {
  readonly binding: WorkspaceMountBindingRef;
  readonly rootReference: RuntimeRootReference<'workspace'>;
  readonly declaredRootHash: string;
  readonly registrationRevision: number;
}

export interface Phase3MutationAdmissionRequirements {
  readonly storageSchemaVersion: number;
  readonly minimumFreeBytes: number;
  readonly evidenceMaxAgeMs: number;
  /** One end-to-end deadline shared by all initial and final inspections. */
  readonly evaluationTimeoutMs: number;
}

export interface Phase3MutationAdmissionScope {
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly workspace: Phase3MutationAdmissionWorkspaceTarget;
  readonly requirements: Phase3MutationAdmissionRequirements;
}

export interface Phase3VerifiedRuntimeBindingEvidence {
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly leaseAnchor: InstanceLeaseAnchorEvidence;
}

export interface Phase3VerifiedWorkspaceBindingEvidence {
  readonly binding: WorkspaceMountBindingRef;
  readonly rootReference: RuntimeRootReference<'workspace'>;
  readonly declaredRootHash: string;
  readonly registrationRevision: number;
  readonly health: 'healthy' | 'read-only' | 'unavailable';
}

export interface Phase3VerifiedStorageEvidence {
  readonly deploymentId: RuntimeInstanceContext['deploymentId'];
  readonly appDataRootReference: RuntimeInstanceContext['appDataRoot']['reference'];
  readonly backend: 'sqlite' | 'unavailable' | 'unknown';
  readonly compatibility: 'verified' | 'unverified' | 'unknown';
  readonly schemaVersion: number;
  readonly migrationState: 'complete' | 'pending' | 'failed' | 'unknown';
  readonly integrity: 'ok' | 'failed' | 'unknown';
  readonly criticalFallback: 'disabled' | 'enabled' | 'unknown';
}

export interface Phase3VerifiedFilesystemEvidence {
  readonly deploymentId: RuntimeInstanceContext['deploymentId'];
  readonly bootId: RuntimeInstanceContext['bootId'];
  readonly workspaceBinding: WorkspaceMountBindingRef;
  readonly rootReference: RuntimeRootReference<'workspace'>;
  readonly filesystem: 'supported' | 'unsupported' | 'unknown';
  readonly permission: 'read_write' | 'read_only' | 'denied' | 'unknown';
  readonly freeBytes: number;
  readonly atomicReplace: 'verified' | 'unverified' | 'unknown';
  readonly directoryDurability: 'verified' | 'unverified' | 'unknown';
}

export type Phase3ExternalWriterClassification =
  | 'app_exclusive'
  | 'cooperative_external'
  | 'provider_mediated'
  | 'quiescent_only'
  | 'unavailable'
  | 'unknown';

export type Phase3ExternalWriterCoordination =
  | 'lease_fenced'
  | 'protocol_verified'
  | 'provider_protocol_verified'
  | 'quiesced'
  | 'busy'
  | 'dirty'
  | 'unknown';

export interface Phase3VerifiedExternalWriterEvidence {
  readonly deploymentId: RuntimeInstanceContext['deploymentId'];
  readonly bootId: RuntimeInstanceContext['bootId'];
  readonly workspaceBinding: WorkspaceMountBindingRef;
  readonly classification: Phase3ExternalWriterClassification;
  readonly coordination: Phase3ExternalWriterCoordination;
  readonly observation: 'clean' | 'dirty' | 'unknown';
  readonly fileWriterEpoch: number;
  readonly observationWatermark: number;
}

export interface Phase3VerifiedRecoveryOutboxEvidence {
  readonly deploymentId: RuntimeInstanceContext['deploymentId'];
  readonly storageSchemaVersion: number;
  readonly scanState: 'complete' | 'incomplete' | 'unknown';
  readonly recoveryState: 'complete' | 'pending' | 'unknown';
  readonly outboxState: 'ready' | 'unavailable' | 'unknown';
  readonly pendingCommandCount: number;
  readonly recoveringCommandCount: number;
  readonly operatorRequiredCount: number;
  readonly unknownRecordCount: number;
}

export type Phase3EvidenceInspection<TEvidence> =
  | {
      readonly status: 'verified';
      readonly checkedAtMs: number;
      readonly evidence: TEvidence;
    }
  | {
      readonly status: Phase3EvidenceAvailability;
    };
