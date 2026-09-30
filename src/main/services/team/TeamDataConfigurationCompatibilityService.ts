import {
  createTeamDraftConfigurationPersistenceRepository,
  type TeamDraftConfigurationPersistenceRepositoryPort,
} from '@features/team-configuration/main';
import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import {
  permanentlyDeleteTeamData,
  type PermanentTeamDataDeletionOptions,
} from './permanentTeamDataDeletion';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamTranscriptProjectResolver } from './TeamTranscriptProjectResolver';

import type {
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamSummary,
} from '@shared/types';

/** Coordinates legacy configuration APIs while canonical feature repositories retain persistence ownership. */
export class TeamDataConfigurationCompatibilityService {
  private readonly draftConfigurationPersistenceRepository: TeamDraftConfigurationPersistenceRepositoryPort;

  constructor(
    private readonly configReader: TeamConfigReader,
    membersMetaStore: TeamMembersMetaStore,
    teamMetaStore: TeamMetaStore,
    private readonly invalidateNotificationContext: (teamName: string) => void,
    private readonly invalidateGlobalTaskProjectionCache: () => void
  ) {
    this.draftConfigurationPersistenceRepository =
      createTeamDraftConfigurationPersistenceRepository({
        teamMetaStore,
        teamMembersMetaStore: membersMetaStore,
        fileSystem: {
          join: (root, teamName) => path.join(root, teamName),
          lstat: (targetPath) => fs.promises.lstat(targetPath),
          mkdir: (targetPath, options) => fs.promises.mkdir(targetPath, options),
          rm: (targetPath, options) => fs.promises.rm(targetPath, options),
        },
        invalidateListTeamsCache: () => TeamConfigReader.invalidateListTeamsCache(),
        now: () => Date.now(),
      });
  }

  createUiSnapshotProjectResolver(): TeamTranscriptProjectResolver {
    return new TeamTranscriptProjectResolver({
      getConfig: (teamName) => this.readConfigForUiSnapshot(teamName),
    });
  }

  async readConfigForUiSnapshot(teamName: string): Promise<TeamConfig | null> {
    const snapshotReader = this.configReader as TeamConfigReader & {
      getConfigSnapshot?: (name: string) => Promise<TeamConfig | null>;
    };
    return typeof snapshotReader.getConfigSnapshot === 'function'
      ? snapshotReader.getConfigSnapshot(teamName)
      : snapshotReader.getConfig(teamName);
  }

  async listTeams(): Promise<TeamSummary[]> {
    return this.configReader.listTeams();
  }

  async getSavedRequest(teamName: string): Promise<TeamCreateRequest | null> {
    return this.draftConfigurationPersistenceRepository.getSavedRequest(teamName);
  }

  async updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<TeamConfig | null> {
    const updated = await this.configReader.updateConfig(teamName, updates);
    this.invalidateNotificationContext(teamName);
    return updated;
  }

  async deleteTeam(teamName: string): Promise<void> {
    const config = await this.getRequiredConfig(teamName);
    config.deletedAt = new Date().toISOString();
    await this.persistConfig(teamName, config);
  }

  async restoreTeam(teamName: string): Promise<void> {
    const config = await this.getRequiredConfig(teamName);
    delete config.deletedAt;
    await this.persistConfig(teamName, config);
  }

  async permanentlyDeleteTeam(teamName: string): Promise<void>;
  async permanentlyDeleteTeam(
    teamName: string,
    isTeamDataCurrent: (detachedPath?: string) => Promise<boolean>,
    isTaskDataCurrent?: (detachedPath?: string) => Promise<boolean>,
    options?: PermanentTeamDataDeletionOptions
  ): Promise<boolean>;
  async permanentlyDeleteTeam(
    teamName: string,
    isTeamDataCurrent: (detachedPath?: string) => Promise<boolean> = async () => true,
    isTaskDataCurrent: (detachedPath?: string) => Promise<boolean> = async () => true,
    options: PermanentTeamDataDeletionOptions = {}
  ): Promise<boolean | void> {
    return permanentlyDeleteTeamData({
      teamName,
      isTeamDataCurrent,
      isTaskDataCurrent,
      options,
      onTeamDataDeleted: () => {
        TeamConfigReader.invalidateTeam(teamName);
        this.invalidateNotificationContext(teamName);
      },
      onTaskDataDeleted: this.invalidateGlobalTaskProjectionCache,
    });
  }

  async createTeamConfig(request: TeamCreateConfigRequest): Promise<void> {
    return this.draftConfigurationPersistenceRepository.createTeamConfig(request, {
      teamsRoot: getTeamsBasePath(),
      tasksRoot: getTasksBasePath(),
    });
  }

  private async getRequiredConfig(teamName: string): Promise<TeamConfig> {
    const config = await this.configReader.getConfig(teamName);
    if (!config) throw new Error(`Team not found: ${teamName}`);
    return config;
  }

  private async persistConfig(teamName: string, config: TeamConfig): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
    await TeamConfigReader.primeConfig(teamName, config);
    this.invalidateNotificationContext(teamName);
  }
}
