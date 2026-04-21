import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { TeamMember } from '@shared/types';

export interface TeamMembersMetaFile {
  version: 1;
  providerBackendId?: string;
  members: TeamMember[];
}

const MAX_META_FILE_BYTES = 256 * 1024;

function normalizeOptionalBackendId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMember(member: TeamMember): TeamMember | null {
  const trimmedName = member.name?.trim();
  if (!trimmedName) {
    return null;
  }
  return {
    name: trimmedName,
    role: typeof member.role === 'string' ? member.role.trim() || undefined : undefined,
    workflow: typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined,
    providerId: normalizeOptionalTeamProviderId(member.providerId),
    model: typeof member.model === 'string' ? member.model.trim() || undefined : undefined,
    effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
    agentType:
      typeof member.agentType === 'string' ? member.agentType.trim() || undefined : undefined,
    color: typeof member.color === 'string' ? member.color.trim() || undefined : undefined,
    joinedAt: typeof member.joinedAt === 'number' ? member.joinedAt : undefined,
    agentId: typeof member.agentId === 'string' ? member.agentId : undefined,
    removedAt: typeof member.removedAt === 'number' ? member.removedAt : undefined,
  };
}

export class TeamMembersMetaStore {
  private getMetaPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'members.meta.json');
  }

  async getMeta(teamName: string): Promise<TeamMembersMetaFile | null> {
    const metaPath = this.getMetaPath(teamName);
    try {
      const stat = await fs.promises.stat(metaPath);
      if (!stat.isFile()) {
        return null;
      }
      if (stat.isFile() && stat.size > MAX_META_FILE_BYTES) {
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

    const deduped = new Map<string, TeamMember>();
    for (const item of file.members) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const normalized = normalizeMember(item);
      if (!normalized) {
        continue;
      }
      deduped.set(normalized.name, normalized);
    }

    // Defense: drop CLI auto-suffixed duplicates (alice-2) when base name exists.
    const allNames = Array.from(deduped.keys());
    const keepName = createCliAutoSuffixNameGuard(allNames);
    for (const name of allNames) {
      if (!keepName(name)) {
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
    options?: { providerBackendId?: string }
  ): Promise<void> {
    const deduped = new Map<string, TeamMember>();
    for (const member of members) {
      const normalized = normalizeMember(member);
      if (!normalized) {
        continue;
      }
      deduped.set(normalized.name, normalized);
    }

    // Defense: drop CLI auto-suffixed duplicates (alice-2) when base name exists.
    const allNames = Array.from(deduped.keys());
    const keepName = createCliAutoSuffixNameGuard(allNames);
    for (const name of allNames) {
      if (!keepName(name)) {
        deduped.delete(name);
      }
    }

    const payload: TeamMembersMetaFile = {
      version: 1,
      providerBackendId: normalizeOptionalBackendId(options?.providerBackendId),
      members: Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name)),
    };

    await atomicWriteAsync(this.getMetaPath(teamName), JSON.stringify(payload, null, 2));
  }
}
