import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { getProjectsBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';

import { atomicWriteAsync } from '../atomicWrite';
import { withFileLock } from '../fileLock';
import { withInboxLock } from '../inboxLock';
import { TeamConfigReader } from '../TeamConfigReader';

import { buildMembersMetaWritePayload } from './TeamProvisioningConfigLaunchNormalization';
import {
  TeamProvisioningConfigMaintenance,
  type TeamProvisioningConfigMaintenanceMembersMetaStore,
  type TeamProvisioningConfigMaintenanceReadOptions,
} from './TeamProvisioningConfigMaintenance';
import { type TeamProvisioningEffectiveLaunchState } from './TeamProvisioningConfigMaterialization';
import { type TeamLaunchCompatibilityReport } from './TeamProvisioningLaunchCompatibility';
import {
  resolveLaunchExpectedMembers as resolveLaunchExpectedMembersHelper,
  type TeamProvisioningLaunchExpectedMembersPorts,
} from './TeamProvisioningLaunchExpectedMembers';
import { createTeamProvisioningLaunchExpectedMembersPorts } from './TeamProvisioningLaunchExpectedMembersPortsFactory';
import {
  listPersistedTeamNames as listPersistedTeamNamesHelper,
  type PersistedTeamConfigCacheEntry,
  readPersistedRuntimeMembers as readPersistedRuntimeMembersHelper,
  readPersistedTeamProjectPath as readPersistedTeamProjectPathHelper,
} from './TeamProvisioningPersistedTeamConfigAccess';
import {
  TEAM_CONFIG_MAX_BYTES,
  TEAM_INBOX_MAX_BYTES,
  TEAM_JSON_READ_TIMEOUT_MS,
} from './TeamProvisioningRunModel';
import { type PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';
import { scanForNewestProjectSession } from './TeamProvisioningSessionDiscovery';

import type {
  TeamConfig,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
} from '@shared/types';

export interface TeamProvisioningConfigFacadeReader {
  getConfig(teamName: string): Promise<TeamConfig | null>;
  getConfigSnapshot?(teamName: string): Promise<TeamConfig | null>;
}

export interface TeamProvisioningConfigFacadeInboxReader {
  listInboxNames(teamName: string): Promise<string[]>;
}

export interface TeamProvisioningConfigFacadeOptions {
  configReader: TeamProvisioningConfigFacadeReader;
  inboxReader: TeamProvisioningConfigFacadeInboxReader;
  membersMetaStore: TeamProvisioningConfigMaintenanceMembersMetaStore;
  launchStateStore: {
    read(teamName: string): Promise<unknown>;
  };
  persistedTeamConfigCache: Map<string, PersistedTeamConfigCacheEntry>;
  readBootstrapLaunchSnapshot(teamName: string): Promise<unknown>;
  readRegularFileUtf8(
    filePath: string,
    options: TeamProvisioningConfigMaintenanceReadOptions
  ): Promise<string | null | undefined>;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
  };
}

export class TeamProvisioningConfigFacade {
  readonly launchExpectedMembersPorts: TeamProvisioningLaunchExpectedMembersPorts;
  private readonly configMaintenance: TeamProvisioningConfigMaintenance;

  constructor(private readonly options: TeamProvisioningConfigFacadeOptions) {
    this.launchExpectedMembersPorts = createTeamProvisioningLaunchExpectedMembersPorts({
      launchStateStore: options.launchStateStore,
      readBootstrapLaunchSnapshot: options.readBootstrapLaunchSnapshot,
      membersMetaStore: options.membersMetaStore,
      inboxReader: options.inboxReader,
      logger: options.logger,
    });
    this.configMaintenance = new TeamProvisioningConfigMaintenance({
      ports: {
        getTeamsBasePath,
        getProjectsBasePath,
        readRegularFileUtf8: options.readRegularFileUtf8,
        writeFileUtf8: (filePath, contents) => atomicWriteAsync(filePath, contents),
        unlink: (filePath) => fs.promises.unlink(filePath),
        readDir: (dirPath) => fs.promises.readdir(dirPath),
        stat: (filePath) => fs.promises.stat(filePath),
        withCanonicalInboxLock: (filePath, fn) =>
          withFileLock(filePath, () => withInboxLock(filePath, fn)),
        scanForNewestProjectSession,
        membersMetaStore: options.membersMetaStore,
        invalidateTeam: (teamName) => TeamConfigReader.invalidateTeam(teamName),
        getLanguage: () =>
          ConfigManager.getInstance().getConfig().general.agentLanguage || 'system',
        now: () => Date.now(),
        logger: options.logger,
      },
      limits: {
        teamJsonReadTimeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        teamConfigMaxBytes: TEAM_CONFIG_MAX_BYTES,
        teamInboxMaxBytes: TEAM_INBOX_MAX_BYTES,
      },
    });
  }

  async readConfigSnapshot(teamName: string): Promise<TeamConfig | null> {
    return typeof this.options.configReader.getConfigSnapshot === 'function'
      ? this.options.configReader.getConfigSnapshot(teamName)
      : this.options.configReader.getConfig(teamName);
  }

  readConfigForObservation(teamName: string): Promise<TeamConfig | null> {
    return this.readConfigSnapshot(teamName);
  }

  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null> {
    return this.options.configReader.getConfig(teamName);
  }

  readPersistedTeamProjectPath(teamName: string): string | null {
    return readPersistedTeamProjectPathHelper(teamName, this.persistedAccess());
  }

  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[] {
    return readPersistedRuntimeMembersHelper(teamName, this.persistedAccess());
  }

  listPersistedTeamNames(): string[] {
    return listPersistedTeamNamesHelper(getTeamsBasePath());
  }

  updateConfigProjectPath(teamName: string, cwd: string): Promise<void> {
    return this.configMaintenance.updateConfigProjectPath(teamName, cwd);
  }

  updateConfigPostLaunch(
    teamName: string,
    projectPath: string,
    detectedSessionId: string | null,
    color?: string,
    launchState?: TeamProvisioningEffectiveLaunchState
  ): Promise<void> {
    return this.configMaintenance.updateConfigPostLaunch(
      teamName,
      projectPath,
      detectedSessionId,
      color,
      launchState
    );
  }

  cleanupCliAutoSuffixedMembers(teamName: string): Promise<void> {
    return this.configMaintenance.cleanupCliAutoSuffixedMembers(teamName);
  }

  assertConfigLeadOnlyForLaunch(teamName: string): Promise<void> {
    return this.configMaintenance.assertConfigLeadOnlyForLaunch(teamName);
  }

  normalizeTeamConfigForLaunch(teamName: string, configRaw: string): Promise<void> {
    return this.configMaintenance.normalizeTeamConfigForLaunch(teamName, configRaw);
  }

  restorePrelaunchConfig(teamName: string): Promise<void> {
    return this.configMaintenance.restorePrelaunchConfig(teamName);
  }

  cleanupPrelaunchBackup(teamName: string): Promise<void> {
    return this.configMaintenance.cleanupPrelaunchBackup(teamName);
  }

  persistMembersMeta(teamName: string, request: TeamCreateRequest): Promise<void> {
    return this.configMaintenance.persistMembersMeta(teamName, request);
  }

  resolveLaunchExpectedMembers(
    teamName: string,
    configRaw: string,
    leadProviderId?: TeamProviderId
  ): Promise<{
    members: TeamCreateRequest['members'];
    source: 'members-meta' | 'inboxes' | 'config-fallback';
    warning?: string;
  }> {
    return resolveLaunchExpectedMembersHelper(
      { teamName, configRaw, leadProviderId },
      this.launchExpectedMembersPorts
    );
  }

  async materializeLaunchCompatibilityRepair(
    request: TeamLaunchRequest,
    report: TeamLaunchCompatibilityReport
  ): Promise<void> {
    if (report.repairAction !== 'materialize-members-meta' || report.members.length === 0) {
      return;
    }
    const joinedAt = Date.now();
    const membersToWrite = buildMembersMetaWritePayload(
      report.members.map((member) => ({
        ...member,
        joinedAt,
      }))
    );
    await this.options.membersMetaStore.writeMembers(request.teamName, membersToWrite, {
      providerBackendId: request.providerBackendId,
    });
  }

  private persistedAccess() {
    return {
      teamsBasePath: getTeamsBasePath(),
      cache: this.options.persistedTeamConfigCache,
    };
  }
}
