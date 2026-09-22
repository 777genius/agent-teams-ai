import type { InboxMessage, SendMessageRequest } from '@shared/types/team';

export type TeamInboxWorkSyncFields = Pick<
  InboxMessage,
  | 'workSyncIntent'
  | 'workSyncIntentKey'
  | 'workSyncReviewRequestEventIds'
  | 'workSyncRuntimeTicketId'
  | 'workSyncRuntimeGeneration'
  | 'workSyncRuntimeInstanceId'
  | 'workSyncControlRevision'
  | 'workSyncPayloadHash'
  | 'workSyncAdmissionPayloadHash'
  | 'workSyncTeamIncarnation'
>;

export function pickTeamInboxWorkSyncFields(
  request: Pick<SendMessageRequest, keyof TeamInboxWorkSyncFields>
): TeamInboxWorkSyncFields {
  return {
    ...(request.workSyncIntent ? { workSyncIntent: request.workSyncIntent } : {}),
    ...(request.workSyncIntentKey ? { workSyncIntentKey: request.workSyncIntentKey } : {}),
    ...(request.workSyncReviewRequestEventIds?.length
      ? { workSyncReviewRequestEventIds: request.workSyncReviewRequestEventIds }
      : {}),
    ...(request.workSyncRuntimeTicketId
      ? { workSyncRuntimeTicketId: request.workSyncRuntimeTicketId }
      : {}),
    ...(typeof request.workSyncRuntimeGeneration === 'number'
      ? { workSyncRuntimeGeneration: request.workSyncRuntimeGeneration }
      : {}),
    ...(request.workSyncRuntimeInstanceId
      ? { workSyncRuntimeInstanceId: request.workSyncRuntimeInstanceId }
      : {}),
    ...(typeof request.workSyncControlRevision === 'number'
      ? { workSyncControlRevision: request.workSyncControlRevision }
      : {}),
    ...(request.workSyncPayloadHash ? { workSyncPayloadHash: request.workSyncPayloadHash } : {}),
    ...(request.workSyncAdmissionPayloadHash
      ? { workSyncAdmissionPayloadHash: request.workSyncAdmissionPayloadHash }
      : {}),
    ...(request.workSyncTeamIncarnation
      ? { workSyncTeamIncarnation: request.workSyncTeamIncarnation }
      : {}),
  };
}
