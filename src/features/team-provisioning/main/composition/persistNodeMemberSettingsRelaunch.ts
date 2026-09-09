import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { validateMemberSettingsRelaunch } from '../adapters/input/validateMemberSettingsRelaunch';
import { createNodeLegacyMemberSettingsRepositoryDependencies } from '../adapters/output/LegacyMemberSettingsRepositoryAdapter';
import { persistMemberSettingsRelaunch } from '../adapters/output/MemberSettingsRelaunchPersistence';

import type { NodeLegacyMemberSettingsRepositoryOptions } from '../adapters/output/LegacyMemberSettingsRepositoryAdapter';
import type { ReplaceMembersRequest } from '@shared/types';

export async function persistNodeMemberSettingsRelaunch(
  teamName: string,
  members: ReplaceMembersRequest['members'],
  intent: unknown,
  options: NodeLegacyMemberSettingsRepositoryOptions
): Promise<void> {
  const memberSettingsRelaunch = validateMemberSettingsRelaunch(intent);
  await persistMemberSettingsRelaunch(
    teamName,
    { members, memberSettingsRelaunch },
    createNodeLegacyMemberSettingsRepositoryDependencies(options),
    new TeamMetaStore()
  );
}
