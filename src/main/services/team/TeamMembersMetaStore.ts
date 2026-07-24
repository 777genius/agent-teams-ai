import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isTeamProviderBackendId, migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';

import type { TeamMember } from '@shared/types';

export interface TeamMembersMetaFile {
  version: 1;
  providerBackendId?: string;
  members: TeamMember[];
}

export type TeamMembersMetaUpdate = (
  members: readonly TeamMember[]
) => TeamMember[] | Promise<TeamMember[]>;

const MAX_META_FILE_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

const MEMBER_KNOWN_FIELDS = [
  'name',
  'role',
  'workflow',
  'isolation',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'mcpPolicy',
  'agentType',
  'color',
  'joinedAt',
  'agentId',
  'cwd',
  'removedAt',
] as const;

const MCP_POLICY_KNOWN_FIELDS = ['mode', 'scopes', 'serverNames'] as const;
const MCP_SCOPE_KNOWN_FIELDS = ['user', 'project', 'local'] as const;

interface ParsedMembersMeta {
  meta: TeamMembersMetaFile;
  raw: JsonRecord;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalSupportedProviderBackendId(value: unknown): boolean {
  return value === undefined || normalizeSupportedProviderBackendId(value) !== undefined;
}

function normalizeSupportedProviderBackendId(
  value: unknown
): TeamMember['providerBackendId'] | undefined {
  const normalized = normalizeOptionalBackendId(value);
  return normalized !== undefined && isTeamProviderBackendId(normalized) ? normalized : undefined;
}

function normalizeMemberProviderBackendId(
  providerId: TeamMember['providerId'],
  value: unknown
): TeamMember['providerBackendId'] | undefined {
  const normalized = normalizeSupportedProviderBackendId(value);
  if (value !== undefined && !normalized) return undefined;
  return providerId === undefined ? normalized : migrateProviderBackendId(providerId, normalized);
}

function isSupportedMcpPolicy(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  if (
    value.mode !== 'inheritLead' &&
    value.mode !== 'inheritScopes' &&
    value.mode !== 'strictAllowlist' &&
    value.mode !== 'appOnly'
  ) {
    return false;
  }
  if (value.scopes !== undefined) {
    if (!isJsonRecord(value.scopes)) return false;
    for (const scope of MCP_SCOPE_KNOWN_FIELDS) {
      if (value.scopes[scope] !== undefined && typeof value.scopes[scope] !== 'boolean') {
        return false;
      }
    }
  }
  return (
    value.serverNames === undefined ||
    (Array.isArray(value.serverNames) &&
      value.serverNames.every((serverName) => typeof serverName === 'string'))
  );
}

function isSupportedMember(value: unknown): value is JsonRecord {
  if (!isJsonRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    isOptionalString(value.role) &&
    isOptionalString(value.workflow) &&
    (value.isolation === undefined || value.isolation === 'worktree') &&
    (value.providerId === undefined ||
      normalizeOptionalTeamProviderId(value.providerId) !== undefined) &&
    (value.providerBackendId === undefined ||
      normalizeMemberProviderBackendId(
        normalizeOptionalTeamProviderId(value.providerId),
        value.providerBackendId
      ) !== undefined) &&
    isOptionalString(value.model) &&
    (value.effort === undefined || isTeamEffortLevel(value.effort)) &&
    (value.fastMode === undefined || normalizeFastMode(value.fastMode) !== undefined) &&
    (value.mcpPolicy === undefined || isSupportedMcpPolicy(value.mcpPolicy)) &&
    isOptionalString(value.agentType) &&
    isOptionalString(value.color) &&
    isOptionalFiniteNumber(value.joinedAt) &&
    isOptionalString(value.agentId) &&
    isOptionalString(value.cwd) &&
    isOptionalFiniteNumber(value.removedAt)
  );
}

function replaceKnownFields(
  existing: JsonRecord | null,
  replacement: JsonRecord,
  knownFields: readonly string[]
): JsonRecord {
  const merged = { ...(existing ?? {}) };
  for (const field of knownFields) {
    delete merged[field];
  }
  return Object.assign(merged, replacement);
}

function mergeMember(existing: JsonRecord | null, replacement: TeamMember): JsonRecord {
  const merged = replaceKnownFields(
    existing,
    replacement as unknown as JsonRecord,
    MEMBER_KNOWN_FIELDS
  );
  if (replacement.mcpPolicy) {
    const existingPolicy = isJsonRecord(existing?.mcpPolicy) ? existing.mcpPolicy : null;
    const mergedPolicy = replaceKnownFields(
      existingPolicy,
      replacement.mcpPolicy as unknown as JsonRecord,
      MCP_POLICY_KNOWN_FIELDS
    );
    if (replacement.mcpPolicy.scopes) {
      mergedPolicy.scopes = replaceKnownFields(
        isJsonRecord(existingPolicy?.scopes) ? existingPolicy.scopes : null,
        replacement.mcpPolicy.scopes as JsonRecord,
        MCP_SCOPE_KNOWN_FIELDS
      );
    }
    merged.mcpPolicy = mergedPolicy;
  }
  return merged;
}

function buildMembersPayload(
  existing: JsonRecord | null,
  members: readonly TeamMember[],
  providerBackendId?: string
): JsonRecord {
  const normalizedMembers = normalizeMembers(members);
  const existingMembersByName = new Map<string, JsonRecord>();
  if (Array.isArray(existing?.members)) {
    for (const item of existing.members) {
      if (!isJsonRecord(item) || typeof item.name !== 'string') {
        continue;
      }
      const name = item.name.trim();
      if (name) {
        existingMembersByName.set(name, item);
      }
    }
  }

  return replaceKnownFields(
    existing,
    {
      version: 1,
      ...(providerBackendId ? { providerBackendId } : {}),
      members: normalizedMembers.map((member) =>
        mergeMember(existingMembersByName.get(member.name) ?? null, member)
      ),
    },
    ['version', 'providerBackendId', 'members']
  );
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
    providerBackendId: normalizeMemberProviderBackendId(providerId, member.providerBackendId),
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

function normalizeMembers(members: readonly TeamMember[]): TeamMember[] {
  const deduped = new Map<string, TeamMember>();
  for (const member of members) {
    const normalized = normalizeMember(member);
    if (!normalized) {
      continue;
    }
    deduped.set(normalized.name, normalized);
  }
  return Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function projectMembers(members: readonly TeamMember[]): TeamMember[] {
  const membersByName = new Map(members.map((member) => [member.name, member]));

  // Defense: hide CLI auto-suffixed duplicates (alice-2) only when the base
  // name is still active. The raw rows remain persisted until the explicit
  // provisioning cleanup boundary can remove and log them.
  const keepName = buildActiveNameGuard(membersByName);
  return members.filter((member) => keepName(member.name));
}

export class TeamMembersMetaStore {
  private getMetaPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'members.meta.json');
  }

  async getMeta(teamName: string): Promise<TeamMembersMetaFile | null> {
    const metaPath = this.getMetaPath(teamName);
    const document = await this.readMeta(metaPath);
    return document ? { ...document.meta, members: projectMembers(document.meta.members) } : null;
  }

  private async readMeta(
    metaPath: string,
    options: { failClosed?: boolean } = {}
  ): Promise<ParsedMembersMeta | null> {
    try {
      const stat = await fs.promises.stat(metaPath);
      if (!stat.isFile()) {
        if (options.failClosed) {
          throw new Error('Refusing to replace unsafe members metadata');
        }
        return null;
      }
      if (stat.isFile() && stat.size > MAX_META_FILE_BYTES) {
        if (options.failClosed) {
          throw new Error('Refusing to replace oversized members metadata');
        }
        return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    let raw: string;
    try {
      raw = await readFileUtf8WithTimeout(metaPath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      if (error instanceof FileReadTimeoutError) {
        if (options.failClosed) {
          throw error;
        }
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      if (options.failClosed) {
        throw new Error('Refusing to replace malformed members metadata', { cause: error });
      }
      return null;
    }
    if (!isJsonRecord(parsed)) {
      if (options.failClosed) {
        throw new Error('Refusing to replace malformed members metadata');
      }
      return null;
    }

    const file = parsed as Partial<TeamMembersMetaFile>;
    if (file.version !== 1 || !Array.isArray(file.members)) {
      if (options.failClosed) {
        throw new Error('Refusing to replace unsupported members metadata');
      }
      return null;
    }
    if (options.failClosed) {
      if (!isOptionalSupportedProviderBackendId(file.providerBackendId)) {
        throw new Error('Refusing to replace malformed members metadata');
      }
      const memberNames = new Set<string>();
      for (const item of file.members) {
        if (!isSupportedMember(item)) {
          throw new Error('Refusing to replace malformed members metadata');
        }
        const name = item.name.trim();
        if (memberNames.has(name)) {
          throw new Error('Refusing to replace ambiguous members metadata');
        }
        memberNames.add(name);
      }
    }

    return {
      meta: {
        version: 1,
        providerBackendId: normalizeOptionalBackendId(file.providerBackendId),
        members: normalizeMembers(file.members.filter((item) => item && typeof item === 'object')),
      },
      raw: parsed,
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
    const metaPath = this.getMetaPath(teamName);
    await withFileLock(metaPath, () => this.writeMembersUnlocked(metaPath, members, options));
  }

  async updateMembers(
    teamName: string,
    update: TeamMembersMetaUpdate,
    options?: { providerBackendId?: string }
  ): Promise<void> {
    const metaPath = this.getMetaPath(teamName);
    await withFileLock(metaPath, async () => {
      const currentDocument = await this.readMeta(metaPath, { failClosed: true });
      const providerBackendId =
        options?.providerBackendId === undefined
          ? currentDocument?.meta.providerBackendId
          : normalizeOptionalBackendId(options.providerBackendId);
      const updatedMembers = await update(currentDocument?.meta.members ?? []);
      await this.writeMembersUnlocked(
        metaPath,
        updatedMembers,
        { providerBackendId },
        currentDocument?.raw
      );
    });
  }

  private async writeMembersUnlocked(
    metaPath: string,
    members: readonly TeamMember[],
    options?: { providerBackendId?: string },
    currentRaw?: JsonRecord
  ): Promise<void> {
    if (
      !isOptionalSupportedProviderBackendId(options?.providerBackendId) ||
      members.some(
        (member) =>
          member.providerBackendId !== undefined &&
          normalizeMemberProviderBackendId(
            normalizeOptionalTeamProviderId(member.providerId),
            member.providerBackendId
          ) === undefined
      )
    ) {
      throw new Error('Refusing to persist unsupported members provider backend');
    }
    const existing =
      currentRaw ?? (await this.readMeta(metaPath, { failClosed: true }))?.raw ?? null;
    const payload = buildMembersPayload(
      existing,
      members,
      normalizeOptionalBackendId(options?.providerBackendId)
    );
    await atomicWriteAsync(metaPath, JSON.stringify(payload, null, 2));
  }
}
