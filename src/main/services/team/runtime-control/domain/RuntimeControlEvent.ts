import type { RuntimePermissionAnswerDecision } from './RuntimeControlCommand';
import type {
  RuntimeControlCommandId,
  RuntimeControlEventId,
  RuntimeControlIdempotencyKey,
  RuntimeControlLaneId,
  RuntimeControlMemberName,
  RuntimeControlRunId,
  RuntimeControlRuntimeSessionId,
  RuntimeControlTeamName,
} from './RuntimeControlIds';
import type { RuntimeControlProviderId } from './RuntimeControlProvider';

export type RuntimeControlEventType =
  | 'RuntimeBootstrapAccepted'
  | 'RuntimeHeartbeatAccepted'
  | 'RuntimeTaskEventRecorded'
  | 'RuntimeMessageDelivered'
  | 'RuntimeMessageDuplicate'
  | 'RuntimePermissionPendingSynced'
  | 'RuntimePermissionAnswered'
  | 'RuntimeControlRejected';

export interface RuntimeControlEventEnvelope<
  TType extends RuntimeControlEventType = RuntimeControlEventType,
> {
  eventId: RuntimeControlEventId;
  type: TType;
  providerId: RuntimeControlProviderId;
  teamName: RuntimeControlTeamName;
  runId: RuntimeControlRunId;
  laneId: RuntimeControlLaneId;
  occurredAt: string;
  commandId?: RuntimeControlCommandId;
}

export interface RuntimeBootstrapAcceptedEvent extends RuntimeControlEventEnvelope<'RuntimeBootstrapAccepted'> {
  memberName: RuntimeControlMemberName;
  runtimeSessionId: RuntimeControlRuntimeSessionId;
}

export interface RuntimeHeartbeatAcceptedEvent extends RuntimeControlEventEnvelope<'RuntimeHeartbeatAccepted'> {
  memberName: RuntimeControlMemberName;
  runtimeSessionId: RuntimeControlRuntimeSessionId;
  status?: string;
}

export interface RuntimeTaskEventRecordedEvent extends RuntimeControlEventEnvelope<'RuntimeTaskEventRecorded'> {
  memberName: RuntimeControlMemberName;
  taskId: string;
  taskEvent: string;
  idempotencyKey: RuntimeControlIdempotencyKey;
}

export interface RuntimeMessageDeliveredEvent extends RuntimeControlEventEnvelope<'RuntimeMessageDelivered'> {
  idempotencyKey: RuntimeControlIdempotencyKey;
  fromMemberName: RuntimeControlMemberName;
  location?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RuntimeMessageDuplicateEvent extends RuntimeControlEventEnvelope<'RuntimeMessageDuplicate'> {
  idempotencyKey: RuntimeControlIdempotencyKey;
}

export interface RuntimePermissionPendingSyncedEvent extends RuntimeControlEventEnvelope<'RuntimePermissionPendingSynced'> {
  memberName: RuntimeControlMemberName;
  requestIds: readonly string[];
}

export interface RuntimePermissionAnsweredEvent extends RuntimeControlEventEnvelope<'RuntimePermissionAnswered'> {
  memberName: RuntimeControlMemberName;
  requestId: string;
  decision: RuntimePermissionAnswerDecision;
}

export interface RuntimeControlRejectedEvent extends RuntimeControlEventEnvelope<'RuntimeControlRejected'> {
  reason: string;
  memberName?: RuntimeControlMemberName;
  idempotencyKey?: RuntimeControlIdempotencyKey;
}

export type RuntimeControlEvent =
  | RuntimeBootstrapAcceptedEvent
  | RuntimeHeartbeatAcceptedEvent
  | RuntimeTaskEventRecordedEvent
  | RuntimeMessageDeliveredEvent
  | RuntimeMessageDuplicateEvent
  | RuntimePermissionPendingSyncedEvent
  | RuntimePermissionAnsweredEvent
  | RuntimeControlRejectedEvent;
