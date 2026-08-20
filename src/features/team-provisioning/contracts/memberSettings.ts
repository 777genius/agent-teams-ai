export type MemberSettingsProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode';
export type MemberSettingsProviderBackendId =
  | 'auto'
  | 'adapter'
  | 'api'
  | 'cli-sdk'
  | 'codex-native'
  | 'opencode-cli';
export type MemberSettingsEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type MemberSettingsFastMode = 'inherit' | 'on' | 'off';
export type MemberSettingsMcpScope = 'user' | 'project' | 'local';
export type MemberSettingsMcpMode = 'inheritLead' | 'inheritScopes' | 'strictAllowlist' | 'appOnly';

export interface MemberSettingsMcpPolicy {
  mode: MemberSettingsMcpMode;
  scopes?: Partial<Record<MemberSettingsMcpScope, boolean>>;
  serverNames?: string[];
}

/**
 * Complete editable settings for one existing team member.
 *
 * Every field is required. `null` explicitly clears an optional persisted
 * value; request producers must not use `undefined` as an implicit patch.
 */
export interface EditableMemberSettings {
  role: string | null;
  workflow: string | null;
  isolation: 'worktree' | null;
  providerId: MemberSettingsProviderId | null;
  providerBackendId: MemberSettingsProviderBackendId | null;
  model: string | null;
  effort: MemberSettingsEffort | null;
  fastMode: MemberSettingsFastMode | null;
  mcpPolicy: MemberSettingsMcpPolicy | null;
}

export type UpdateMemberSettingsEffect =
  | 'no_changes'
  | 'persisted_only'
  | 'member_restart_started'
  | 'opencode_lane_restart_started'
  | 'team_relaunch_required'
  | 'recovery_required';

export interface UpdateMemberSettingsRequest {
  commandId: string;
  idempotencyKey: string;
  teamName: string;
  memberName: string;
  expectedFingerprint: string;
  settings: EditableMemberSettings;
}

export type UpdateMemberSettingsResult =
  | {
      outcome: 'completed';
      effect: UpdateMemberSettingsEffect;
      memberName: string;
      previousFingerprint: string;
      currentFingerprint: string;
      replayed: boolean;
      recovery?: {
        persistenceRestored: boolean;
        lifecycleRestored: boolean;
        cause: string;
      };
    }
  | {
      outcome: 'target_conflict';
      memberName: string;
      expectedFingerprint: string;
      actualFingerprint: string | null;
      reason: 'target_changed' | 'member_not_found' | 'team_not_found';
      replayed: boolean;
    }
  | {
      outcome: 'busy';
      teamName: string;
      memberName: string;
      replayed: boolean;
    };
