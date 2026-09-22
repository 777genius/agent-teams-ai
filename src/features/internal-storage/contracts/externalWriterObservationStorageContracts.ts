import type { TeamIdentityChecksum } from './teamIdentityStorageContracts';
import type { FileObservationStateCheckpoint } from '@features/external-writer-coordination/contracts';
import type { DeploymentId } from '@shared/contracts/hosted';
import type { TeamId } from '@shared/contracts/hosted';

export interface ExternalWriterObservationCheckpointIdentity {
  readonly deploymentId: DeploymentId;
  readonly observerId: string;
}

export interface ExternalWriterObservationCheckpointRecord {
  readonly revision: number;
  readonly checkpoint: FileObservationStateCheckpoint;
}

export interface ExternalWriterObservationCheckpointSaveRequest extends ExternalWriterObservationCheckpointIdentity {
  /** Null creates the row. A stale revision fails closed. */
  readonly expectedRevision: number | null;
  readonly checkpoint: FileObservationStateCheckpoint;
}

export interface ExternalWriterObservationRetirementProof {
  readonly teamId: TeamId;
  readonly identityChecksum: TeamIdentityChecksum;
  readonly tombstonedAt: string;
}

export interface ExternalWriterCleanHandoffPlan {
  readonly handoffId: string;
  readonly oldCatalogToken: string;
  readonly nextCatalogToken: string;
  readonly retainedRegistrations: readonly ExternalWriterRetainedRegistration[];
  readonly retirementProofs: readonly ExternalWriterObservationRetirementProof[];
  readonly createdAt: string;
}

export interface ExternalWriterCleanHandoffSaveRequest extends ExternalWriterObservationCheckpointSaveRequest {
  readonly plan: ExternalWriterCleanHandoffPlan;
}

export interface ExternalWriterRetainedRegistration {
  readonly teamId: TeamId;
  readonly featureKey: string;
  readonly fileKey: string;
}

export interface ExternalWriterCleanHandoffConsumeRequest extends ExternalWriterObservationCheckpointIdentity {
  readonly consumeAttemptId: string;
}

export interface ExternalWriterObservationCheckpointStorageGateway {
  loadExternalWriterObservationCheckpoint(
    identity: ExternalWriterObservationCheckpointIdentity
  ): Promise<ExternalWriterObservationCheckpointRecord | null>;
  saveExternalWriterObservationCheckpoint(
    request: ExternalWriterObservationCheckpointSaveRequest
  ): Promise<ExternalWriterObservationCheckpointRecord>;
  saveExternalWriterCleanHandoffEligibility(
    request: ExternalWriterCleanHandoffSaveRequest
  ): Promise<ExternalWriterObservationCheckpointRecord>;
  consumeExternalWriterCleanHandoffEligibility(
    request: ExternalWriterCleanHandoffConsumeRequest
  ): Promise<ExternalWriterObservationCheckpointRecord | null>;
}
