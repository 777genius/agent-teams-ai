import type { TeamMember } from './contracts.js';
import type { TeamSavedSettings } from './rosterSchema.js';
export type { TeamSavedSettings } from './rosterSchema.js';

/** Saved application choices, never native credentials/executables/session selectors. */
export interface TeamMemberSettings {
  role?: string | undefined;
  workflow?: string | undefined;
  isolation?: 'worktree' | undefined;
  cwd?: string | undefined;
  providerId?: 'anthropic' | 'codex' | 'gemini' | 'opencode' | undefined;
  providerBackendId?:
    | 'auto'
    | 'adapter'
    | 'api'
    | 'cli-sdk'
    | 'codex-native'
    | 'opencode-cli'
    | undefined;
  model?: string | undefined;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none' | 'ultra' | undefined;
  fastMode?: 'inherit' | 'on' | 'off' | undefined;
  mcpPolicy?:
    | {
        mode: 'inheritLead' | 'inheritScopes' | 'strictAllowlist' | 'appOnly';
        scopes?:
          | {
              user?: boolean | undefined;
              project?: boolean | undefined;
              local?: boolean | undefined;
            }
          | undefined;
        serverNames?: string[] | undefined;
      }
    | undefined;
}

export interface TeamMemberSettingsRelaunchIntent {
  memberName: string;
  targetKind: 'lead' | 'member';
  expectedFingerprint: string;
  expectedTeamSettingsFingerprint: string;
  baseline: { memberName: string; expectedFingerprint: string }[];
  model: string | null;
  effort: NonNullable<TeamMemberSettings['effort']> | null;
}

export interface ReplaceTeamRoster {
  commandId: string;
  expectedRevision: string;
  /** Complete teammate replacement; the existing lead is retained by the owner. */
  members: (TeamMemberSettings & { name: string })[];
  /** Full configured app choices; omit to retain them, omit an option inside to clear it. */
  savedSettings?: TeamSavedSettings | undefined;
  memberSettingsRelaunch?: TeamMemberSettingsRelaunchIntent | undefined;
}
export interface TeamRosterReceipt {
  commandId: string;
  revision: string;
}
export interface TeamRosterConfiguration {
  revision: string;
  /** Absent means not captured, not effective native defaults. */
  savedSettings?: TeamSavedSettings | undefined;
  members: {
    memberId: string;
    name: string;
    role: TeamMember['role'];
    settingsFingerprint?: string;
    settings: TeamMemberSettings;
  }[];
  removedMembers: {
    memberId: string;
    name: string;
    removedAt: string;
    settings: TeamMemberSettings;
  }[];
}
export interface StoredRosterReceipt extends TeamRosterReceipt {
  principalId: string;
  fingerprint: string;
  nativeCreation?: import('./nativeMemberCreationContracts.js').NativeMemberCreationRecord;
}
