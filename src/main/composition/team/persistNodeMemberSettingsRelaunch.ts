import { fingerprintSavedLaunchSettings } from '@features/team-provisioning/contracts';
import { createMemberSettingsRelaunchFeature } from '@features/team-provisioning/main';
import { applyLeadRuntimeSettingsToTeamMeta } from '@main/services/team/provisioning/TeamProvisioningLeadRuntimeRestart';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { createNodeMemberSettingsRepositoryDependencies } from './createNodeMemberSettingsRepositoryDependencies';

import type { NodeMemberSettingsRepositoryOptions } from './createNodeMemberSettingsRepositoryDependencies';
import type { ReplaceMembersRequest } from '@shared/types';

export async function persistNodeMemberSettingsRelaunch(
  teamName: string,
  members: ReplaceMembersRequest['members'],
  intent: unknown,
  options: NodeMemberSettingsRepositoryOptions & {
    hasProvisioningRun(teamName: string): boolean | Promise<boolean>;
  }
): Promise<void> {
  const teamMetaStore = new TeamMetaStore();
  const feature = createMemberSettingsRelaunchFeature({
    persistence: {
      ...createNodeMemberSettingsRepositoryDependencies(options),
      hasProvisioningRun: options.hasProvisioningRun,
    },
    savedLaunch: {
      get: (name) => teamMetaStore.getMeta(name),
      updateLead: (name, expectedFingerprint, settings) =>
        teamMetaStore.updateMeta(name, (current) => {
          if (!current || fingerprintSavedLaunchSettings(current) !== expectedFingerprint) {
            throw new Error('Team launch settings changed during relaunch');
          }
          return applyLeadRuntimeSettingsToTeamMeta(current, settings, null);
        }),
    },
  });
  await feature.persist(teamName, members, intent);
}
