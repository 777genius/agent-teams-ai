import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
  TeamRuntimePendingPermission,
  TeamRuntimePermissionListResult,
} from '../runtime';
import type { LaunchStateWriteOptions } from './TeamProvisioningLaunchStateStoreBoundary';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
} from '@shared/types';

export type OpenCodeRuntimePermissionListingAdapter = TeamLaunchRuntimeAdapter & {
  listRuntimePermissions(input: {
    teamName: string;
    laneId: string;
    cwd: string;
    memberName?: string;
    sessionId?: string | null;
  }): Promise<TeamRuntimePermissionListResult>;
};

export interface OpenCodeRuntimePermissionSyncInput {
  teamName: string;
  runId?: string | null;
  laneId: string;
  memberName: string;
  cwd: string;
  sessionId?: string | null;
  responseState?: string;
  reason?: string | null;
  diagnostics?: readonly string[];
  teamColor?: string;
  teamDisplayName?: string;
}

export interface OpenCodeRuntimePermissionTrackedRunLike {
  runId: string;
  request: Pick<TeamCreateRequest, 'providerId'>;
  allEffectiveMembers?: readonly TeamCreateRequest['members'][number][];
  effectiveMembers?: readonly TeamCreateRequest['members'][number][];
  mixedSecondaryLanes?: OpenCodeRuntimePermissionLaneLike[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  isLaunch: boolean;
  provisioningComplete?: boolean;
}

export interface OpenCodeRuntimePermissionLaneLike {
  laneId: string;
  result: TeamRuntimeLaunchResult | null;
}

export interface OpenCodeRuntimePermissionRuntimeRunLike {
  runId: string;
  providerId: string;
  members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
}

export interface OpenCodeRuntimePendingPermissionsPersistenceInput {
  teamName: string;
  runId?: string | null;
  laneId: string;
  sessionId?: string | null;
  permissionsByMember: ReadonlyMap<string, readonly TeamRuntimePendingPermission[]>;
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
}

export interface OpenCodeRuntimePermissionSpawnStatusSyncInput {
  teamName: string;
  runId?: string | null;
  laneId: string;
  permissionsByMember: ReadonlyMap<string, readonly TeamRuntimePendingPermission[]>;
}

export interface OpenCodeRuntimePermissionToolApprovalSyncInput {
  teamName: string;
  runId: string;
  laneId: string;
  cwd: string;
  members: Record<string, TeamRuntimeMemberLaunchEvidence>;
  expectedMembers: TeamRuntimeMemberSpec[];
  memberNames?: readonly string[];
  teamColor?: string;
  teamDisplayName?: string;
}

export interface OpenCodeRuntimePermissionSyncPorts {
  getTrackedRunId(teamName: string): string | null;
  getPermissionListingAdapter(): OpenCodeRuntimePermissionListingAdapter | null;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getTrackedRun(teamName: string): OpenCodeRuntimePermissionTrackedRunLike | null;
  getRuntimeAdapterRun(teamName: string): OpenCodeRuntimePermissionRuntimeRunLike | null;
  persistPendingPermissions(
    input: OpenCodeRuntimePendingPermissionsPersistenceInput
  ): Promise<boolean | void>;
  syncSpawnStatuses(input: OpenCodeRuntimePermissionSpawnStatusSyncInput): void;
  syncToolApprovals(input: OpenCodeRuntimePermissionToolApprovalSyncInput): void;
  logWarning(message: string): void;
}

export interface OpenCodeRuntimePendingPermissionsPersistencePorts {
  nowIso(): string;
  getTrackedRunId(teamName: string): string | null;
  enqueueLaunchStateStoreOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: Pick<
      LaunchStateWriteOptions,
      'republishesExistingLaunch' | 'isAuthorized' | 'requireTrackedRun' | 'runId'
    >
  ): Promise<boolean | { wrote: boolean } | void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  emitMemberSpawnChange(input: {
    teamName: string;
    runId?: string | null;
    memberName: string;
  }): void;
  logDebug(message: string): void;
}

interface OpenCodeRuntimePendingPermissionsMemberSpawnChangeEvent {
  type: 'member-spawn';
  teamName: string;
  runId?: string;
  detail: string;
}

export interface OpenCodeRuntimePendingPermissionsPersistenceServiceHost {
  enqueueLaunchStateStoreOperation: OpenCodeRuntimePendingPermissionsPersistencePorts['enqueueLaunchStateStoreOperation'];
  writeLaunchStateSnapshotNow: OpenCodeRuntimePendingPermissionsPersistencePorts['writeLaunchStateSnapshot'];
  invalidateRuntimeSnapshotCaches: OpenCodeRuntimePendingPermissionsPersistencePorts['invalidateRuntimeSnapshotCaches'];
  teamChangeEmitter?:
    | ((event: OpenCodeRuntimePendingPermissionsMemberSpawnChangeEvent) => void)
    | null;
}

export interface OpenCodeRuntimePendingPermissionsPersistenceServiceHostOptions {
  nowIso: OpenCodeRuntimePendingPermissionsPersistencePorts['nowIso'];
  getTrackedRunId: OpenCodeRuntimePendingPermissionsPersistencePorts['getTrackedRunId'];
  readLaunchState: OpenCodeRuntimePendingPermissionsPersistencePorts['readLaunchState'];
  logDebug: OpenCodeRuntimePendingPermissionsPersistencePorts['logDebug'];
}
