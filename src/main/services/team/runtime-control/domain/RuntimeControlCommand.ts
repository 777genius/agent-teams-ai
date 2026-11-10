import type {
  RuntimeControlCommandId,
  RuntimeControlIdempotencyKey,
  RuntimeControlLaneId,
  RuntimeControlMemberName,
  RuntimeControlRunId,
  RuntimeControlRuntimeSessionId,
  RuntimeControlTeamName,
} from './RuntimeControlIds';
import type { RuntimeControlProviderId } from './RuntimeControlProvider';
import type { PersistedTeamLaunchSnapshot, TaskRef, TeamProviderId } from '@shared/types';

export type RuntimeControlSafeMetadataValue = string | number | boolean | null;
export type RuntimeControlSafeMetadata = Readonly<Record<string, RuntimeControlSafeMetadataValue>>;

export type RuntimeControlCommandKind =
  | 'runtime.bootstrap-checkin'
  | 'runtime.deliver-message'
  | 'runtime.task-event'
  | 'runtime.heartbeat'
  | 'runtime.permission-answer';

export interface RuntimeControlCommandEnvelope<
  TKind extends RuntimeControlCommandKind = RuntimeControlCommandKind,
> {
  commandId: RuntimeControlCommandId;
  kind: TKind;
  providerId: RuntimeControlProviderId;
  teamName: RuntimeControlTeamName;
  runId: RuntimeControlRunId;
  laneId?: RuntimeControlLaneId;
}

export interface RuntimeBootstrapCheckinCommand extends RuntimeControlCommandEnvelope<'runtime.bootstrap-checkin'> {
  memberName: RuntimeControlMemberName;
  runtimeSessionId: RuntimeControlRuntimeSessionId;
  observedAt: string;
  diagnostics?: readonly string[];
  metadata?: RuntimeControlSafeMetadata;
}

export type RuntimeDeliverMessageTarget =
  | 'user'
  | { memberName: RuntimeControlMemberName }
  | { teamName: RuntimeControlTeamName; memberName: RuntimeControlMemberName };

export interface RuntimeDeliverMessageCommand extends RuntimeControlCommandEnvelope<'runtime.deliver-message'> {
  idempotencyKey: RuntimeControlIdempotencyKey;
  fromMemberName: RuntimeControlMemberName;
  runtimeSessionId: RuntimeControlRuntimeSessionId;
  target: RuntimeDeliverMessageTarget;
  text: string;
  createdAt: string;
  summary?: string | null;
  taskRefs?: readonly TaskRef[];
}

export interface RuntimeTaskEventCommand extends RuntimeControlCommandEnvelope<'runtime.task-event'> {
  idempotencyKey: RuntimeControlIdempotencyKey;
  memberName: RuntimeControlMemberName;
  taskId: string;
  event: string;
  runtimeSessionId?: RuntimeControlRuntimeSessionId;
  createdAt: string;
}

export interface RuntimeHeartbeatCommand extends RuntimeControlCommandEnvelope<'runtime.heartbeat'> {
  memberName: RuntimeControlMemberName;
  runtimeSessionId: RuntimeControlRuntimeSessionId;
  observedAt: string;
  status?: string;
  metadata?: RuntimeControlSafeMetadata;
}

export type RuntimePermissionAnswerDecision = 'allow' | 'reject';

export interface RuntimePermissionExpectedMember {
  name: RuntimeControlMemberName;
  role?: string;
  workflow?: string;
  providerId?: TeamProviderId;
  cwd?: string;
}

export interface RuntimePermissionAnswerCommand extends RuntimeControlCommandEnvelope<'runtime.permission-answer'> {
  laneId: RuntimeControlLaneId;
  cwd: string;
  memberName: RuntimeControlMemberName;
  requestId: string;
  decision: RuntimePermissionAnswerDecision;
  expectedMembers: readonly RuntimePermissionExpectedMember[];
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
}

export type RuntimeControlCommand =
  | RuntimeBootstrapCheckinCommand
  | RuntimeDeliverMessageCommand
  | RuntimeTaskEventCommand
  | RuntimeHeartbeatCommand
  | RuntimePermissionAnswerCommand;
