import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import * as path from 'path';

import { TeamConfigReader } from '../TeamConfigReader';

import type { TeamConfig, TeamCreateRequest } from '@shared/types';

export interface WriteOpenCodeTeamConfigPorts {
  getTeamsBasePath(): string;
  writeFileAtomic(filePath: string, contents: string): Promise<void>;
  invalidateTeam(teamName: string): void;
}

const defaultWriteOpenCodeTeamConfigPorts: WriteOpenCodeTeamConfigPorts = {
  getTeamsBasePath,
  writeFileAtomic: (filePath, contents) => atomicWriteAsync(filePath, contents),
  invalidateTeam: (teamName) => TeamConfigReader.invalidateTeam(teamName),
};

export function buildOpenCodeTeamConfig(
  request: TeamCreateRequest,
  members: TeamCreateRequest['members']
): TeamConfig {
  return {
    name: request.displayName?.trim() || request.teamName,
    description: request.description,
    color: request.color,
    projectPath: request.cwd,
    members: [
      {
        name: 'team-lead',
        role: 'Team Lead',
        agentType: 'team-lead',
        providerId: normalizeOptionalTeamProviderId(request.providerId),
        model: request.model,
        effort: request.effort,
        cwd: request.cwd,
      },
      ...members.map((member) => ({
        name: member.name,
        role: member.role,
        workflow: member.workflow,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
        model: member.model,
        effort: member.effort,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
        cwd: member.cwd?.trim() || undefined,
      })),
    ],
  };
}

export async function writeOpenCodeTeamConfig(
  request: TeamCreateRequest,
  members: TeamCreateRequest['members'],
  ports: WriteOpenCodeTeamConfigPorts = defaultWriteOpenCodeTeamConfigPorts
): Promise<void> {
  const configPath = path.join(ports.getTeamsBasePath(), request.teamName, 'config.json');
  const config = buildOpenCodeTeamConfig(request, members);

  await ports.writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  ports.invalidateTeam(request.teamName);
}
