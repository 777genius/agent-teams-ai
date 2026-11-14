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
  /** Private admin membership decision on this original receipt, never a public success flag. */
  liveMembership?: LiveRosterMembershipRecord;
}

export interface LiveRosterDelta {
  kind: 'add' | 'remove' | 'restore';
  targetId: string;
  position: number;
  before: TeamMember | null;
  after: TeamMember | null;
  removedBefore?: TeamMember & { removedAt: string };
  removedPosition?: number;
}

/** One exact target publication/inverse, with the original peer and Team setting commitments. */
export interface LiveRosterEdge {
  beforeRevision: string;
  afterRevision: string;
  beforeVersion: number;
  afterVersion: number;
  before: TeamMember | null;
  after: TeamMember | null;
  position: number;
  removedBefore?: TeamMember & { removedAt: string };
  removedAfter?: TeamMember & { removedAt: string };
}

export interface LiveRosterSelection {
  principalId: string;
  delivery: import('./contracts.js').DeliveryBinding;
  configurationDigest: string;
}

export interface LiveRosterMembershipRecord {
  schemaVersion: 1;
  phase: 'pending' | 'captured' | 'preparing' | 'published' | 'compensating' | 'held' | 'completed' | 'rejected';
  input: ReplaceTeamRoster;
  requestDigest: string;
  authorityRevision: number;
  launchId: string;
  sourceCaptureDigest: string;
  hostIncarnation: string;
  /** Original first Host admission; metadata reads and continuations never extend it. */
  cutoff: number;
  beforeVersion: number;
  delta: LiveRosterDelta;
  peerDigest: string;
  savedSettingsDigest: string;
  capture?: import('./liveRosterMembership.js').LiveRosterCaptureView;
  selection?: LiveRosterSelection;
  publication?: LiveRosterEdge;
  compensation?: LiveRosterEdge;
  rejection?: import('./contracts.js').TeamOwnerErrorCode;
}
