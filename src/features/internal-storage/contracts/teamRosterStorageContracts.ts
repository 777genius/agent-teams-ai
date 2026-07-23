import {
  parseLegacyMemberKey,
  parseMemberId,
  parseTeamId,
  type TeamId,
} from '@shared/contracts/hosted/identifiers';

import type { TeamProviderId } from '@shared/types';

export const TEAM_ROSTER_STORAGE_SCHEMA_VERSION = 1 as const;

export interface TeamRosterMemberRecord {
  ordinal: number;
  memberId: string;
  legacyMemberKey: string;
  memberRevision: number;
  state: 'active' | 'removed';
  providerId: TeamProviderId;
  model: string | null;
  role: string | null;
  workflow: string | null;
  isolation: 'worktree' | null;
}

export interface TeamRosterSnapshotRecord {
  schemaVersion: typeof TEAM_ROSTER_STORAGE_SCHEMA_VERSION;
  teamId: string;
  rosterGeneration: number;
  adoptionFingerprint: string;
  adoptedAt: string;
  members: TeamRosterMemberRecord[];
}

export type TeamRosterAdoptRecordResult =
  | { outcome: 'created'; roster: TeamRosterSnapshotRecord }
  | { outcome: 'existing'; roster: TeamRosterSnapshotRecord };

export interface TeamRosterStorageGateway {
  getTeamRoster(teamId: TeamId): Promise<TeamRosterSnapshotRecord | null>;
  adoptTeamRoster(record: TeamRosterSnapshotRecord): Promise<TeamRosterAdoptRecordResult>;
}

const TEAM_ROSTER_RECORD_KEYS = Object.freeze([
  'adoptedAt',
  'adoptionFingerprint',
  'members',
  'rosterGeneration',
  'schemaVersion',
  'teamId',
] as const);
const TEAM_ROSTER_MEMBER_RECORD_KEYS = Object.freeze([
  'isolation',
  'legacyMemberKey',
  'memberId',
  'memberRevision',
  'model',
  'ordinal',
  'providerId',
  'role',
  'state',
  'workflow',
] as const);
const TEAM_PROVIDER_IDS = new Set<TeamProviderId>(['anthropic', 'codex', 'gemini', 'opencode']);

export function parseTeamRosterSnapshotRecord(value: unknown): TeamRosterSnapshotRecord {
  const record = exactRecord(value, TEAM_ROSTER_RECORD_KEYS, 'team-roster-storage-record-invalid');
  if (record.schemaVersion !== TEAM_ROSTER_STORAGE_SCHEMA_VERSION) {
    throw new TypeError('team-roster-storage-schema-version-unsupported');
  }
  const teamId = parseTeamId(record.teamId);
  const rosterGeneration = positiveInteger(
    record.rosterGeneration,
    'team-roster-storage-generation-invalid'
  );
  if (
    typeof record.adoptionFingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record.adoptionFingerprint)
  ) {
    throw new TypeError('team-roster-storage-fingerprint-invalid');
  }
  const adoptedAt = canonicalTimestamp(record.adoptedAt);
  if (!Array.isArray(record.members)) {
    throw new TypeError('team-roster-storage-members-invalid');
  }

  const memberIds = new Set<string>();
  const exactKeys = new Set<string>();
  const foldedKeys = new Set<string>();
  let previousKey: string | null = null;
  const members = record.members.map((candidate, index) => {
    if (!Object.hasOwn(record.members as unknown[], index)) {
      throw new TypeError('team-roster-storage-members-sparse');
    }
    const member = exactRecord(
      candidate,
      TEAM_ROSTER_MEMBER_RECORD_KEYS,
      'team-roster-storage-member-invalid'
    );
    if (member.ordinal !== index) {
      throw new TypeError('team-roster-storage-member-order-invalid');
    }
    const memberId = parseMemberId(member.memberId);
    const legacyMemberKey = parseLegacyMemberKey(member.legacyMemberKey);
    const foldedKey = legacyMemberKey.toLowerCase();
    if (
      memberIds.has(memberId) ||
      exactKeys.has(legacyMemberKey) ||
      foldedKeys.has(foldedKey) ||
      (previousKey !== null && previousKey >= legacyMemberKey)
    ) {
      throw new TypeError('team-roster-storage-member-identity-ambiguous');
    }
    if (member.state !== 'active' && member.state !== 'removed') {
      throw new TypeError('team-roster-storage-member-state-invalid');
    }
    if (!TEAM_PROVIDER_IDS.has(member.providerId as TeamProviderId)) {
      throw new TypeError('team-roster-storage-member-provider-invalid');
    }
    if (member.isolation !== null && member.isolation !== 'worktree') {
      throw new TypeError('team-roster-storage-member-isolation-invalid');
    }
    const parsed = {
      ordinal: index,
      memberId,
      legacyMemberKey,
      memberRevision: positiveInteger(
        member.memberRevision,
        'team-roster-storage-member-revision-invalid'
      ),
      state: member.state,
      providerId: member.providerId as TeamProviderId,
      model: nullableBoundedString(member.model, 512, 'team-roster-storage-member-model-invalid'),
      role: nullableBoundedString(member.role, 4_096, 'team-roster-storage-member-role-invalid'),
      workflow: nullableBoundedString(
        member.workflow,
        131_072,
        'team-roster-storage-member-workflow-invalid'
      ),
      isolation: member.isolation,
    } satisfies TeamRosterMemberRecord;
    memberIds.add(memberId);
    exactKeys.add(legacyMemberKey);
    foldedKeys.add(foldedKey);
    previousKey = legacyMemberKey;
    return parsed;
  });
  assertNoAutoSuffixAmbiguity(members.map(({ legacyMemberKey }) => legacyMemberKey));
  return {
    schemaVersion: TEAM_ROSTER_STORAGE_SCHEMA_VERSION,
    teamId,
    rosterGeneration,
    adoptionFingerprint: record.adoptionFingerprint,
    adoptedAt,
    members,
  };
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  diagnostic: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(diagnostic);
  }
  const record = value as Record<PropertyKey, unknown>;
  const actualKeys = Reflect.ownKeys(record);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError(diagnostic);
  }
  return record;
}

function positiveInteger(value: unknown, diagnostic: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(diagnostic);
  return value as number;
}

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError('team-roster-storage-timestamp-invalid');
  }
  return value;
}

function nullableBoundedString(
  value: unknown,
  maximumLength: number,
  diagnostic: string
): string | null {
  if (
    value !== null &&
    (typeof value !== 'string' || value.length === 0 || value.length > maximumLength)
  ) {
    throw new TypeError(diagnostic);
  }
  return value;
}

function assertNoAutoSuffixAmbiguity(keys: readonly string[]): void {
  const folded = new Set(keys.map((key) => key.toLowerCase()));
  for (const key of keys) {
    const match = /^(.+)-(\d+)$/.exec(key);
    if (match?.[1] && Number(match[2]) >= 2 && folded.has(match[1].toLowerCase())) {
      throw new TypeError('team-roster-storage-member-auto-suffix-ambiguous');
    }
  }
}
