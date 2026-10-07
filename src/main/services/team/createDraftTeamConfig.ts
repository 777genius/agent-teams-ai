import { getTasksBasePath,getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { parseNumericSuffixName, validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import * as fs from 'fs';
import * as path from 'path';

import { TeamConfigReader } from './TeamConfigReader';
import { parseCreateTeamRequest } from './TeamRequestValidation';
import { applyDistinctRosterColors } from './teamRosterColors';

import type { TeamMembersMetaStore } from './TeamMembersMetaStore';
import type { TeamMetaStore } from './TeamMetaStore';
import type { TeamCreateConfigRequest } from '@shared/types';

export async function createDraftTeamConfig(
  request: TeamCreateConfigRequest,
  stores: { teamMetaStore: TeamMetaStore; membersMetaStore: TeamMembersMetaStore }
): Promise<void> {
  request = parseCreateTeamRequest(request);
  const teamsBasePath = getTeamsBasePath();
  const tasksBasePath = getTasksBasePath();
  const teamDir = path.join(teamsBasePath, request.teamName);
  const tasksDir = path.join(tasksBasePath, request.teamName);
  await Promise.all([
    fs.promises.mkdir(teamsBasePath, { recursive: true }),
    fs.promises.mkdir(tasksBasePath, { recursive: true }),
  ]);

  const pathExists = async (targetPath: string): Promise<boolean> => {
    try {
      await fs.promises.lstat(targetPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  if ((await pathExists(teamDir)) || (await pathExists(tasksDir))) {
    throw new Error(`Team already exists: ${request.teamName}`);
  }

  try {
    await fs.promises.mkdir(teamDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Team already exists: ${request.teamName}`);
    }
    throw error;
  }

  let tasksDirectoryCreated = false;
  try {
    await fs.promises.mkdir(tasksDir);
    tasksDirectoryCreated = true;
    await fs.promises.mkdir(path.join(teamDir, 'inboxes'));

    const joinedAt = Date.now();
    // Save team-level metadata to team.meta.json (NOT config.json).
    // config.json is CLI territory — created by TeamCreate during provisioning.
    // team.meta.json preserves user's configuration for the Launch flow.
    await stores.teamMetaStore.writeMeta(
      request.teamName,
      {
        runtimeSelectionVersion: request.runtimeSelectionVersion,
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
        syncModelsWithLead: request.syncModelsWithLead,
        skipPermissions: request.skipPermissions,
        worktree: request.worktree,
        extraCliArgs: request.extraCliArgs,
        limitContext: request.limitContext,
        createdAt: joinedAt,
      },
      teamsBasePath
    );

    const membersToWrite = applyDistinctRosterColors(
      request.members.map((member) => ({
        name: (() => {
          const name = member.name.trim();
          if (!name) throw new Error('Member name cannot be empty');
          const formatError = validateTeamMemberNameFormat(name);
          if (formatError) {
            throw new Error(`Member name "${name}" is invalid: ${formatError}`);
          }
          if (name.toLowerCase() === 'user') {
            throw new Error('Member name "user" is reserved');
          }
          if (name.toLowerCase() === 'team-lead')
            throw new Error('Member name "team-lead" is reserved');
          const suffixInfo = parseNumericSuffixName(name);
          if (suffixInfo && suffixInfo.suffix >= 2) {
            throw new Error(
              `Member name "${name}" is not allowed (reserved for runtime-managed numeric suffixes). Use "${suffixInfo.base}" instead.`
            );
          }
          return name;
        })(),
        role: member.role?.trim() || undefined,
        workflow: member.workflow?.trim() || undefined,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
        providerBackendId: member.providerBackendId,
        model: member.model?.trim() || undefined,
        effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
        fastMode: member.fastMode,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
        agentType: 'general-purpose' as const,
        joinedAt,
      }))
    );
    await stores.membersMetaStore.writeMembers(request.teamName, membersToWrite, {
      teamsBasePath,
      providerBackendId: request.providerBackendId,
    });
    TeamConfigReader.invalidateListTeamsCache();
  } catch (error) {
    if (tasksDirectoryCreated) {
      await fs.promises.rm(tasksDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.promises.rm(teamDir, { recursive: true, force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Team already exists: ${request.teamName}`);
    }
    throw error;
  }
}
