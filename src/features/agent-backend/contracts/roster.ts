import type {
  ReplaceMembersRequest,
  TeamCreateDraft,
  TeamProvisioningMemberInput,
} from '@shared/types/team';

/** Existing application settings; no vendor profile, account or native selectors. */
export type BackendRosterSettings = Omit<TeamProvisioningMemberInput, 'name'>;
export type BackendSavedTeamSettings = Omit<TeamCreateDraft, 'teamName' | 'members'>;
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
  members: TeamProvisioningMemberInput[];
  /** Omission preserves settings; supplied object fully replaces configured choices. */
  savedSettings?: BackendSavedTeamSettings;
  memberSettingsRelaunch?: ReplaceMembersRequest['memberSettingsRelaunch'];
}
