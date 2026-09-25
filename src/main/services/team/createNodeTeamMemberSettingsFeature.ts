import {
  createLegacyMemberSettingsRepository,
  createTeamMemberSettingsFeature,
} from '@features/team-provisioning/main';
import { createNodeMemberSettingsRepositoryDependencies } from '@main/composition/team/createNodeMemberSettingsRepositoryDependencies';

import type {
  TeamMemberSettingsFeatureApi,
  TeamMemberSettingsFeatureDependencies,
} from '@features/team-provisioning/main';

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
      createNodeMemberSettingsRepositoryDependencies({
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
