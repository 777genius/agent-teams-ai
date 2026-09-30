import {
  createLegacyMemberSettingsRepository,
  createTeamMemberSettingsFeature,
  type TeamMemberSettingsFeatureApi,
} from '@features/team-provisioning/main';
import { atomicWriteAsync } from '@main/services/team/atomicWrite';
import { withFileLock } from '@main/services/team/fileLock';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import type { ApplicationCommandRunner } from '@features/application-command-ledger';

export {
  registerTeamMemberSettingsIpc,
  removeTeamMemberSettingsIpc,
} from '@features/team-provisioning/main';

interface DesktopMemberSettingsLifecycleSource {
  runLiveRosterMutation(teamName: string, mutation: () => Promise<void>): Promise<void>;
  tryRunLiveRosterMutation?(teamName: string, mutation: () => Promise<void>): Promise<boolean>;
  attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options: { reason: 'member_updated' }
  ): Promise<void>;
}

interface DesktopMemberSettingsRuntimeSource {
  isTeamAlive(teamName: string): boolean;
}

interface DesktopMemberSettingsCacheSource {
  invalidateTeamConfig(teamName: string): void;
  invalidateMemberRuntimeAdvisory(teamName: string): void;
}

export interface DesktopTeamMemberSettingsFeatureDependencies {
  commandRunner?: ApplicationCommandRunner | null;
  memberLifecycle: DesktopMemberSettingsLifecycleSource;
  runtime: DesktopMemberSettingsRuntimeSource;
  getWorkerCache(): DesktopMemberSettingsCacheSource;
}

export function createDesktopTeamMemberSettingsFeature(
  dependencies: DesktopTeamMemberSettingsFeatureDependencies
): TeamMemberSettingsFeatureApi {
  const isTeamAlive = (teamName: string) => dependencies.runtime.isTeamAlive(teamName);
  const membersMetaStore = new TeamMembersMetaStore();
  const teamMetaStore = new TeamMetaStore();
  const repository = createLegacyMemberSettingsRepository({
    membersMetaStore,
    async readConfigJson(teamName) {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      try {
        return await fs.promises.readFile(configPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeConfigJsonAtomic(teamName, contents) {
      return atomicWriteAsync(path.join(getTeamsBasePath(), teamName, 'config.json'), contents);
    },
    withConfigLock(teamName, operation) {
      return withFileLock(path.join(getTeamsBasePath(), teamName, 'config.json'), operation);
    },
    async readLeadProviderId(teamName) {
      return (await teamMetaStore.getMeta(teamName))?.providerId ?? null;
    },
    async teamExists(teamName) {
      try {
        return (await fs.promises.stat(path.join(getTeamsBasePath(), teamName))).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    isTeamAlive,
    invalidateCaches(teamName) {
      TeamConfigReader.invalidateTeam(teamName);
      const cache = dependencies.getWorkerCache();
      cache.invalidateTeamConfig(teamName);
      cache.invalidateMemberRuntimeAdvisory(teamName);
    },
  });

  return createTeamMemberSettingsFeature({
    commandRunner: dependencies.commandRunner,
    mutationSource: dependencies.memberLifecycle,
    lifecycleSource: {
      attachLiveRosterMember: (teamName, memberName, options) =>
        dependencies.memberLifecycle.attachLiveRosterMember(teamName, memberName, options),
      isTeamAlive,
    },
    repository,
  });
}
