import { getMemberColorByName } from '@shared/constants/memberColors';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { parseNumericSuffixName, validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamFastMode,
  TeamMember,
  TeamProviderId,
} from '@shared/types';

interface DraftTeamMetadata {
  displayName?: string;
  description?: string;
  color?: string;
  cwd: string;
  prompt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  fastMode?: TeamFastMode;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
  limitContext?: boolean;
  createdAt: number;
}

interface DraftTeamMembersMetadata {
  providerBackendId?: string;
  members: TeamMember[];
}

interface DraftTeamMetaStorePort {
  getMeta(teamName: string): Promise<DraftTeamMetadata | null>;
  writeMeta(teamName: string, data: DraftTeamMetadata): Promise<void>;
}

interface DraftTeamMembersMetaStorePort {
  getMeta(teamName: string): Promise<DraftTeamMembersMetadata | null>;
  writeMembers(
    teamName: string,
    members: TeamMember[],
    options?: { providerBackendId?: string }
  ): Promise<void>;
}

interface DraftConfigurationFileSystemPort {
  join(root: string, teamName: string): string;
  lstat(targetPath: string): Promise<unknown>;
  mkdir(targetPath: string, options?: { recursive?: boolean }): Promise<unknown>;
  rm(targetPath: string, options: { recursive: true; force: true }): Promise<unknown>;
}

interface TeamDraftConfigurationRoots {
  teamsRoot: string;
  tasksRoot: string;
}

interface TeamDraftConfigurationPersistenceRepositoryDependencies {
  teamMetaStore: DraftTeamMetaStorePort;
  teamMembersMetaStore: DraftTeamMembersMetaStorePort;
  fileSystem: DraftConfigurationFileSystemPort;
  invalidateListTeamsCache(): void;
  now(): number;
}

function applyDistinctRosterColors<T extends { name: string; color?: string; removedAt?: number }>(
  members: readonly T[]
): T[] {
  const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });
  return members.map((member) => ({
    ...member,
    color: colorMap.get(member.name) ?? member.color ?? getMemberColorByName(member.name),
  }));
}

function normalizeMember(
  member: TeamCreateConfigRequest['members'][number],
  joinedAt: number
): TeamMember {
  const name = member.name.trim();
  if (!name) {
    throw new Error('Member name cannot be empty');
  }
  const formatError = validateTeamMemberNameFormat(name);
  if (formatError) {
    throw new Error(`Member name "${name}" is invalid: ${formatError}`);
  }
  if (name.toLowerCase() === 'user') {
    throw new Error('Member name "user" is reserved');
  }
  if (name.toLowerCase() === 'team-lead') {
    throw new Error('Member name "team-lead" is reserved');
  }
  const suffixInfo = parseNumericSuffixName(name);
  if (suffixInfo && suffixInfo.suffix >= 2) {
    throw new Error(
      `Member name "${name}" is not allowed (reserved for runtime-managed numeric suffixes). Use "${suffixInfo.base}" instead.`
    );
  }

  return {
    name,
    role: member.role?.trim() || undefined,
    workflow: member.workflow?.trim() || undefined,
    isolation: member.isolation === 'worktree' ? 'worktree' : undefined,
    providerId: normalizeOptionalTeamProviderId(member.providerId),
    providerBackendId: member.providerBackendId,
    model: member.model?.trim() || undefined,
    effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
    fastMode: member.fastMode,
    mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
    agentType: 'general-purpose',
    joinedAt,
  };
}

async function pathExists(
  fileSystem: DraftConfigurationFileSystemPort,
  targetPath: string
): Promise<boolean> {
  try {
    await fileSystem.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function teamAlreadyExistsError(teamName: string): Error {
  return new Error(`Team already exists: ${teamName}`);
}

export class TeamDraftConfigurationPersistenceRepository {
  constructor(
    private readonly dependencies: TeamDraftConfigurationPersistenceRepositoryDependencies
  ) {}

  async getSavedRequest(teamName: string): Promise<TeamCreateRequest | null> {
    const meta = await this.dependencies.teamMetaStore.getMeta(teamName);
    if (!meta) {
      return null;
    }

    const membersMeta = await this.dependencies.teamMembersMetaStore.getMeta(teamName);
    const members = membersMeta?.members ?? [];
    const resolvedProviderId = meta.providerId ?? 'anthropic';

    return {
      teamName,
      displayName: meta.displayName,
      description: meta.description,
      color: meta.color,
      cwd: meta.cwd,
      prompt: meta.prompt,
      providerId: resolvedProviderId,
      providerBackendId: migrateProviderBackendId(
        resolvedProviderId,
        meta.providerBackendId ?? membersMeta?.providerBackendId
      ),
      model: meta.model,
      effort: meta.effort as TeamCreateRequest['effort'],
      fastMode: meta.fastMode,
      skipPermissions: meta.skipPermissions,
      worktree: meta.worktree,
      extraCliArgs: meta.extraCliArgs,
      limitContext: meta.limitContext,
      members: members
        .filter((member) => !member.removedAt)
        .map((member) => ({
          name: member.name,
          role: member.role,
          workflow: member.workflow,
          isolation: member.isolation,
          cwd: member.cwd,
          providerId: member.providerId,
          providerBackendId: member.providerBackendId,
          model: member.model,
          effort: member.effort,
          fastMode: member.fastMode,
          mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
        })),
    };
  }

  async createTeamConfig(
    request: TeamCreateConfigRequest,
    roots: TeamDraftConfigurationRoots
  ): Promise<void> {
    const teamDir = this.dependencies.fileSystem.join(roots.teamsRoot, request.teamName);
    const tasksDir = this.dependencies.fileSystem.join(roots.tasksRoot, request.teamName);
    await Promise.all([
      this.dependencies.fileSystem.mkdir(roots.teamsRoot, { recursive: true }),
      this.dependencies.fileSystem.mkdir(roots.tasksRoot, { recursive: true }),
    ]);

    if (
      (await pathExists(this.dependencies.fileSystem, teamDir)) ||
      (await pathExists(this.dependencies.fileSystem, tasksDir))
    ) {
      throw teamAlreadyExistsError(request.teamName);
    }

    try {
      await this.dependencies.fileSystem.mkdir(teamDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw teamAlreadyExistsError(request.teamName);
      }
      throw error;
    }

    let tasksDirectoryCreated = false;
    try {
      await this.dependencies.fileSystem.mkdir(tasksDir);
      tasksDirectoryCreated = true;

      const joinedAt = this.dependencies.now();
      await this.dependencies.teamMetaStore.writeMeta(request.teamName, {
        displayName: request.displayName,
        description: request.description,
        color: request.color,
        cwd: request.cwd?.trim() || '',
        prompt: request.prompt,
        providerId: request.providerId,
        providerBackendId: request.providerBackendId,
        model: request.model,
        effort: request.effort,
        fastMode: request.fastMode,
        skipPermissions: request.skipPermissions,
        worktree: request.worktree,
        extraCliArgs: request.extraCliArgs,
        limitContext: request.limitContext,
        createdAt: joinedAt,
      });

      const membersToWrite = applyDistinctRosterColors(
        request.members.map((member) => normalizeMember(member, joinedAt))
      );
      await this.dependencies.teamMembersMetaStore.writeMembers(request.teamName, membersToWrite, {
        providerBackendId: request.providerBackendId,
      });
      this.dependencies.invalidateListTeamsCache();
    } catch (error) {
      if (tasksDirectoryCreated) {
        await this.dependencies.fileSystem
          .rm(tasksDir, { recursive: true, force: true })
          .catch(() => undefined);
      }
      await this.dependencies.fileSystem
        .rm(teamDir, { recursive: true, force: true })
        .catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw teamAlreadyExistsError(request.teamName);
      }
      throw error;
    }
  }
}
