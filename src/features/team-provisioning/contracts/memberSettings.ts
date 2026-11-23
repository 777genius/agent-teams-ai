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

/**
 * The saved settings of one member as the settings mutation compares them
 * (its fingerprint is taken from these fields). Read for a team whose members
 * have no runtime snapshot, such as the definition of a per-project team.
 */
export interface MemberSettingsTarget {
  name: string;
  agentType: string | null;
  agentId: string | null;
  joinedAt: number | string | null;
  settings: EditableMemberSettings;
}

export interface GetMemberSettingsTargetRequest {
  teamName: string;
  memberName: string;
}

export type UpdateMemberSettingsEffect =
  | 'no_changes'
  | 'persisted_only'
  | 'member_restart_started'
  | 'lead_restart_started'
  | 'lead_restart_rolled_back'
  | 'opencode_lane_restart_started'
  | 'team_relaunch_required'
  | 'recovery_required';

export interface MemberSettingsRelaunchGuard {
  expectedTeamSettingsFingerprint: string;
  baseline: { memberName: string; expectedFingerprint: string }[];
}

interface UpdateMemberSettingsRequestBase {
  commandId: string;
  idempotencyKey: string;
  teamName: string;
  memberName: string;
  expectedFingerprint: string;
  /** Compare the complete logical-team baseline when committing a confirmed relaunch. */
  relaunchGuard?: MemberSettingsRelaunchGuard;
}

export type UpdateMemberSettingsRequest = UpdateMemberSettingsRequestBase &
  (
    | { targetKind: 'member'; settings: EditableMemberSettings }
    | {
        targetKind: 'lead';
        leadRuntime: Pick<EditableMemberSettings, 'model' | 'effort'>;
      }
  );

/**
 * Why the main process refused a member settings change before anything was
 * written. A stable code, so the app can explain it in the user's language.
 * - `project_copy`: the team is the project copy of another team;
 * - `project_running`, `project_launching`, `project_unreconciled`: a team
 *   a project runtime is incompatible with the requested edit, still starting
 *   or stopping, or its state requires reconciliation;
 * - `team_metadata_unreadable`: the team's saved settings cannot be read.
 */
export type MemberSettingsRefusalReason =
  | 'project_copy'
  | 'project_running'
  | 'project_launching'
  | 'project_unreconciled'
  | 'team_metadata_unreadable';

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
    }
  | {
      outcome: 'refused';
      reason: MemberSettingsRefusalReason;
      memberName: string;
      /** English diagnostics for logs; the app shows the localized text of `reason`. */
      message: string;
      replayed: boolean;
    };
