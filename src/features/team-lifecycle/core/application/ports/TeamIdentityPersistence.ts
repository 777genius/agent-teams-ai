import type { DeploymentId, TeamId, WorkspaceId } from '@shared/contracts/hosted/identifiers';

declare const legacyTeamKeyBrand: unique symbol;
declare const identityChecksumBrand: unique symbol;

export type LegacyTeamKey = string & { readonly [legacyTeamKeyBrand]: 'LegacyTeamKey' };
export type TeamIdentityChecksum = string & {
  readonly [identityChecksumBrand]: 'TeamIdentityChecksum';
};

export const TEAM_IDENTITY_SCHEMA_VERSION = 1 as const;
export const TEAM_IDENTITY_FILE_NAME = 'team.identity.json' as const;
export const TEAM_DIRECTORY_ROOT_MARKER_FILE = '.agent-teams-p2d-root.json' as const;
export const TEAM_ATTEMPT_OWNERSHIP_FILE_NAME = '.agent-teams-attempt-ownership.json' as const;

const LEGACY_TEAM_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const WINDOWS_RESERVED_KEYS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function parseLegacyTeamKey(value: unknown): LegacyTeamKey {
  if (
    typeof value !== 'string' ||
    !LEGACY_TEAM_KEY_PATTERN.test(value) ||
    WINDOWS_RESERVED_KEYS.has(value)
  ) {
    throw new TypeError('team-identity-legacy-key-invalid');
  }
  return value as LegacyTeamKey;
}

export function parseTeamIdentityChecksum(value: unknown): TeamIdentityChecksum {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('team-identity-checksum-invalid');
  }
  return value as TeamIdentityChecksum;
}

export interface TeamIdentityFile {
  readonly schemaVersion: typeof TEAM_IDENTITY_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly createdAt: string;
  readonly originDeploymentId?: DeploymentId;
}

export interface DirectoryInstanceFingerprint {
  readonly canonicalParentDigest: string;
  readonly relativeDirectoryKey: LegacyTeamKey;
  readonly device?: string;
  readonly inode?: string;
  readonly observedAt: string;
}

export interface TeamWorkspaceBindingEvidence {
  readonly workspaceId: WorkspaceId;
  readonly bindingGeneration: number;
  readonly observedMountGeneration: number;
}

export interface TeamIdentityIntent {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly expectedChecksum: TeamIdentityChecksum;
  readonly directoryFingerprint: DirectoryInstanceFingerprint;
  readonly workspaceBinding: TeamWorkspaceBindingEvidence;
  readonly expectedFile: 'absent';
  readonly createdAt: string;
  readonly originDeploymentId?: DeploymentId;
}

export type TeamIdentityMismatchReason =
  | 'candidate_tombstoned'
  | 'checksum_mismatch'
  | 'directory_fingerprint_mismatch'
  | 'duplicate_team_id'
  | 'identity_mismatch'
  | 'legacy_key_conflict'
  | 'legacy_key_tombstoned'
  | 'workspace_binding_mismatch';

export type TeamIdentityPrepareOutcome =
  | { readonly status: 'prepared'; readonly intent: TeamIdentityIntent }
  | { readonly status: 'already_prepared'; readonly intent: TeamIdentityIntent }
  | {
      readonly status: 'blocked';
      readonly reason: TeamIdentityMismatchReason;
      readonly conflictingTeamId?: TeamId;
    };

export interface TeamIdentityPublicationEvidence {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly checksum: TeamIdentityChecksum;
  readonly fileSchemaVersion: typeof TEAM_IDENTITY_SCHEMA_VERSION;
  readonly publishedAt: string;
  readonly fileFsync: 'synced';
  readonly parentDirectoryFsync: 'synced';
}

export type TeamIdentityPersistenceOutcome =
  | { readonly status: 'recorded' }
  | { readonly status: 'already_recorded' }
  | { readonly status: 'blocked'; readonly reason: TeamIdentityMismatchReason };

export interface TeamIdentityCommitRequest {
  readonly intent: TeamIdentityIntent;
  readonly publication: TeamIdentityPublicationEvidence;
}

export type TeamIdentityCommitOutcome =
  | {
      readonly status: 'committed';
      readonly teamId: TeamId;
      readonly checksum: TeamIdentityChecksum;
      readonly identityGeneration: number;
    }
  | {
      readonly status: 'already_committed';
      readonly teamId: TeamId;
      readonly checksum: TeamIdentityChecksum;
      readonly identityGeneration: number;
    }
  | { readonly status: 'blocked'; readonly reason: TeamIdentityMismatchReason };

export interface TeamIdentityTombstoneRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly expectedIdentityGeneration: number;
  readonly reason: 'delete_draft' | 'permanent_delete' | 'prepared_abort';
  readonly requestedAt: string;
}

export type TeamIdentityTombstoneOutcome =
  | {
      readonly status: 'tombstoned' | 'already_tombstoned';
      readonly durability: 'durable';
      readonly tombstoneGeneration: number;
    }
  | { readonly status: 'blocked'; readonly reason: TeamIdentityMismatchReason };

export interface TeamAttemptArtifactOwnershipKey {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly runId: string;
  readonly artifactRelativePath: string;
}

export type TeamAttemptArtifactOwnershipPersistenceOutcome =
  | { readonly status: 'recorded' | 'already_recorded'; readonly durability: 'durable' }
  | { readonly status: 'blocked'; readonly reason: TeamIdentityMismatchReason };

export type TeamAttemptArtifactOwnershipLookupOutcome =
  | { readonly status: 'found'; readonly ownership: TeamAttemptArtifactOwnership }
  | { readonly status: 'absent' }
  | { readonly status: 'blocked'; readonly reason: TeamIdentityMismatchReason };

export interface MarkerOwnedRootEvidence {
  readonly rootPath: string;
  readonly canonicalRootPath: string;
  readonly markerToken: string;
  readonly kind: 'project' | 'runtime';
}

/**
 * Admission evidence is deliberately value-only. Filesystem adapters revalidate every field and the
 * marker bytes before each effect; possessing this record alone is not authority.
 */
export interface TeamDirectoryRootAdmission {
  readonly projectRoot: MarkerOwnedRootEvidence;
  readonly runtimeRoot: MarkerOwnedRootEvidence;
  readonly teamsRootPath: string;
}

export type TeamIdentityAuthorityEvidence =
  | {
      readonly state: 'prepared';
      readonly teamId: TeamId;
      readonly expectedChecksum: TeamIdentityChecksum;
      readonly duplicateTeamIdCount: number;
    }
  | {
      readonly state: 'file_published';
      readonly teamId: TeamId;
      readonly expectedChecksum: TeamIdentityChecksum;
      readonly publication: TeamIdentityPublicationEvidence;
      readonly duplicateTeamIdCount: number;
    }
  | {
      readonly state: 'committed';
      readonly teamId: TeamId;
      readonly expectedChecksum: TeamIdentityChecksum;
      readonly identityGeneration: number;
      readonly duplicateTeamIdCount: number;
    }
  | {
      readonly state: 'tombstoned';
      readonly teamId: TeamId;
      readonly expectedChecksum?: TeamIdentityChecksum;
      readonly tombstoneGeneration: number;
      readonly duplicateTeamIdCount: number;
    };

export interface TeamIdentityAuthorityLookupRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
}

export type TeamIdentityAuthorityLookupOutcome =
  | {
      readonly status: 'found';
      readonly intent: TeamIdentityIntent;
      readonly authority: TeamIdentityAuthorityEvidence;
    }
  | { readonly status: 'blocked'; readonly reason: TeamIdentityMismatchReason };

/**
 * App-owned durable identity registry boundary. Implementations must return the persisted saga state
 * from `getAuthority`; request DTOs and previously returned values are never durable authority.
 * Serial integration supplies the accepted P2.B adapter without coupling this port to its storage
 * schema or worker protocol.
 */
export interface TeamIdentityPersistence {
  prepare(intent: TeamIdentityIntent): Promise<TeamIdentityPrepareOutcome>;
  getAuthority(
    request: TeamIdentityAuthorityLookupRequest
  ): Promise<TeamIdentityAuthorityLookupOutcome>;
  recordPublication(
    evidence: TeamIdentityPublicationEvidence
  ): Promise<TeamIdentityPersistenceOutcome>;
  commit(request: TeamIdentityCommitRequest): Promise<TeamIdentityCommitOutcome>;
  tombstone(request: TeamIdentityTombstoneRequest): Promise<TeamIdentityTombstoneOutcome>;
}

/** Durable registry written by the trusted attempt-creation workflow, never by cleanup callers. */
export interface TeamAttemptArtifactOwnershipRegistry {
  recordAttemptArtifactOwnership(
    ownership: TeamAttemptArtifactOwnership
  ): Promise<TeamAttemptArtifactOwnershipPersistenceOutcome>;
  getAttemptArtifactOwnership(
    key: TeamAttemptArtifactOwnershipKey
  ): Promise<TeamAttemptArtifactOwnershipLookupOutcome>;
}

export interface TeamIdentityPublishRequest {
  readonly legacyTeamKey: LegacyTeamKey;
  readonly identity: TeamIdentityFile;
  readonly authority: Extract<TeamIdentityAuthorityEvidence, { state: 'prepared' }>;
}

export type TeamIdentityBlockReason =
  | 'checksum_mismatch'
  | 'corrupt_identity'
  | 'duplicate_team_id'
  | 'durability_unsupported'
  | 'future_identity'
  | 'identity_mismatch'
  | 'identity_permissions_unsafe'
  | 'identity_tombstoned'
  | 'missing_after_commit'
  | 'missing_after_publication'
  | 'publish_failed_after_create'
  | 'root_not_admitted'
  | 'unsafe_team_directory';

export type TeamIdentityReadOutcome =
  | {
      readonly status: 'absent';
      readonly capability: 'read_only';
      readonly reason: 'awaiting_publication';
    }
  | {
      readonly status: 'valid';
      readonly capability: 'read_only' | 'read_write';
      readonly identity: TeamIdentityFile;
      readonly checksum: TeamIdentityChecksum;
    }
  | {
      readonly status: 'blocked';
      readonly capability: 'blocked';
      readonly reason: TeamIdentityBlockReason;
    };

export type TeamIdentityPublishOutcome =
  | {
      readonly status: 'published' | 'already_published';
      readonly evidence: TeamIdentityPublicationEvidence;
    }
  | {
      readonly status: 'blocked';
      readonly capability: 'blocked';
      readonly reason: TeamIdentityBlockReason;
    };

export interface TeamIdentityPublicationPort {
  inspect(
    legacyTeamKey: LegacyTeamKey,
    authority: TeamIdentityAuthorityEvidence
  ): Promise<TeamIdentityReadOutcome>;
  publish(request: TeamIdentityPublishRequest): Promise<TeamIdentityPublishOutcome>;
}

/**
 * Write-once provenance stored inside an attempt-owned directory before the attempt creates
 * removable children. Cleanup validates these exact durable bytes and never treats a caller's path
 * or run ID as ownership evidence.
 */
export interface TeamAttemptArtifactOwnership {
  readonly schemaVersion: 1;
  readonly scope: 'p2-d-provisioning-attempt';
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly runId: string;
  readonly artifactRelativePath: string;
  readonly createdAt: string;
}
