import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import {
  normalizeTeamMemberMcpPolicy,
  normalizeTeamMemberMcpScopes,
  normalizeTeamMemberMcpServerNames,
  TEAM_MEMBER_MCP_SCOPES,
} from '@shared/utils/teamMemberMcpPolicy';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { hasCompleteKnownMetadata } from './TeamMetadataReadFidelity';
import { MAX_TEAM_METADATA_BYTES, serializeTeamMetadata } from './TeamMetadataSerialization';

import type { TeamMember } from '@shared/types';

export interface TeamMembersMetaFile {
  version: 1;
  providerBackendId?: string;
  members: TeamMember[];
}

function normalizeOptionalBackendId(value: unknown): string | undefined {
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
  const trimmedName = typeof member.name === 'string' ? member.name.trim() : undefined;
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

/** Strict replacement reads reject malformed known values, while retaining canonical defaults. */
function hasCompleteMcpPolicy(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.mode !== 'inheritLead' && !normalizeTeamMemberMcpPolicy({ mode: input.mode }))
    return false;
  if (input.scopes != null) {
    if (typeof input.scopes !== 'object' || Array.isArray(input.scopes)) return false;
    const scopes = input.scopes as Record<string, unknown>;
    const normalized = normalizeTeamMemberMcpScopes(scopes);
    if (
      TEAM_MEMBER_MCP_SCOPES.some(
        (scope) => scopes[scope] != null && scopes[scope] !== normalized?.[scope]
      )
    )
      return false;
  }
  if (input.serverNames != null) {
    if (!Array.isArray(input.serverNames)) return false;
    const names = new Set<string>();
    for (const name of input.serverNames) {
      if (typeof name !== 'string' || name.trim().length > 128) return false;
      if (name.trim()) names.add(name.trim().toLowerCase());
    }
    if (names.size !== (normalizeTeamMemberMcpServerNames(input.serverNames)?.length ?? 0))
      return false;
  }
  return true;
}

function hasCompleteKnownMemberFields(member: TeamMember, normalized: TeamMember): boolean {
  return (
    hasCompleteKnownMetadata({ ...member, mcpPolicy: undefined }, normalized) &&
    hasCompleteMcpPolicy(member.mcpPolicy)
  );
}

function buildActiveNameGuard(membersByName: Map<string, TeamMember>): (name: string) => boolean {
  const activeNames = Array.from(membersByName.values())
    .filter((member) => !member.removedAt)
    .map((member) => member.name);
  return createCliAutoSuffixNameGuard(activeNames);
}

export class TeamMembersMetaStore {
  private getMetaPath(teamName: string, teamsBasePath = getTeamsBasePath()): string {
    return path.join(teamsBasePath, teamName, 'members.meta.json');
  }

  /**
   * Management replacement requires every recognized member value to survive
   * canonical read. `allowCliAutoSuffixArtifacts` lets a caller that projects
   * the roster (rather than replaces it) receive a strict read in which the
   * known CLI auto-suffix duplicates are dropped instead of failing the whole
   * file; every other strictness rule still applies unchanged.
   */
  async getMeta(
    teamName: string,
    options?: { requireCompleteMembers?: boolean; allowCliAutoSuffixArtifacts?: boolean },
    teamsBasePath = getTeamsBasePath()
  ): Promise<TeamMembersMetaFile | null> {
    const metaPath = this.getMetaPath(teamName, teamsBasePath);
    try {
      const stat = await fs.promises.stat(metaPath);
      if (!stat.isFile()) {
        return null;
      }
      if (stat.isFile() && stat.size > MAX_TEAM_METADATA_BYTES) {
        return null;
      }
    } catch {
      // ignore - readFile below will handle ENOENT and throw on other errors
    }
    let raw: string;
    try {
      raw = await readFileUtf8WithTimeout(metaPath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      if (error instanceof FileReadTimeoutError) {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const file = parsed as Partial<TeamMembersMetaFile>;
    if (!Array.isArray(file.members)) {
      return null;
    }
    if (
      options?.requireCompleteMembers &&
      ((file.version != null && file.version !== 1) ||
        (file.providerBackendId != null && typeof file.providerBackendId !== 'string'))
    )
      return null;

    const deduped = new Map<string, TeamMember>();
    const identities = options?.requireCompleteMembers ? new Set<string>() : undefined;
    for (const item of file.members) {
      if (!item || typeof item !== 'object') {
        if (options?.requireCompleteMembers) return null;
        continue;
      }
      const normalized = normalizeMember(item);
      if (!normalized) {
        if (options?.requireCompleteMembers) return null;
        continue;
      }
      if (options?.requireCompleteMembers && !hasCompleteKnownMemberFields(item, normalized))
        return null;
      const identity = normalized.name.toLowerCase();
      if (identities?.has(identity)) return null;
      identities?.add(identity);
      deduped.set(normalized.name, normalized);
    }

    // Defense: drop CLI auto-suffixed duplicates (alice-2) only when the base
    // name is still active. Removed base members must not hide active suffixed
    // teammates after live mutation / rollback flows.
    const allNames = Array.from(deduped.keys());
    const keepName = buildActiveNameGuard(deduped);
    for (const name of allNames) {
      if (!keepName(name)) {
        // A generated auto-suffix duplicate is a known artifact, not
        // corruption. Strict readers fail closed on it unless they explicitly
        // opt into dropping it, so a replacement can never silently lose a
        // member while a projection can still remove the artifact itself.
        if (options?.requireCompleteMembers && !options?.allowCliAutoSuffixArtifacts) return null;
        deduped.delete(name);
      }
    }

    return {
      version: 1,
      providerBackendId: normalizeOptionalBackendId(file.providerBackendId),
      members: Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async getMembers(teamName: string): Promise<TeamMember[]> {
    return (await this.getMeta(teamName))?.members ?? [];
  }

  async writeMembers(
    teamName: string,
    members: TeamMember[],
    options?: { providerBackendId?: string; teamsBasePath?: string }
  ): Promise<void> {
    await atomicWriteAsync(
      path.join(options?.teamsBasePath ?? getTeamsBasePath(), teamName, 'members.meta.json'),
      this.serializeMembers(members, options)
    );
  }

  serializeMembers(members: TeamMember[], options?: { providerBackendId?: string }): string {
    const deduped = new Map<string, TeamMember>();
    for (const member of members) {
      const normalized = normalizeMember(member);
      if (!normalized) {
        continue;
      }
      deduped.set(normalized.name, normalized);
    }

    // Defense: drop CLI auto-suffixed duplicates (alice-2) only when the base
    // name is still active. Removed base members must not hide active suffixed
    // teammates after live mutation / rollback flows.
    const allNames = Array.from(deduped.keys());
    const keepName = buildActiveNameGuard(deduped);
    for (const name of allNames) {
      if (!keepName(name)) {
        deduped.delete(name);
      }
    }

    return serializeTeamMetadata({
      version: 1,
      providerBackendId: normalizeOptionalBackendId(options?.providerBackendId),
      members: Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name)),
    } satisfies TeamMembersMetaFile);
  }
}
