import {
  parseTeamId,
  parseWorkspaceId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted/identifiers';

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

const TEAM_IDENTITY_RECORD_KEYS = Object.freeze([
  'teamId',
  'state',
  'legacyKey',
  'directoryFingerprint',
  'workspaceBinding',
  'adoptionIntentId',
  'identityChecksum',
  'createdAt',
  'activatedAt',
  'tombstonedAt',
] as const);

function parseIdentityTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError('team-identity-timestamp-invalid');
  }
  return value;
}

export function parseTeamIdentityRecord(value: unknown): TeamIdentityRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('team-identity-record-invalid');
  }
  const record = value as Record<PropertyKey, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== TEAM_IDENTITY_RECORD_KEYS.length ||
    keys.some((key) => typeof key !== 'string' || !TEAM_IDENTITY_RECORD_KEYS.includes(key as never))
  ) {
    throw new TypeError('team-identity-record-invalid');
  }
  const state = record.state;
  if (
    state !== 'reserved' &&
    state !== 'adoption_prepared' &&
    state !== 'file_published' &&
    state !== 'active' &&
    state !== 'tombstoned'
  ) {
    throw new TypeError('team-identity-state-unknown');
  }
  const workspaceValue = record.workspaceBinding;
  const workspaceBinding =
    workspaceValue === null
      ? null
      : (() => {
          if (typeof workspaceValue !== 'object' || Array.isArray(workspaceValue)) {
            throw new TypeError('team-identity-workspace-binding-invalid');
          }
          const candidate = workspaceValue as Record<PropertyKey, unknown>;
          if (
            Reflect.ownKeys(candidate).length !== 2 ||
            !Object.hasOwn(candidate, 'workspaceId') ||
            !Object.hasOwn(candidate, 'generation') ||
            !Number.isSafeInteger(candidate.generation) ||
            (candidate.generation as number) < 1
          ) {
            throw new TypeError('team-identity-workspace-binding-invalid');
          }
          return Object.freeze({
            workspaceId: parseWorkspaceId(candidate.workspaceId),
            generation: candidate.generation as number,
          });
        })();
  const identity: TeamIdentityRecord = Object.freeze({
    teamId: parseTeamId(record.teamId),
    state,
    legacyKey: parseLegacyTeamKey(record.legacyKey),
    directoryFingerprint: parseDirectoryFingerprint(record.directoryFingerprint),
    workspaceBinding,
    adoptionIntentId:
      record.adoptionIntentId === null ? null : parseTeamAdoptionIntentId(record.adoptionIntentId),
    identityChecksum:
      record.identityChecksum === null ? null : parseTeamIdentityChecksum(record.identityChecksum),
    createdAt: parseIdentityTimestamp(record.createdAt),
    activatedAt: record.activatedAt === null ? null : parseIdentityTimestamp(record.activatedAt),
    tombstonedAt: record.tombstonedAt === null ? null : parseIdentityTimestamp(record.tombstonedAt),
  });
  const stateFieldsValid =
    (identity.state === 'reserved' &&
      identity.adoptionIntentId === null &&
      identity.identityChecksum === null &&
      identity.activatedAt === null &&
      identity.tombstonedAt === null) ||
    (identity.state === 'adoption_prepared' &&
      identity.adoptionIntentId !== null &&
      identity.identityChecksum === null &&
      identity.activatedAt === null &&
      identity.tombstonedAt === null) ||
    (identity.state === 'file_published' &&
      identity.adoptionIntentId !== null &&
      identity.identityChecksum !== null &&
      identity.activatedAt === null &&
      identity.tombstonedAt === null) ||
    (identity.state === 'active' &&
      identity.adoptionIntentId !== null &&
      identity.identityChecksum !== null &&
      identity.activatedAt !== null &&
      identity.tombstonedAt === null) ||
    (identity.state === 'tombstoned' && identity.tombstonedAt !== null);
  if (!stateFieldsValid) throw new TypeError('team-identity-state-fields-invalid');
  return identity;
}

export const MAX_TEAM_IDENTITY_READ_RECORDS = 1_000;

/**
 * The hosted read composition receives identity only from the durable SQLite
 * component. Implementations must validate the complete persisted identity
 * graph before returning any value; there is deliberately no JSON or
 * directory-discovery implementation of this port.
 */
export interface TeamIdentityReadGateway {
  listTeamIdentities(): Promise<readonly TeamIdentityRecord[]>;
  getTeamIdentity(teamId: TeamId): Promise<TeamIdentityRecord | null>;
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
  ReadLimitExceeded: 'read_limit_exceeded',
  IllegalTransition: 'illegal_transition',
} as const;

export type TeamIdentityStorageErrorCode =
  (typeof TeamIdentityStorageErrorCode)[keyof typeof TeamIdentityStorageErrorCode];
