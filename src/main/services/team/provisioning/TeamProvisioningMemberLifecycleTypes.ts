import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  EffortLevel,
  MemberSpawnStatusEntry,
  TeamConfig,
  TeamCreateRequest,
  TeamProviderId,
} from '@shared/types';

export type LiveRosterAttachReason = 'member_added' | 'member_restored' | 'member_updated';
export type DirectProcessMemberLaunchReason = 'manual_restart' | LiveRosterAttachReason;

export type EffectiveConfiguredMember = TeamCreateRequest['members'][number] & {
  agentType?: string;
  removedAt?: number | string;
};

export interface PendingMemberRestartContextLike {
  requestedAt: string;
  desired?: {
    name: string;
    role?: string;
    workflow?: string;
    isolation?: 'worktree';
    providerId?: TeamProviderId;
    model?: string;
    effort?: EffortLevel;
  };
}

export interface ProvisioningRun {
  runId: string;
  teamName: string;
  request: TeamCreateRequest;
  spawnContext?: { claudePath?: string };
  detectedSessionId: string | null;
  memberMcpConfigPaths: string[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  memberSpawnToolUseIds: Map<string, string>;
  pendingMemberRestarts: Map<string, PendingMemberRestartContextLike>;
  mixedSecondaryLanes: MixedSecondaryRuntimeLaneState[];
  processKilled: boolean;
  cancelRequested: boolean;
  isLaunch: boolean;
  provisioningComplete: boolean;
}

export interface PersistedRuntimeMemberLike {
  name?: string;
  agentId?: string;
  tmuxPaneId?: string;
  backendType?: string;
  providerId?: string;
  cwd?: string;
  bootstrapExpectedAfter?: string;
  bootstrapProofToken?: string;
  bootstrapRunId?: string;
  bootstrapProofMode?: string;
  bootstrapContextHash?: string;
  bootstrapBriefingHash?: string;
  bootstrapRuntimeEventsPath?: string;
  runtimePid?: number;
  runtimeSessionId?: string;
}

export interface DirectProcessMemberRestartInput {
  run: ProvisioningRun;
  teamName: string;
  displayName: string;
  leadName: string;
  memberName: string;
  config: TeamConfig;
  configuredMember: NonNullable<EffectiveConfiguredMember | null>;
  persistedRuntimeMembers: readonly PersistedRuntimeMemberLike[];
  operation?: DirectProcessMemberLaunchReason;
}

export interface ReattachOpenCodeOwnedMemberLaneOptions {
  reason?: 'member_added' | 'member_updated' | 'manual_restart';
}
