import {
  createLegacyMemberSettingsRepository,
  createTeamMemberSettingsFeature,
} from '@features/team-provisioning/main';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import * as fs from 'fs';
import * as path from 'path';

import { getTeamsBasePath } from '../../utils/pathDecoder';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMetaStore } from './TeamMetaStore';

import type {
  LegacyMemberSettingsRepositoryDependencies,
  TeamMemberSettingsFeatureApi,
  TeamMemberSettingsFeatureDependencies,
} from '@features/team-provisioning/main';
import type { TeamMember } from '@shared/types';

type MemberLifecycleSource = TeamMemberSettingsFeatureDependencies['mutationSource'] &
  Pick<TeamMemberSettingsFeatureDependencies['lifecycleSource'], 'attachLiveRosterMember'>;
type LeadRuntimeSource = Pick<
  TeamMemberSettingsFeatureDependencies['lifecycleSource'],
  'assessLeadRuntimeRestart' | 'isTeamAlive' | 'persistLeadRuntimeSettings' | 'restartLeadRuntime'
>;

interface NodeMemberSettingsCacheSource {
  invalidateTeamConfig(teamName: string): void;
  invalidateMemberRuntimeAdvisory(teamName: string): void;
}

export interface NodeTeamMemberSettingsFeatureDependencies {
  commandRunner?: TeamMemberSettingsFeatureDependencies['commandRunner'];
  memberLifecycle: MemberLifecycleSource;
  runtime: Required<LeadRuntimeSource>;
  getWorkerCache(): NodeMemberSettingsCacheSource;
}

function createNodeLegacyMemberSettingsRepositoryDependencies(options: {
  isTeamAlive(teamName: string): boolean;
  invalidateWorkerCache(teamName: string): void;
}): LegacyMemberSettingsRepositoryDependencies {
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
      if (!meta) {
        return { name: 'team-lead', agentType: 'team-lead', role: 'Team Lead' };
      }
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
      } satisfies TeamMember;
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

/** Keeps Node filesystem wiring out of the feature public entrypoint. */
export function createNodeTeamMemberSettingsFeature(
  dependencies: NodeTeamMemberSettingsFeatureDependencies
): TeamMemberSettingsFeatureApi {
  const isTeamAlive = (teamName: string) => dependencies.runtime.isTeamAlive(teamName);
  return createTeamMemberSettingsFeature({
    commandRunner: dependencies.commandRunner,
    mutationSource: dependencies.memberLifecycle,
    lifecycleSource: {
      attachLiveRosterMember: (teamName, memberName, options) =>
        dependencies.memberLifecycle.attachLiveRosterMember(teamName, memberName, options),
      assessLeadRuntimeRestart: (input) => dependencies.runtime.assessLeadRuntimeRestart(input),
      restartLeadRuntime: async (input) => {
        await dependencies.runtime.restartLeadRuntime(input);
        try {
          const cache = dependencies.getWorkerCache();
          cache.invalidateTeamConfig(input.teamName);
          cache.invalidateMemberRuntimeAdvisory(input.teamName);
        } catch {
          // Metadata is committed; the filesystem watcher remains the fallback refresh path.
        }
      },
      persistLeadRuntimeSettings: (input) => dependencies.runtime.persistLeadRuntimeSettings(input),
      isTeamAlive,
    },
    repository: createLegacyMemberSettingsRepository(
      createNodeLegacyMemberSettingsRepositoryDependencies({
        isTeamAlive,
        invalidateWorkerCache: (teamName) => {
          const cache = dependencies.getWorkerCache();
          cache.invalidateTeamConfig(teamName);
          cache.invalidateMemberRuntimeAdvisory(teamName);
        },
      })
    ),
  });
}
