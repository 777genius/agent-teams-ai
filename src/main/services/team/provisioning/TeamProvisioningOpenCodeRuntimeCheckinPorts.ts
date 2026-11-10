import type { TeamRuntimeLaunchResult } from '../runtime';
import type {
  OpenCodeTaskLogAttributionRecord,
  OpenCodeTaskLogAttributionWriteResult,
} from '../taskLogs/stream/OpenCodeTaskLogAttributionStore';
import type { OpenCodeRuntimeBootstrapEvidencePorts } from './TeamProvisioningOpenCodeBootstrapEvidence';
import type { PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamConfig,
  TeamCreateRequest,
  TeamMember,
} from '@shared/types';

export interface OpenCodeRuntimeCheckinLane {
  laneId: string;
  providerId: 'opencode';
  member: TeamCreateRequest['members'][number];
  runId: string | null;
  state: 'queued' | 'launching' | 'finished';
  result: TeamRuntimeLaunchResult | null;
  warnings: string[];
  diagnostics: string[];
}

export interface OpenCodeRuntimeCheckinRun {
  runId: string;
  teamName: string;
  request: TeamCreateRequest;
  effectiveMembers: TeamCreateRequest['members'];
  processKilled: boolean;
  cancelRequested: boolean;
  mixedSecondaryLanes: OpenCodeRuntimeCheckinLane[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  pendingMemberRestarts?: Pick<Map<string, unknown>, 'delete' | 'has'>;
}

export interface OpenCodeRuntimeCheckinPorts<Run extends OpenCodeRuntimeCheckinRun> {
  teamsBasePath: string;
  resolveOpenCodeRuntimeLaneId(input: {
    teamName: string;
    runId: string;
    memberName?: string;
  }): Promise<string>;
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchState(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void>;
  mutateLaunchState(
    teamName: string,
    mutation: (current: PersistedTeamLaunchSnapshot | null) => Promise<PersistedTeamLaunchSnapshot>
  ): Promise<PersistedTeamLaunchSnapshot>;
  withTeamLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<TeamMember[]>;
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  getTrackedRun(teamName: string): Run | null;
  persistTrackedRunLaunchState(run: Run): Promise<void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  emitMemberSpawnChange(run: Run, memberName: string): void;
  emitRuntimeMemberSpawnChange(input: {
    teamName: string;
    runId: string;
    memberName: string;
  }): void;
  emitTaskLogChange(input: {
    teamName: string;
    runId: string;
    taskId: string;
    detail: string;
  }): void;
  createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts;
  upsertOpenCodeTaskRecord(
    teamName: string,
    record: OpenCodeTaskLogAttributionRecord
  ): Promise<OpenCodeTaskLogAttributionWriteResult>;
  syncMemberTaskActivityForRuntimeTransition(
    run: Run,
    memberName: string,
    previousStatus: MemberSpawnStatusEntry,
    nextStatus: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  syncMemberLaunchGraceCheck(
    run: Run,
    memberName: string,
    nextStatus: MemberSpawnStatusEntry
  ): void;
}

export type OpenCodeRuntimeCheckinPortCallbacks<Run extends OpenCodeRuntimeCheckinRun> = Omit<
  OpenCodeRuntimeCheckinPorts<Run>,
  'emitRuntimeMemberSpawnChange' | 'emitTaskLogChange'
> & {
  emitTeamChange(event: TeamChangeEvent): void;
};

export function createOpenCodeRuntimeCheckinPorts<Run extends OpenCodeRuntimeCheckinRun>(
  callbacks: OpenCodeRuntimeCheckinPortCallbacks<Run>
): OpenCodeRuntimeCheckinPorts<Run> {
  return {
    teamsBasePath: callbacks.teamsBasePath,
    resolveOpenCodeRuntimeLaneId: callbacks.resolveOpenCodeRuntimeLaneId,
    resolveCurrentOpenCodeRuntimeRunId: callbacks.resolveCurrentOpenCodeRuntimeRunId,
    readLaunchState: callbacks.readLaunchState,
    writeLaunchState: callbacks.writeLaunchState,
    mutateLaunchState: callbacks.mutateLaunchState,
    withTeamLock: callbacks.withTeamLock,
    readConfigForStrictDecision: callbacks.readConfigForStrictDecision,
    readMetaMembers: callbacks.readMetaMembers,
    readPersistedRuntimeMembers: callbacks.readPersistedRuntimeMembers,
    getTrackedRun: callbacks.getTrackedRun,
    persistTrackedRunLaunchState: callbacks.persistTrackedRunLaunchState,
    invalidateRuntimeSnapshotCaches: callbacks.invalidateRuntimeSnapshotCaches,
    emitMemberSpawnChange: callbacks.emitMemberSpawnChange,
    emitRuntimeMemberSpawnChange: (event) => {
      callbacks.emitTeamChange({
        type: 'member-spawn',
        teamName: event.teamName,
        runId: event.runId,
        detail: event.memberName,
      });
    },
    emitTaskLogChange: (event) => {
      callbacks.emitTeamChange({
        type: 'task-log-change',
        teamName: event.teamName,
        runId: event.runId,
        taskId: event.taskId,
        detail: event.detail,
        taskSignalKind: 'log',
      });
    },
    createOpenCodeRuntimeBootstrapEvidencePorts:
      callbacks.createOpenCodeRuntimeBootstrapEvidencePorts,
    upsertOpenCodeTaskRecord: callbacks.upsertOpenCodeTaskRecord,
    syncMemberTaskActivityForRuntimeTransition:
      callbacks.syncMemberTaskActivityForRuntimeTransition,
    syncMemberLaunchGraceCheck: callbacks.syncMemberLaunchGraceCheck,
  };
}
