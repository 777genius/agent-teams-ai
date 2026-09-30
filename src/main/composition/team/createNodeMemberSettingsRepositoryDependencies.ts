import { atomicWriteAsync } from '@main/services/team/atomicWrite';
import { withFileLock } from '@main/services/team/fileLock';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import * as fs from 'fs';
import * as path from 'path';

import type { LegacyMemberSettingsRepositoryDependencies } from '@features/team-provisioning/main';

export interface NodeMemberSettingsRepositoryOptions {
  isTeamAlive(teamName: string): boolean;
  invalidateWorkerCache(teamName: string): void;
}

/** The single app-owned Node filesystem/store composition path for member settings. */
export function createNodeMemberSettingsRepositoryDependencies(
  options: NodeMemberSettingsRepositoryOptions
): LegacyMemberSettingsRepositoryDependencies {
  const membersMetaStore = new TeamMembersMetaStore();
  const teamMetaStore = new TeamMetaStore();
  return {
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
      const meta = await teamMetaStore.getMeta(teamName);
      return meta?.launchIdentity?.providerId ?? meta?.providerId ?? null;
    },
    async readSyntheticLeadMember(teamName) {
      const meta = await teamMetaStore.getMeta(teamName);
      if (!meta) return { name: 'team-lead', agentType: 'team-lead', role: 'Team Lead' };
      const identity = meta.launchIdentity;
      const effectiveProviderId = identity?.providerId ?? meta.providerId;
      return {
        name: 'team-lead',
        agentType: 'team-lead',
        role: 'Team Lead',
        providerId: effectiveProviderId,
        providerBackendId: migrateProviderBackendId(
          effectiveProviderId,
          identity?.providerBackendId ?? meta.providerBackendId
        ),
        model: identity
          ? identity.selectedModelKind === 'explicit'
            ? (identity.selectedModel ?? undefined)
            : undefined
          : meta.model,
        effort: identity
          ? (identity.selectedEffort ?? undefined)
          : isTeamEffortLevel(meta.effort)
            ? meta.effort
            : undefined,
        fastMode: identity?.selectedFastMode ?? meta.fastMode,
      };
    },
    async teamExists(teamName) {
      try {
        return (await fs.promises.stat(path.join(getTeamsBasePath(), teamName))).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    isTeamAlive: options.isTeamAlive,
    invalidateCaches(teamName) {
      TeamConfigReader.invalidateTeam(teamName);
      options.invalidateWorkerCache(teamName);
    },
  };
}
