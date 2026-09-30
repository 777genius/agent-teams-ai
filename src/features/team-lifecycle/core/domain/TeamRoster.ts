import {
  type LegacyMemberKey,
  type MemberId,
  parseLegacyMemberKey,
  parseMemberId,
  parseTeamId,
  type TeamId,
} from '@shared/contracts/hosted';

import type { TeamProviderId } from '@shared/types';

declare const teamRosterBrand: unique symbol;

export type TeamRosterAdoptionFingerprint = `sha256:${string}` & {
  readonly [teamRosterBrand]: 'TeamRosterAdoptionFingerprint';
};

export const TEAM_ROSTER_SCHEMA_VERSION = 1 as const;

export type TeamRosterMemberState = 'active' | 'removed';

export interface TeamRosterMember {
  readonly memberId: MemberId;
  readonly legacyMemberKey: LegacyMemberKey;
  readonly memberRevision: number;
  readonly state: TeamRosterMemberState;
  readonly providerId: TeamProviderId;
  readonly model: string | null;
  readonly role: string | null;
  readonly workflow: string | null;
  readonly isolation: 'worktree' | null;
}

export interface TeamRoster {
  readonly schemaVersion: typeof TEAM_ROSTER_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly rosterGeneration: number;
  readonly adoptionFingerprint: TeamRosterAdoptionFingerprint;
  readonly adoptedAt: string;
  readonly members: readonly TeamRosterMember[];
}

const TEAM_PROVIDER_IDS = Object.freeze([
  'anthropic',
  'codex',
  'gemini',
  'opencode',
] as const satisfies readonly TeamProviderId[]);
const TEAM_ROSTER_KEYS = Object.freeze([
  'adoptedAt',
  'adoptionFingerprint',
  'members',
  'rosterGeneration',
  'schemaVersion',
  'teamId',
] as const);
const TEAM_ROSTER_MEMBER_KEYS = Object.freeze([
  'isolation',
  'legacyMemberKey',
  'memberId',
  'memberRevision',
  'model',
  'providerId',
  'role',
  'state',
  'workflow',
] as const);
const ADOPTION_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function parseTeamRosterAdoptionFingerprint(value: unknown): TeamRosterAdoptionFingerprint {
  if (typeof value !== 'string' || !ADOPTION_FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError('team-roster-adoption-fingerprint-invalid');
  }
  return value as TeamRosterAdoptionFingerprint;
}

export function parseTeamRoster(value: unknown): TeamRoster {
  const record = parseExactRecord(value, TEAM_ROSTER_KEYS, 'team-roster-record-invalid');
  if (record.schemaVersion !== TEAM_ROSTER_SCHEMA_VERSION) {
    throw new TypeError('team-roster-schema-version-unsupported');
  }
  const teamId = parseTeamId(record.teamId);
  const rosterGeneration = parsePositiveInteger(
    record.rosterGeneration,
    'team-roster-generation-invalid'
  );
  const adoptedAt = parseCanonicalTimestamp(record.adoptedAt);
  if (!Array.isArray(record.members)) {
    throw new TypeError('team-roster-members-invalid');
  }

  const memberIds = new Set<string>();
  const legacyKeys = new Set<string>();
  const foldedLegacyKeys = new Set<string>();
  let previousLegacyKey: string | null = null;
  const members = record.members.map((candidate, index) => {
    if (!Object.hasOwn(record.members as unknown[], index)) {
      throw new TypeError('team-roster-members-sparse');
    }
    const memberRecord = parseExactRecord(
      candidate,
      TEAM_ROSTER_MEMBER_KEYS,
      'team-roster-member-invalid'
    );
    const memberId = parseMemberId(memberRecord.memberId);
    const legacyMemberKey = parseLegacyMemberKey(memberRecord.legacyMemberKey);
    const foldedLegacyKey = foldLegacyMemberKey(legacyMemberKey);
    if (
      memberIds.has(memberId) ||
      legacyKeys.has(legacyMemberKey) ||
      foldedLegacyKeys.has(foldedLegacyKey)
    ) {
      throw new TypeError('team-roster-member-identity-ambiguous');
    }
    if (
      previousLegacyKey !== null &&
      compareLegacyMemberKeys(previousLegacyKey, legacyMemberKey) >= 0
    ) {
      throw new TypeError('team-roster-member-order-invalid');
    }
    if (memberRecord.state !== 'active' && memberRecord.state !== 'removed') {
      throw new TypeError('team-roster-member-state-invalid');
    }
    if (!(TEAM_PROVIDER_IDS as readonly unknown[]).includes(memberRecord.providerId)) {
      throw new TypeError('team-roster-member-provider-invalid');
    }

    const member = Object.freeze({
      memberId,
      legacyMemberKey,
      memberRevision: parsePositiveInteger(
        memberRecord.memberRevision,
        'team-roster-member-revision-invalid'
      ),
      state: memberRecord.state,
      providerId: memberRecord.providerId as TeamProviderId,
      model: parseNullableBoundedString(
        memberRecord.model,
        512,
        'team-roster-member-model-invalid'
      ),
      role: parseNullableBoundedString(memberRecord.role, 4_096, 'team-roster-member-role-invalid'),
      workflow: parseNullableBoundedString(
        memberRecord.workflow,
        131_072,
        'team-roster-member-workflow-invalid'
      ),
      isolation: parseIsolation(memberRecord.isolation),
    });
    memberIds.add(memberId);
    legacyKeys.add(legacyMemberKey);
    foldedLegacyKeys.add(foldedLegacyKey);
    previousLegacyKey = legacyMemberKey;
    return member;
  });

  assertNoCliAutoSuffixAmbiguity(members.map((member) => member.legacyMemberKey));
  return Object.freeze({
    schemaVersion: TEAM_ROSTER_SCHEMA_VERSION,
    teamId,
    rosterGeneration,
    adoptionFingerprint: parseTeamRosterAdoptionFingerprint(record.adoptionFingerprint),
    adoptedAt,
    members: Object.freeze(members),
  });
}

export function compareLegacyMemberKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function foldLegacyMemberKey(value: string): string {
  return value.toLowerCase();
}

export function assertNoCliAutoSuffixAmbiguity(keys: readonly string[]): void {
  const foldedKeys = new Set(keys.map(foldLegacyMemberKey));
  for (const key of keys) {
    const match = /^(.+)-(\d+)$/.exec(key);
    if (match?.[1] && Number(match[2]) >= 2 && foldedKeys.has(foldLegacyMemberKey(match[1]))) {
      throw new TypeError('team-roster-member-auto-suffix-ambiguous');
    }
  }
}

function parseExactRecord(
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

function parsePositiveInteger(value: unknown, diagnostic: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(diagnostic);
  }
  return value as number;
}

function parseCanonicalTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError('team-roster-timestamp-invalid');
  }
  return value;
}

function parseNullableBoundedString(
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

function parseIsolation(value: unknown): 'worktree' | null {
  if (value !== null && value !== 'worktree') {
    throw new TypeError('team-roster-member-isolation-invalid');
  }
  return value;
}
