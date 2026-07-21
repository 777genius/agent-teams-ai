import {
  createPhase3MutationAdmissionAssessor as createFeatureMutationAdmissionAssessor,
  type Phase3MutationAdmissionAssessor,
  type Phase3MutationAdmissionInput,
} from '@features/instance-lease';

/**
 * Phase 3 composition surface only. The contracts, pure policy, deadline and
 * application orchestration are feature-owned. Nothing here wires a mutation
 * route, callback, facade, or standalone runtime.
 */
export function createPhase3MutationAdmissionAssessor(
  input: Phase3MutationAdmissionInput
): Phase3MutationAdmissionAssessor {
  return createFeatureMutationAdmissionAssessor(input);
}

export {
  MAX_PHASE3_MUTATION_ASSESSMENT_TIMEOUT_MS,
  PHASE3_MUTATION_ADMISSION_DIMENSIONS,
  type Phase3AdmissionInspectionContext,
  type Phase3EvidenceAvailability,
  type Phase3EvidenceInspection,
  type Phase3ExternalWriterClassification,
  type Phase3ExternalWriterCoordination,
  type Phase3ExternalWriterDecision,
  type Phase3ExternalWriterDiagnosticCode,
  type Phase3ExternalWriterEvidencePort,
  type Phase3FilesystemCapabilityEvidencePort,
  type Phase3FilesystemDecision,
  type Phase3FilesystemDiagnosticCode,
  type Phase3InstanceLeaseDecision,
  type Phase3InstanceLeaseDiagnosticCode,
  type Phase3MutationAdmissionAssessment,
  type Phase3MutationAdmissionAssessor,
  type Phase3MutationAdmissionClock,
  type Phase3MutationAdmissionDecisions,
  type Phase3MutationAdmissionDecisionStatus,
  type Phase3MutationAdmissionDiagnosticCode,
  type Phase3MutationAdmissionDimension,
  type Phase3MutationAdmissionEvidencePorts,
  type Phase3MutationAdmissionInput,
  type Phase3MutationAdmissionRequirements,
  type Phase3MutationAdmissionScope,
  type Phase3MutationAdmissionWorkspaceTarget,
  type Phase3MutationDimensionDecision,
  type Phase3RecoveryOutboxDecision,
  type Phase3RecoveryOutboxDiagnosticCode,
  type Phase3RecoveryOutboxEvidencePort,
  type Phase3RuntimeBindingDecision,
  type Phase3RuntimeBindingDiagnosticCode,
  type Phase3RuntimeBindingEvidencePort,
  type Phase3StorageDecision,
  type Phase3StorageDiagnosticCode,
  type Phase3StorageReadinessEvidencePort,
  type Phase3VerifiedExternalWriterEvidence,
  type Phase3VerifiedFilesystemEvidence,
  type Phase3VerifiedRecoveryOutboxEvidence,
  type Phase3VerifiedRuntimeBindingEvidence,
  type Phase3VerifiedStorageEvidence,
  type Phase3VerifiedWorkspaceBindingEvidence,
  type Phase3WorkspaceBindingDecision,
  type Phase3WorkspaceBindingDiagnosticCode,
  type Phase3WorkspaceBindingEvidencePort,
} from '@features/instance-lease';
