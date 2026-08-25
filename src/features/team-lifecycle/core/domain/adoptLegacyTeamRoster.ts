import {
  type LegacyMemberKey,
  parseLegacyMemberKey,
  parseTeamId,
  type TeamId,
} from '@shared/contracts/hosted';

import {
  assertNoCliAutoSuffixAmbiguity,
  compareLegacyMemberKeys,
  foldLegacyMemberKey,
  parseTeamRosterAdoptionFingerprint,
  type TeamRosterAdoptionFingerprint,
  type TeamRosterMemberState,
} from './TeamRoster';

import type { TeamProviderId } from '@shared/types';

export type LegacyTeamRosterEvidenceSourceKind = 'config' | 'members_meta';

export interface LegacyTeamRosterMemberEvidence {
  readonly source: LegacyTeamRosterEvidenceSourceKind;
  readonly sourceOrdinal: number;
  readonly legacyMemberKey: string;
  readonly state: TeamRosterMemberState;
  readonly providerId: TeamProviderId | null;
  readonly model: string | null;
  readonly role: string | null;
  readonly workflow: string | null;
  readonly isolation: 'worktree' | null;
}

export interface LegacyTeamRosterEvidence {
  readonly teamId: TeamId;
  readonly members: readonly LegacyTeamRosterMemberEvidence[];
}

export interface ReconciledLegacyTeamRosterMember {
  readonly legacyMemberKey: LegacyMemberKey;
  readonly state: TeamRosterMemberState;
  readonly providerId: TeamProviderId;
  readonly model: string | null;
  readonly role: string | null;
  readonly workflow: string | null;
  readonly isolation: 'worktree' | null;
}

export interface ReconciledLegacyTeamRoster {
  readonly teamId: TeamId;
  readonly adoptionFingerprint: TeamRosterAdoptionFingerprint;
  readonly members: readonly ReconciledLegacyTeamRosterMember[];
}

export class TeamRosterIdentityAmbiguityError extends TypeError {
  readonly code = 'roster_identity_ambiguous' as const;

  constructor(readonly detail: string) {
    super('team-roster-identity-ambiguous');
    this.name = 'TeamRosterIdentityAmbiguityError';
  }
}

const TEAM_PROVIDER_IDS = new Set<TeamProviderId>(['anthropic', 'codex', 'gemini', 'opencode']);

export function reconcileLegacyTeamRosterEvidence(input: {
  readonly evidence: LegacyTeamRosterEvidence;
  readonly sha256Hex: (value: string) => string;
}): ReconciledLegacyTeamRoster {
  const teamId = parseTeamId(input.evidence.teamId);
  if (!Array.isArray(input.evidence.members)) {
    throw new TypeError('team-roster-legacy-evidence-invalid');
  }

  const exactKeysBySource = new Map<LegacyTeamRosterEvidenceSourceKind, Set<string>>([
    ['config', new Set()],
    ['members_meta', new Set()],
  ]);
  const exactKeys = new Set<string>();
  const foldedToExact = new Map<string, string>();
  const grouped = new Map<string, LegacyTeamRosterMemberEvidence[]>();

  for (let index = 0; index < input.evidence.members.length; index += 1) {
    if (!Object.hasOwn(input.evidence.members, index)) {
      throw new TypeError('team-roster-legacy-evidence-sparse');
    }
    const candidate: unknown = input.evidence.members[index];
    const evidence = validateLegacyEvidenceMember(candidate);
    const key = parseLegacyMemberKey(evidence.legacyMemberKey);
    const sourceKeys = exactKeysBySource.get(evidence.source);
    if (!sourceKeys || sourceKeys.has(key)) {
      ambiguous('duplicate_key_within_source');
    }
    sourceKeys.add(key);
    const foldedKey = foldLegacyMemberKey(key);
    const foldedOwner = foldedToExact.get(foldedKey);
    if (foldedOwner !== undefined && foldedOwner !== key) {
      ambiguous('case_fold_collision');
    }
    foldedToExact.set(foldedKey, key);
    exactKeys.add(key);
    const rows = grouped.get(key) ?? [];
    rows.push(evidence);
    grouped.set(key, rows);
  }

  try {
    assertNoCliAutoSuffixAmbiguity([...exactKeys]);
  } catch {
    ambiguous('cli_auto_suffix_collision');
  }

  const members = [...grouped.entries()]
    .sort(([left], [right]) => compareLegacyMemberKeys(left, right))
    .map(([legacyMemberKey, evidenceRows]) =>
      reconcileMember(parseLegacyMemberKey(legacyMemberKey), evidenceRows)
    );
  const adoptionFingerprint = createTeamRosterAdoptionFingerprint(
    { teamId, members },
    input.sha256Hex
  );
  return Object.freeze({
    teamId,
    adoptionFingerprint,
    members: Object.freeze(members),
  });
}

export function createTeamRosterAdoptionFingerprint(
  input: {
    readonly teamId: TeamId;
    readonly members: readonly ReconciledLegacyTeamRosterMember[];
  },
  sha256Hex: (value: string) => string
): TeamRosterAdoptionFingerprint {
  const canonical = canonicalJson({
    members: input.members.map((member) => ({
      isolation: member.isolation,
      legacyMemberKey: member.legacyMemberKey,
      model: member.model,
      providerId: member.providerId,
      role: member.role,
      state: member.state,
      workflow: member.workflow,
    })),
    teamId: input.teamId,
  });
  return parseTeamRosterAdoptionFingerprint(`sha256:${sha256Hex(canonical)}`);
}

function validateLegacyEvidenceMember(value: unknown): LegacyTeamRosterMemberEvidence {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('team-roster-legacy-member-evidence-invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    (record.source !== 'config' && record.source !== 'members_meta') ||
    !Number.isSafeInteger(record.sourceOrdinal) ||
    (record.sourceOrdinal as number) < 0 ||
    typeof record.legacyMemberKey !== 'string' ||
    (record.state !== 'active' && record.state !== 'removed') ||
    (record.providerId !== null && !TEAM_PROVIDER_IDS.has(record.providerId as TeamProviderId)) ||
    (record.isolation !== null && record.isolation !== 'worktree')
  ) {
    throw new TypeError('team-roster-legacy-member-evidence-invalid');
  }
  validateNullableString(record.model, 512);
  validateNullableString(record.role, 4_096);
  validateNullableString(record.workflow, 131_072);
  return {
    source: record.source,
    sourceOrdinal: record.sourceOrdinal as number,
    legacyMemberKey: record.legacyMemberKey,
    state: record.state,
    providerId: record.providerId as TeamProviderId | null,
    model: record.model as string | null,
    role: record.role as string | null,
    workflow: record.workflow as string | null,
    isolation: record.isolation,
  };
}

function reconcileMember(
  legacyMemberKey: LegacyMemberKey,
  rows: readonly LegacyTeamRosterMemberEvidence[]
): ReconciledLegacyTeamRosterMember {
  if (rows.length < 1 || rows.length > 2) {
    ambiguous('duplicate_exact_identity');
  }
  const [first, second] = rows;
  if (!first) {
    ambiguous('missing_identity_evidence');
  }
  if (second?.source === first.source) {
    ambiguous('duplicate_key_within_source');
  }
  if (second && first.state !== second.state) {
    ambiguous('active_removed_conflict');
  }
  const providerId = reconcileProvider(first.providerId, second?.providerId);
  return Object.freeze({
    legacyMemberKey,
    state: first.state,
    providerId,
    model: reconcileNullableField(first.model, second?.model, 'model_conflict'),
    role: reconcileNullableField(first.role, second?.role, 'role_conflict'),
    workflow: reconcileNullableField(first.workflow, second?.workflow, 'workflow_conflict'),
    isolation: reconcileNullableField(first.isolation, second?.isolation, 'isolation_conflict'),
  });
}

function reconcileProvider(
  first: TeamProviderId | null,
  second: TeamProviderId | null | undefined
): TeamProviderId {
  if (first !== null && second !== undefined && second !== null && first !== second) {
    ambiguous('provider_conflict');
  }
  const providerId = first ?? second;
  if (providerId === null || providerId === undefined) {
    ambiguous('provider_missing');
  }
  return providerId;
}

function reconcileNullableField<T>(
  first: T | null,
  second: T | null | undefined,
  detail: string
): T | null {
  if (second === undefined || second === null) return first;
  if (first === null) return second;
  if (first !== second) ambiguous(detail);
  return first;
}

function validateNullableString(value: unknown, maximumLength: number): void {
  if (
    value !== null &&
    (typeof value !== 'string' || value.length === 0 || value.length > maximumLength)
  ) {
    throw new TypeError('team-roster-legacy-member-field-invalid');
  }
}

function ambiguous(detail: string): never {
  throw new TeamRosterIdentityAmbiguityError(detail);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('team-roster-fingerprint-number-invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareLegacyMemberKeys)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('team-roster-fingerprint-value-invalid');
}
