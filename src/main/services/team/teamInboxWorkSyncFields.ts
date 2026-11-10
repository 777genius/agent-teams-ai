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

export function readTeamInboxWorkSyncFields(row: Partial<InboxMessage>): TeamInboxWorkSyncFields {
  return {
    ...(row.workSyncIntent === 'agenda_sync' || row.workSyncIntent === 'review_pickup'
      ? { workSyncIntent: row.workSyncIntent }
      : {}),
    ...(typeof row.workSyncIntentKey === 'string'
      ? { workSyncIntentKey: row.workSyncIntentKey }
      : {}),
    ...(Array.isArray(row.workSyncReviewRequestEventIds)
      ? {
          workSyncReviewRequestEventIds: row.workSyncReviewRequestEventIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0
          ),
        }
      : {}),
    ...(typeof row.workSyncPayloadHash === 'string'
      ? { workSyncPayloadHash: row.workSyncPayloadHash }
      : {}),
    ...(typeof row.workSyncRuntimeTicketId === 'string'
      ? { workSyncRuntimeTicketId: row.workSyncRuntimeTicketId }
      : {}),
    ...(typeof row.workSyncRuntimeGeneration === 'number' &&
    Number.isInteger(row.workSyncRuntimeGeneration)
      ? { workSyncRuntimeGeneration: row.workSyncRuntimeGeneration }
      : {}),
    ...(typeof row.workSyncRuntimeInstanceId === 'string'
      ? { workSyncRuntimeInstanceId: row.workSyncRuntimeInstanceId }
      : {}),
    ...(typeof row.workSyncAdmissionPayloadHash === 'string'
      ? { workSyncAdmissionPayloadHash: row.workSyncAdmissionPayloadHash }
      : {}),
    ...(typeof row.workSyncTeamIncarnation === 'string'
      ? { workSyncTeamIncarnation: row.workSyncTeamIncarnation }
      : {}),
    ...(typeof row.workSyncControlRevision === 'number' &&
    Number.isInteger(row.workSyncControlRevision)
      ? { workSyncControlRevision: row.workSyncControlRevision }
      : {}),
  };
}

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
