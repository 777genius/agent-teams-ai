import type {
  MemberWorkSyncBusySignalPort,
  MemberWorkSyncLoggerPort,
  MemberWorkSyncNudgeDeliveryWakePort,
  MemberWorkSyncProofMissingRecoveryGuardPort,
  MemberWorkSyncReviewPickupDeliveryPort,
  MemberWorkSyncReviewPickupEscalationPort,
  MemberWorkSyncRuntimeTicketAdmissionPort,
  MemberWorkSyncWatchdogCooldownPort,
  RuntimeTurnSettledTargetResolverPort,
} from '../../core/application';
import type { MemberWorkSyncTeamOperationGate } from '../../core/application/MemberWorkSyncTeamOperationGate';
import type { InternalStorageMemberWorkSyncBackend } from '@features/internal-storage/main';
import type { KanbanState, TeamConfig, TeamMember, TeamSummary, TeamTask } from '@shared/types';

export type MemberWorkSyncIdentityObservation =
  | { status: 'identified'; identityId: string }
  | { status: 'absent' | 'deleting' | 'unavailable' }
  | { status: 'unidentified'; reason: 'invalid_config' | 'missing_marker' | 'identity_lost' };

export interface MemberWorkSyncLifecycleIdentityPort {
  readCurrent(teamName: string): Promise<MemberWorkSyncIdentityObservation>;
  adoptLegacy(teamName: string): Promise<MemberWorkSyncIdentityObservation>;
  withCurrent<T>(
    teamName: string,
    identityId: string,
    operation: () => Promise<T>
  ): Promise<
    { current: true; value: T } | { current: false; identity: MemberWorkSyncIdentityObservation }
  >;
}

export interface MemberWorkSyncConfigReaderPort {
  listTeams?(): Promise<TeamSummary[]>;
  getConfig(teamName: string): Promise<TeamConfig | null>;
  getConfigSnapshot?(teamName: string): Promise<TeamConfig | null>;
}

export interface MemberWorkSyncTaskReaderPort {
  getTasks(teamName: string): Promise<TeamTask[]>;
}

export interface MemberWorkSyncKanbanReaderPort {
  getState(teamName: string, options?: { strict?: boolean }): Promise<KanbanState>;
}

export interface MemberWorkSyncMembersReaderPort {
  getMembers(teamName: string): Promise<TeamMember[]>;
}

export interface MemberWorkSyncPreparedRestore {
  importAndVerify(): Promise<void>;
}

export interface MemberWorkSyncRestoreParticipant {
  prepare(input: {
    backupTeamsRoot: string;
    teamName: string;
    incarnation: string;
  }): Promise<MemberWorkSyncPreparedRestore>;
}

export interface MemberWorkSyncFeatureDeps {
  teamsBasePath: string;
  watchdogCooldown: MemberWorkSyncWatchdogCooldownPort;
  lifecycleIdentity: MemberWorkSyncLifecycleIdentityPort;
  operationGate?: MemberWorkSyncTeamOperationGate;
  startBackground?: boolean;
  bindRestoreParticipant?: (participant: MemberWorkSyncRestoreParticipant) => void;
  configFileAccess?: (configPath: string) => Promise<void>;
  configReader: MemberWorkSyncConfigReaderPort;
  taskReader: MemberWorkSyncTaskReaderPort;
  kanbanManager: MemberWorkSyncKanbanReaderPort;
  membersMetaStore: MemberWorkSyncMembersReaderPort;
  isTeamActive?: (teamName: string) => Promise<boolean> | boolean;
  isMemberActive?: (input: { teamName: string; memberName: string }) => Promise<boolean> | boolean;
  canDispatchNudges?: (teamName: string) => Promise<boolean> | boolean;
  listLifecycleActiveTeamNames?: () => Promise<string[]>;
  queueQuietWindowMs?: number;
  runtimeTurnSettledTargetResolver?: RuntimeTurnSettledTargetResolverPort;
  priorityBusySignals?: MemberWorkSyncBusySignalPort[];
  extraBusySignals?: MemberWorkSyncBusySignalPort[];
  proofMissingRecoveryGuard?: MemberWorkSyncProofMissingRecoveryGuardPort;
  nudgeDeliveryWake?: MemberWorkSyncNudgeDeliveryWakePort;
  resolveControlUrl?: () => Promise<string | null> | string | null;
  reviewPickupDelivery?: MemberWorkSyncReviewPickupDeliveryPort;
  reviewPickupEscalation?: MemberWorkSyncReviewPickupEscalationPort;
  /** Qualified D0 protocol-1 recovery allocation. Desktop wiring turns this on. */
  recoveryAllocation?: { enabled: boolean };
  recoveryProtocol?: { version: number };
  runtimeTicketAdmission?: MemberWorkSyncRuntimeTicketAdmissionPort;
  /** Optional SQLite backend; JSON remains the primary backend when absent. */
  internalStorageBackend?: InternalStorageMemberWorkSyncBackend | null;
  logger?: MemberWorkSyncLoggerPort;
}
