import type {
  LegacyTeamKey,
  TeamIdentityBlockReason,
  TeamIdentityFile,
  TeamIdentityIntent,
} from '../../core/application/ports/TeamIdentityPersistence';
import type { TeamId } from '@shared/contracts/hosted/identifiers';

export interface PrepareTeamDirectoryRequest {
  readonly intent: TeamIdentityIntent;
  readonly operationId: string;
}

export type PrepareTeamDirectoryOutcome =
  | { readonly status: 'created' | 'resumed'; readonly teamId: TeamId }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'legacy_key_conflict'
        | 'legacy_key_tombstoned'
        | 'persistence_mismatch'
        | 'root_not_admitted'
        | 'unsafe_team_directory';
    };

export interface PublishAndCommitTeamIdentityRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly identity: TeamIdentityFile;
}

export type PublishAndCommitTeamIdentityOutcome =
  | {
      readonly status: 'committed' | 'already_committed';
      readonly teamId: TeamId;
      readonly identityGeneration: number;
      readonly recovery: 'published_and_committed' | 'resumed_file_published' | 'already_committed';
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | TeamIdentityBlockReason
        | 'authority_not_durable'
        | 'commit_blocked'
        | 'intent_mismatch'
        | 'publication_not_durable';
    };

export interface AttemptOwnedArtifact {
  readonly relativePath: string;
  readonly ownerRunId: string;
}

export interface RegisterAttemptArtifactOwnershipRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly runId: string;
  readonly artifactRelativePath: string;
  readonly createdAt: string;
}

export type RegisterAttemptArtifactOwnershipOutcome =
  | { readonly status: 'registered' | 'already_registered'; readonly durability: 'durable' }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'artifact_not_pristine'
        | 'artifact_ownership_unproven'
        | 'identity_blocked'
        | 'root_not_admitted'
        | 'unsafe_attempt_path'
        | 'unsafe_team_directory';
    };

export interface CleanupProvisioningFailureRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly runId: string;
  readonly attemptOwnedArtifacts: readonly AttemptOwnedArtifact[];
}

export type CleanupProvisioningFailureOutcome =
  | {
      readonly status: 'cleaned';
      readonly removedArtifacts: readonly string[];
      readonly anchorPreserved: true;
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'artifact_ownership_mismatch'
        | 'artifact_ownership_unproven'
        | 'identity_blocked'
        | 'protected_artifact'
        | 'root_not_admitted'
        | 'unsafe_attempt_path'
        | 'unsafe_team_directory';
    };

export interface ExplicitTeamDeleteRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly expectedIdentityGeneration: number;
  readonly confirmation: 'delete_draft' | 'permanent_delete';
  readonly requestedAt: string;
}

export interface AbortPreparedTeamDirectoryRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly expectedIdentityGeneration: number;
  readonly confirmation: 'prepared_abort';
  readonly requestedAt: string;
}

export type ExplicitTeamDeleteOutcome =
  | {
      readonly status: 'deleted' | 'already_deleted';
      readonly tombstoneGeneration: number;
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'delete_not_explicit'
        | 'filesystem_delete_failed'
        | 'identity_blocked'
        | 'root_not_admitted'
        | 'tombstone_not_durable'
        | 'unsafe_team_directory';
    };
