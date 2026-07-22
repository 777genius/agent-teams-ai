import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamMembersMetaFile } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamMember } from '@shared/types';

export function cloneFixture<T>(value: T): T {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneFixture(item)) as T;
  }
  if (value instanceof Map) {
    return new Map(
      Array.from(value.entries(), ([key, child]) => [cloneFixture(key), cloneFixture(child)])
    ) as T;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value.values(), (item) => cloneFixture(item))) as T;
  }

  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    clone[key] = cloneFixture(child);
  }
  return clone as T;
}

export function toIsoString(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid harness clock value: ${String(isoOrDate)}`);
  }
  return date.toISOString();
}

export function normalizeTeamMeta(
  meta: TeamMetaFile | Omit<TeamMetaFile, 'version'>
): TeamMetaFile {
  return {
    version: 1,
    ...meta,
  };
}

export function normalizeOptionalBackendId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeFastMode(value: unknown): TeamMember['fastMode'] {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : undefined;
}

function normalizeMember(member: TeamMember): TeamMember | null {
  const trimmedName = member.name?.trim();
  if (!trimmedName) {
    return null;
  }

  const providerId = normalizeOptionalTeamProviderId(member.providerId);
  return {
    name: trimmedName,
    role: typeof member.role === 'string' ? member.role.trim() || undefined : undefined,
    workflow: typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined,
    isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
    providerId,
    providerBackendId: migrateProviderBackendId(
      providerId,
      normalizeOptionalBackendId(member.providerBackendId)
    ),
    model: typeof member.model === 'string' ? member.model.trim() || undefined : undefined,
    effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
    fastMode: normalizeFastMode(member.fastMode),
    mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
    agentType:
      typeof member.agentType === 'string' ? member.agentType.trim() || undefined : undefined,
    color: typeof member.color === 'string' ? member.color.trim() || undefined : undefined,
    joinedAt: typeof member.joinedAt === 'number' ? member.joinedAt : undefined,
    agentId: typeof member.agentId === 'string' ? member.agentId : undefined,
    cwd: typeof member.cwd === 'string' ? member.cwd.trim() || undefined : undefined,
    removedAt: typeof member.removedAt === 'number' ? member.removedAt : undefined,
  };
}

function buildActiveNameGuard(membersByName: Map<string, TeamMember>): (name: string) => boolean {
  const activeNames = Array.from(membersByName.values())
    .filter((member) => !member.removedAt)
    .map((member) => member.name);
  return createCliAutoSuffixNameGuard(activeNames);
}

export function normalizeMembers(members: readonly TeamMember[]): TeamMember[] {
  const deduped = new Map<string, TeamMember>();
  for (const member of members) {
    const normalized = normalizeMember(member);
    if (!normalized) {
      continue;
    }
    deduped.set(normalized.name, normalized);
  }

  const allNames = Array.from(deduped.keys());
  const keepName = buildActiveNameGuard(deduped);
  for (const name of allNames) {
    if (!keepName(name)) {
      deduped.delete(name);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeMembersMetaFile(meta: TeamMembersMetaFile): TeamMembersMetaFile {
  return {
    version: 1,
    providerBackendId: normalizeOptionalBackendId(meta.providerBackendId),
    members: normalizeMembers(meta.members),
  };
}
