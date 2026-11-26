import type {
  ReplaceTeamRoster,
  TeamMemberSettings,
  TeamSavedSettings,
} from '@agent-teams/legacy-agent-host/team/contracts';

/** Existing application settings; no vendor profile, account or native selectors. */
export type BackendRosterSettings = TeamMemberSettings;
export type BackendSavedTeamSettings = TeamSavedSettings;
export interface BackendRosterConfiguration {
  revision: string;
  /** Absent means not captured; effective runtime parameters are never saved defaults. */
  savedSettings?: BackendSavedTeamSettings;
  members: {
    memberId: string;
    name: string;
    role: 'lead' | 'member';
    settings: BackendRosterSettings;
    settingsFingerprint?: string;
  }[];
  removedMembers: {
    memberId: string;
    name: string;
    removedAt: string;
    settings: BackendRosterSettings;
  }[];
}
export interface BackendRosterReceipt {
  commandId: string;
  revision: string;
}
export interface BackendRosterReplacement {
  expectedRevision: string;
  members: ReplaceTeamRoster['members'];
  /** Omission preserves settings; supplied object fully replaces configured choices. */
  savedSettings?: BackendSavedTeamSettings;
  memberSettingsRelaunch?: ReplaceTeamRoster['memberSettingsRelaunch'];
}
