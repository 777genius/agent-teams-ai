import { TeamDraftConfigurationPersistenceRepository } from '../adapters/output/TeamDraftConfigurationPersistenceRepository';

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

interface TeamDraftConfigurationPersistenceRepositoryFactoryDependencies {
  teamMetaStore: {
    getMeta(teamName: string): Promise<DraftTeamMetadata | null>;
    writeMeta(teamName: string, data: DraftTeamMetadata): Promise<void>;
  };
  teamMembersMetaStore: {
    getMeta(teamName: string): Promise<{
      providerBackendId?: string;
      members: TeamMember[];
    } | null>;
    writeMembers(
      teamName: string,
      members: TeamMember[],
      options?: { providerBackendId?: string }
    ): Promise<void>;
  };
  fileSystem: {
    join(root: string, teamName: string): string;
    lstat(targetPath: string): Promise<unknown>;
    mkdir(targetPath: string, options?: { recursive?: boolean }): Promise<unknown>;
    rm(targetPath: string, options: { recursive: true; force: true }): Promise<unknown>;
  };
  invalidateListTeamsCache(): void;
  now(): number;
}

export interface TeamDraftConfigurationRoots {
  teamsRoot: string;
  tasksRoot: string;
}

export interface TeamDraftConfigurationPersistenceRepositoryPort {
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(
    request: TeamCreateConfigRequest,
    roots: TeamDraftConfigurationRoots
  ): Promise<void>;
}

export function createTeamDraftConfigurationPersistenceRepository(
  dependencies: TeamDraftConfigurationPersistenceRepositoryFactoryDependencies
): TeamDraftConfigurationPersistenceRepositoryPort {
  return new TeamDraftConfigurationPersistenceRepository(dependencies);
}
