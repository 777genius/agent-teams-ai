import { stableJsonStringify } from '@features/application-command-ledger';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { isTeamProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeTeamMemberRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamMembersMetaStore } from './TeamMembersMetaStore';
import type { ReplaceMembersRequest, TeamMember } from '@shared/types';

const CONTROLLED_MEMBER_FIELDS = [
  'name',
  'role',
  'workflow',
  'isolation',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'runtimeSelectionProvenance',
  'fastMode',
  'mcpPolicy',
] as const;

const LAUNCH_RELEVANT_MEMBER_FIELDS = [
  ...CONTROLLED_MEMBER_FIELDS,
  'agentId',
  'agentType',
  'color',
  'joinedAt',
  'cwd',
  'removedAt',
] as const;

const OPTIONAL_STRING_FIELDS = [
  'agentId',
  'agentType',
  'role',
  'workflow',
  'model',
  'color',
  'cwd',
] as const;

function controlledProjection(member: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    CONTROLLED_MEMBER_FIELDS.flatMap((key) =>
      member[key] === undefined ? [] : [[key, member[key]] as const]
    )
  );
}

function isUnchangedRequest(
  existing: readonly TeamMember[],
  requested: ReplaceMembersRequest['members']
): boolean {
  const active = existing.filter((member) => member.removedAt == null && !isLeadMember(member));
  if (active.length !== requested.length) return false;
  const byName = new Map(active.map((member) => [member.name.toLowerCase(), member]));
  return requested.every((member) => {
    const current = byName.get(member.name.toLowerCase());
    return Boolean(
      current &&
      stableJsonStringify(controlledProjection(current as unknown as Record<string, unknown>)) ===
        stableJsonStringify(controlledProjection(member as unknown as Record<string, unknown>))
    );
  });
}

export function parseCanonicalRosterMembers(value: unknown): TeamMember[] | null {
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  const members: TeamMember[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim() || name !== name.trim()) return null;
    const normalizedName = name.trim().toLowerCase();
    if (names.has(normalizedName)) return null;
    names.add(normalizedName);
    members.push(entry as TeamMember);
  }
  return members;
}

function hasStrictMcpPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    !Object.keys(record).every((key) => key === 'mode' || key === 'scopes' || key === 'serverNames')
  ) {
    return false;
  }
  if (
    record.mode !== 'inheritLead' &&
    record.mode !== 'inheritScopes' &&
    record.mode !== 'strictAllowlist' &&
    record.mode !== 'appOnly'
  ) {
    return false;
  }
  if (record.scopes !== undefined) {
    if (!record.scopes || typeof record.scopes !== 'object' || Array.isArray(record.scopes)) {
      return false;
    }
    const scopes = record.scopes as Record<string, unknown>;
    if (
      !Object.keys(scopes).every((key) => key === 'user' || key === 'project' || key === 'local') ||
      !Object.values(scopes).every((entry) => typeof entry === 'boolean')
    ) {
      return false;
    }
  }
  if (
    record.serverNames !== undefined &&
    (!Array.isArray(record.serverNames) ||
      !record.serverNames.every((entry) => typeof entry === 'string'))
  ) {
    return false;
  }
  return stableJsonStringify(normalizeTeamMemberMcpPolicy(value)) === stableJsonStringify(value);
}

function isStrictV2Member(entry: unknown): entry is TeamMember {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const member = entry as Record<string, unknown>;
  if (
    typeof member.name !== 'string' ||
    !member.name.trim() ||
    member.name !== member.name.trim()
  ) {
    return false;
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (member[field] !== undefined && typeof member[field] !== 'string') return false;
  }
  if (member.isolation !== undefined && member.isolation !== 'worktree') return false;
  if (
    member.providerId !== undefined &&
    normalizeOptionalTeamProviderId(member.providerId) !== member.providerId
  ) {
    return false;
  }
  if (
    member.providerBackendId !== undefined &&
    (typeof member.providerBackendId !== 'string' ||
      !isTeamProviderBackendId(member.providerBackendId))
  ) {
    return false;
  }
  if (member.effort !== undefined && !isTeamEffortLevel(member.effort)) return false;
  if (
    member.runtimeSelectionProvenance !== undefined &&
    normalizeTeamMemberRuntimeSelectionProvenance(member.runtimeSelectionProvenance) === undefined
  ) {
    return false;
  }
  if (
    member.fastMode !== undefined &&
    member.fastMode !== 'inherit' &&
    member.fastMode !== 'on' &&
    member.fastMode !== 'off'
  ) {
    return false;
  }
  if (member.mcpPolicy !== undefined && !hasStrictMcpPolicy(member.mcpPolicy)) return false;
  if (
    member.joinedAt !== undefined &&
    (typeof member.joinedAt !== 'number' || !Number.isFinite(member.joinedAt))
  ) {
    return false;
  }
  if (
    member.removedAt !== undefined &&
    (typeof member.removedAt !== 'number' || !Number.isFinite(member.removedAt))
  ) {
    return false;
  }
  return true;
}

export function parseStrictCurrentRosterMembers(value: unknown): TeamMember[] | null {
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  const members: TeamMember[] = [];
  for (const entry of value) {
    if (!isStrictV2Member(entry)) return null;
    const normalizedName = entry.name.toLowerCase();
    if (names.has(normalizedName)) return null;
    names.add(normalizedName);
    members.push(entry);
  }
  return members;
}

function launchRelevantProjection(member: TeamMember): Record<string, unknown> {
  const record = member as unknown as Record<string, unknown>;
  return Object.fromEntries(
    LAUNCH_RELEVANT_MEMBER_FIELDS.flatMap((key) =>
      record[key] === undefined ? [] : [[key, record[key]] as const]
    )
  );
}

function rawRosterMatchesNormalizedMembers(
  rawMembers: readonly TeamMember[],
  existing: readonly TeamMember[]
): boolean {
  if (rawMembers.length !== existing.length) return false;
  const byName = new Map(
    existing.map((member) => [member.name.trim().toLowerCase(), launchRelevantProjection(member)])
  );
  if (byName.size !== existing.length) return false;
  return rawMembers.every((member) => {
    const normalized = byName.get(member.name.toLowerCase());
    return (
      normalized !== undefined &&
      stableJsonStringify(launchRelevantProjection(member)) === stableJsonStringify(normalized)
    );
  });
}

/** Preserve file/member fields not owned by roster editing, including tombstone metadata. */
export function buildCanonicalRosterAuthorizationRaw(input: {
  priorRaw: string | null;
  existing: readonly TeamMember[];
  requested: ReplaceMembersRequest['members'];
  replacement: readonly TeamMember[];
  serializeFallback: (members: TeamMember[], providerBackendId?: string) => string;
  normalizeRootBackend: (
    value: unknown,
    source: 'legacy-storage' | 'explicit-selection'
  ) => string | undefined;
}): string {
  if (input.priorRaw === null) return input.serializeFallback([...input.replacement]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.priorRaw) as unknown;
  } catch {
    return input.serializeFallback([...input.replacement]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return input.serializeFallback([...input.replacement]);
  }
  const file = parsed as Record<string, unknown>;
  if (!Array.isArray(file.members)) return input.serializeFallback([...input.replacement]);
  if (file.version !== undefined && file.version !== 1 && file.version !== 2) {
    throw new Error(`Unsupported members.meta.json version: ${String(file.version)}`);
  }
  const version = file.version === 2 ? 2 : 1;
  const rawMembers =
    version === 2
      ? parseStrictCurrentRosterMembers(file.members)
      : parseCanonicalRosterMembers(file.members);
  if (version === 2) {
    if (!rawMembers) throw new Error('Invalid current members.meta.json roster');
    if (
      file.providerBackendId !== undefined &&
      (typeof file.providerBackendId !== 'string' ||
        !isTeamProviderBackendId(file.providerBackendId))
    ) {
      throw new Error('Invalid current members.meta.json providerBackendId');
    }
    if (!rawRosterMatchesNormalizedMembers(rawMembers, input.existing)) {
      throw new Error('Current members.meta.json roster differs from its decoded projection');
    }
  }
  if (version === 2 && isUnchangedRequest(input.existing, input.requested)) {
    return input.priorRaw;
  }
  const providerBackendId = input.normalizeRootBackend(
    file.providerBackendId,
    version === 2 ? 'explicit-selection' : 'legacy-storage'
  );
  const rawByName = new Map<string, Record<string, unknown>>();
  for (const value of rawMembers ?? []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const rawMember = value as unknown as Record<string, unknown>;
    if (typeof rawMember.name === 'string') rawByName.set(rawMember.name.toLowerCase(), rawMember);
  }
  const members = input.replacement.map((member) => {
    const merged: Record<string, unknown> = {
      ...(rawByName.get(member.name.toLowerCase()) ?? {}),
    };
    for (const key of CONTROLLED_MEMBER_FIELDS) delete merged[key];
    delete merged.removedAt;
    for (const [key, value] of Object.entries(member)) {
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  });
  return JSON.stringify(
    {
      ...file,
      version: 2,
      providerBackendId,
      members,
    },
    null,
    2
  );
}

export function canonicalRosterRawFromStore(
  priorRaw: string | null,
  existing: readonly TeamMember[],
  requested: ReplaceMembersRequest['members'],
  replacement: readonly TeamMember[],
  store: TeamMembersMetaStore
): string {
  return buildCanonicalRosterAuthorizationRaw({
    priorRaw,
    existing,
    requested,
    replacement,
    serializeFallback: (members, providerBackendId) =>
      store.serializeMembers(members, { providerBackendId }),
    normalizeRootBackend: (value, source) => store.normalizeRootBackend(value, source),
  });
}
