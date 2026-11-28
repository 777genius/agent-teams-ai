import type {
  TaskDetailEditorIntent,
  TaskDetailEditorRequest,
} from '../team/taskDetailEditorRoute';
import type { TaskDetailReviewRequest } from '../team/taskDetailReviewRoute';
import type {
  OpenTaskDetailTabResult,
  TaskDetailDeletionIntent,
  TaskDetailEditPart,
  TaskDetailIdentity,
  TaskDetailReadEntry,
  TaskDetailReadScope,
  TaskDetailReadToken,
  TaskDetailSavePart,
  TaskDetailSaveRevision,
  TaskDetailSession,
} from '@features/team-task-detail/core';
import type { AddTaskCommentRequest, TeamTaskWithKanban } from '@shared/types';

export interface TeamTaskDetailSlice {
  taskDetailReviewActivationFailure: {
    nonce: string;
    identity: TaskDetailIdentity;
    options: Pick<TaskDetailReviewRequest, 'filePath' | 'requestOptions'>;
  } | null;
  closeTaskDetailReviewActivationFailure: (nonce: string) => void;
  retryTaskDetailReviewActivationFailure: (nonce: string) => boolean;
  retryPendingTaskDetailReview: (nonce: string) => boolean;
  closePendingTaskDetailReview: (nonce: string) => void;
  openTaskDetailReview: (
    identity: TaskDetailIdentity,
    options: Pick<TaskDetailReviewRequest, 'filePath' | 'requestOptions'>
  ) => boolean;
  taskDetailEditorActivationFailure: {
    nonce: string;
    identity: TaskDetailIdentity;
    intent: TaskDetailEditorIntent;
  } | null;
  pendingTaskDetailEditorRequest: TaskDetailEditorRequest | null;
  setPendingTaskDetailEditorRequest: (request: TaskDetailEditorRequest | null) => void;
  openTaskDetailEditor: (identity: TaskDetailIdentity, intent: TaskDetailEditorIntent) => boolean;
  retryPendingTaskDetailEditor: (nonce: string) => boolean;
  closePendingTaskDetailEditor: (nonce: string) => void;
  closeTaskDetailEditorActivationFailure: (nonce: string) => void;
  retryTaskDetailEditorActivationFailure: (nonce: string) => boolean;
  taskDetailById: Record<string, TaskDetailReadEntry>;
  taskDetailSessionById: Record<string, TaskDetailSession>;
  setTaskDetailDeletionIntent: (
    identity: TaskDetailIdentity,
    intent: TaskDetailDeletionIntent,
    requestScope: Omit<TaskDetailReadScope, 'teamName'>
  ) => boolean;
  taskDetailSurfaceInterests: Record<string, TaskDetailIdentity | null>;
  ensureTaskDetail: (identity: TaskDetailIdentity) => Promise<void>;
  setTaskDetailSurfaceInterest: (surfaceId: string, identity: TaskDetailIdentity | null) => void;
  applyTaskDetailSnapshot: (
    contextId: string,
    teamName: string,
    tasks: readonly TeamTaskWithKanban[],
    snapshotToken: TaskDetailReadToken
  ) => void;
  invalidateTaskDetailSource: (identity?: TaskDetailIdentity) => void;
  invalidateTaskDetailTeamSource: (contextId: string, teamName: string, taskId?: string) => void;
  clearTaskDetailTeamWork: (contextId: string, teamName: string) => void;
  retireTaskDetailSessionWork: (
    scope?: Pick<TaskDetailIdentity, 'contextId' | 'teamName'>,
    preservePendingAttachmentPreparation?: boolean
  ) => void;
  hydrateTaskDetailSessionDraft: (
    identity: TaskDetailIdentity,
    draft: {
      text?: string;
      commentChips?: TaskDetailSession['commentChips'];
      answerClarificationRequestId?: string | null;
    }
  ) => void;
  updateTaskDetailSession: (
    identity: TaskDetailIdentity,
    update: Partial<TaskDetailSession>
  ) => void;
  updateTaskDetailSessionPart: (
    identity: TaskDetailIdentity,
    part: TaskDetailEditPart,
    value: TaskDetailSession[
      | 'commentText'
      | 'commentChips'
      | 'pendingAttachments'
      | 'reply'
      | 'subjectDraft'
      | 'descriptionDraft']
  ) => void;
  beginTaskDetailSubmitSession: (
    identity: TaskDetailIdentity,
    request?: AddTaskCommentRequest
  ) => number;
  completeTaskDetailSubmitSession: (identity: TaskDetailIdentity, revision: number) => void;
  failTaskDetailSubmitSession: (
    identity: TaskDetailIdentity,
    revision: number,
    error: string,
    provenNoEffect?: boolean
  ) => void;
  beginTaskDetailSaveSession: (
    identity: TaskDetailIdentity,
    parts: readonly TaskDetailSavePart[]
  ) => TaskDetailSaveRevision;
  completeTaskDetailSaveSession: (
    identity: TaskDetailIdentity,
    revision: TaskDetailSaveRevision
  ) => void;
  failTaskDetailSaveSession: (
    identity: TaskDetailIdentity,
    revision: TaskDetailSaveRevision,
    error: string
  ) => void;
  beginTaskDetailPendingAttachmentSession: (
    identity: TaskDetailIdentity,
    attachment: TaskDetailSession['pendingAttachments'][number]
  ) => void;
  completeTaskDetailPendingAttachmentSession: (
    identity: TaskDetailIdentity,
    id: string,
    attachment: TaskDetailSession['pendingAttachments'][number]
  ) => void;
  ignoreTaskDetailPendingAttachmentSession: (identity: TaskDetailIdentity, id: string) => void;
  claimTaskDetailOwner: (identity: TaskDetailIdentity, surfaceId: string) => void;
  transferTaskDetailOwner: (
    identity: TaskDetailIdentity,
    fromSurfaceId: string,
    toSurfaceId: string,
    expectedOwnerRevision: number
  ) => void;
  releaseTaskDetailOwner: (
    identity: TaskDetailIdentity,
    surfaceId: string,
    expectedOwnerRevision: number
  ) => void;
  openTaskDetailTab: (identity: TaskDetailIdentity) => OpenTaskDetailTabResult | null;
}
