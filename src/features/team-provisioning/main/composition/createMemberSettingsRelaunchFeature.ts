import { validateMemberSettingsRelaunch } from '../adapters/input/validateMemberSettingsRelaunch';
import { persistMemberSettingsRelaunch } from '../adapters/output/MemberSettingsRelaunchPersistence';

import type { MemberSettingsEffort } from '../../contracts/memberSettings';
import type { LegacyMemberSettingsRepositoryDependencies } from './LegacyMemberSettingsRepository';
import type { ReplaceMembersRequest } from '@shared/types';

export interface MemberSettingsRelaunchPersistenceDependencies extends LegacyMemberSettingsRepositoryDependencies {
  hasProvisioningRun(teamName: string): boolean | Promise<boolean>;
}

export interface MemberSettingsSavedLaunchPort {
  get(teamName: string): Promise<object | null>;
  updateLead(
    teamName: string,
    expectedFingerprint: string,
    settings: { model: string | null; effort: MemberSettingsEffort | null }
  ): Promise<void>;
}

export interface MemberSettingsRelaunchFeatureDependencies {
  persistence: MemberSettingsRelaunchPersistenceDependencies;
  savedLaunch: MemberSettingsSavedLaunchPort;
}

export interface MemberSettingsRelaunchFeature {
  persist(
    teamName: string,
    members: ReplaceMembersRequest['members'],
    intent: unknown
  ): Promise<void>;
}

/** Portable operation; the app shell supplies concrete stores and filesystem dependencies. */
export function createMemberSettingsRelaunchFeature(
  dependencies: MemberSettingsRelaunchFeatureDependencies
): MemberSettingsRelaunchFeature {
  return {
    async persist(teamName, members, intent) {
      const memberSettingsRelaunch = validateMemberSettingsRelaunch(intent);
      await persistMemberSettingsRelaunch(
        teamName,
        { members, memberSettingsRelaunch },
        dependencies.persistence,
        dependencies.savedLaunch
      );
    },
  };
}
