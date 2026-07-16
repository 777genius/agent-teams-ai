import type { TeamId, WorkspaceId } from '@shared/contracts/hosted/identifiers';

declare const teamIdentityStorageBrand: unique symbol;

export type LegacyTeamKey = string & {
  readonly [teamIdentityStorageBrand]: 'LegacyTeamKey';
};
export type DirectoryFingerprint = string & {
  readonly [teamIdentityStorageBrand]: 'DirectoryFingerprint';
};
export type TeamIdentityChecksum = string & {
  readonly [teamIdentityStorageBrand]: 'TeamIdentityChecksum';
};
export type TeamAdoptionIntentId = string & {
  readonly [teamIdentityStorageBrand]: 'TeamAdoptionIntentId';
};
export type TeamAdoptionIntentChecksum = string & {
  readonly [teamIdentityStorageBrand]: 'TeamAdoptionIntentChecksum';
};

const LEGACY_TEAM_KEY_MAX_LENGTH = 128;
const LEGACY_TEAM_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RESERVED_LEGACY_TEAM_KEYS = new Set([
  'aux',
  'con',
  'nul',
  'prn',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const ADOPTION_INTENT_ID = /^adoption_[0-9a-f]{32}$/;

/**
 * Legacy keys are exact direct-child compatibility keys, not display names or
 * filesystem paths. Callers may suggest a slug before this boundary, but this
 * parser never trims, folds case, or performs Unicode normalization.
 */
export function parseLegacyTeamKey(value: unknown): LegacyTeamKey {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > LEGACY_TEAM_KEY_MAX_LENGTH ||
    !LEGACY_TEAM_KEY_PATTERN.test(value) ||
    RESERVED_LEGACY_TEAM_KEYS.has(value)
  ) {
    throw new TypeError('team-identity-legacy-key-invalid');
  }
  return value as LegacyTeamKey;
}

export function parseDirectoryFingerprint(value: unknown): DirectoryFingerprint {
  if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) {
    throw new TypeError('team-identity-directory-fingerprint-invalid');
  }
  return value as DirectoryFingerprint;
}

export function parseTeamIdentityChecksum(value: unknown): TeamIdentityChecksum {
  if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) {
    throw new TypeError('team-identity-checksum-invalid');
  }
  return value as TeamIdentityChecksum;
}

export function parseTeamAdoptionIntentId(value: unknown): TeamAdoptionIntentId {
  if (typeof value !== 'string' || !ADOPTION_INTENT_ID.test(value)) {
    throw new TypeError('team-adoption-intent-id-invalid');
  }
  return value as TeamAdoptionIntentId;
}

export function parseTeamAdoptionIntentChecksum(value: unknown): TeamAdoptionIntentChecksum {
  if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) {
    throw new TypeError('team-adoption-intent-checksum-invalid');
  }
  return value as TeamAdoptionIntentChecksum;
}

export interface TeamWorkspaceBindingEvidence {
  workspaceId: WorkspaceId;
  generation: number;
}

export type TeamIdentityRecordState =
  | 'reserved'
  | 'adoption_prepared'
  | 'file_published'
  | 'active'
  | 'tombstoned';

export interface TeamIdentityRecord {
  teamId: TeamId;
  state: TeamIdentityRecordState;
  legacyKey: LegacyTeamKey;
  directoryFingerprint: DirectoryFingerprint;
  workspaceBinding: TeamWorkspaceBindingEvidence | null;
  adoptionIntentId: TeamAdoptionIntentId | null;
  identityChecksum: TeamIdentityChecksum | null;
  createdAt: string;
  activatedAt: string | null;
  tombstonedAt: string | null;
}

export type LegacyTeamKeyReservationState = 'active' | 'tombstoned';

export type LegacyTeamKeyTombstoneReason = 'draft_deleted' | 'team_deleted' | 'legacy_conflict';

export interface LegacyTeamKeyReservation {
  legacyKey: LegacyTeamKey;
  teamId: TeamId;
  state: LegacyTeamKeyReservationState;
  reservedAt: string;
  tombstonedAt: string | null;
  tombstoneReason: LegacyTeamKeyTombstoneReason | null;
}

export type TeamAdoptionIntentState = 'prepared' | 'file_published' | 'committed';

export interface TeamAdoptionIntent {
  intentId: TeamAdoptionIntentId;
  teamId: TeamId;
  state: TeamAdoptionIntentState;
  legacyKey: LegacyTeamKey;
  directoryFingerprint: DirectoryFingerprint;
  workspaceBinding: TeamWorkspaceBindingEvidence | null;
  expectedIdentityChecksum: TeamIdentityChecksum;
  intentChecksum: TeamAdoptionIntentChecksum;
  preparedAt: string;
  filePublishedAt: string | null;
  publishedIdentityChecksum: TeamIdentityChecksum | null;
  committedAt: string | null;
  committedIdentityChecksum: TeamIdentityChecksum | null;
}

export interface ReserveTeamIdentityInput {
  teamId: TeamId;
  legacyKey: LegacyTeamKey;
  directoryFingerprint: DirectoryFingerprint;
  workspaceBinding: TeamWorkspaceBindingEvidence | null;
  createdAt: string;
}

export interface PrepareTeamAdoptionInput {
  intentId: TeamAdoptionIntentId;
  teamId: TeamId;
  legacyKey: LegacyTeamKey;
  directoryFingerprint: DirectoryFingerprint;
  workspaceBinding: TeamWorkspaceBindingEvidence | null;
  expectedIdentityChecksum: TeamIdentityChecksum;
  preparedAt: string;
}

export interface CommitTeamAdoptionInput {
  intentId: TeamAdoptionIntentId;
  teamId: TeamId;
  intentChecksum: TeamAdoptionIntentChecksum;
  identityChecksum: TeamIdentityChecksum;
  committedAt: string;
}

export interface RecordTeamIdentityFilePublishedInput {
  intentId: TeamAdoptionIntentId;
  teamId: TeamId;
  intentChecksum: TeamAdoptionIntentChecksum;
  identityChecksum: TeamIdentityChecksum;
  filePublishedAt: string;
}

export interface TombstoneLegacyTeamKeyInput {
  teamId: TeamId;
  legacyKey: LegacyTeamKey;
  reason: LegacyTeamKeyTombstoneReason;
  tombstonedAt: string;
}

export interface TeamIdentityReservationResult {
  outcome: 'created' | 'already_reserved';
  identity: TeamIdentityRecord;
  reservation: LegacyTeamKeyReservation;
}

export interface TeamAdoptionPrepareResult {
  outcome: 'prepared' | 'already_prepared' | 'already_file_published' | 'already_committed';
  identity: TeamIdentityRecord;
  reservation: LegacyTeamKeyReservation;
  intent: TeamAdoptionIntent;
}

export interface TeamIdentityFilePublishedResult {
  outcome: 'file_published' | 'already_file_published' | 'already_committed';
  identity: TeamIdentityRecord;
  reservation: LegacyTeamKeyReservation;
  intent: TeamAdoptionIntent;
}

export interface TeamAdoptionCommitResult {
  outcome: 'committed' | 'already_committed';
  identity: TeamIdentityRecord;
  reservation: LegacyTeamKeyReservation;
  intent: TeamAdoptionIntent;
}

export interface LegacyTeamKeyTombstoneResult {
  outcome: 'tombstoned' | 'already_tombstoned';
  identity: TeamIdentityRecord;
  reservation: LegacyTeamKeyReservation;
}

export const TeamIdentityStorageErrorCode = {
  InvalidInput: 'invalid_input',
  UnknownSchema: 'unknown_schema',
  UnknownState: 'unknown_state',
  DuplicateIdentity: 'duplicate_identity',
  LegacyKeyConflict: 'legacy_key_conflict',
  LegacyKeyTombstoned: 'legacy_key_tombstoned',
  AdoptionIntentNotFound: 'adoption_intent_not_found',
  AdoptionIntentMismatch: 'adoption_intent_mismatch',
  ChecksumDisagreement: 'checksum_disagreement',
  TamperingDetected: 'tampering_detected',
  IllegalTransition: 'illegal_transition',
} as const;

export type TeamIdentityStorageErrorCode =
  (typeof TeamIdentityStorageErrorCode)[keyof typeof TeamIdentityStorageErrorCode];
