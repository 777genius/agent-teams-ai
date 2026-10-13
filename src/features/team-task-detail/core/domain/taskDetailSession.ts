import type { TaskDetailSession } from '../../contracts';

export const EMPTY_TASK_DETAIL_SESSION: TaskDetailSession = {
  commentText: '',
  commentChips: [],
  pendingAttachments: [],
  reply: null,
  subjectDraft: '',
  descriptionDraft: '',
  editingSubject: false,
  editingDescription: false,
  editRevision: 0,
  submitRevision: 0,
  inlineEditOwnerSurfaceId: null,
};

export function touchTaskDetailPart(
  session: TaskDetailSession,
  part: 'comment' | 'subject' | 'description'
): TaskDetailSession {
  return {
    ...session,
    editRevision: session.editRevision + 1,
    ...(part === 'subject' ? { editingSubject: true } : {}),
    ...(part === 'description' ? { editingDescription: true } : {}),
  };
}

export function beginTaskDetailSubmit(
  session: TaskDetailSession,
  contentSnapshot: Pick<
    TaskDetailSession,
    'commentText' | 'commentChips' | 'pendingAttachments' | 'reply'
  >
): TaskDetailSession {
  void contentSnapshot;
  return { ...session, submitRevision: session.submitRevision + 1 };
}

export function completeTaskDetailSubmit(
  session: TaskDetailSession,
  submittedRevision: number,
  contentSnapshot: Pick<
    TaskDetailSession,
    'commentText' | 'commentChips' | 'pendingAttachments' | 'reply'
  >
): TaskDetailSession {
  if (session.submitRevision !== submittedRevision) return session;
  const unchanged =
    session.commentText === contentSnapshot.commentText &&
    JSON.stringify(session.commentChips) === JSON.stringify(contentSnapshot.commentChips) &&
    JSON.stringify(session.pendingAttachments) ===
      JSON.stringify(contentSnapshot.pendingAttachments) &&
    JSON.stringify(session.reply) === JSON.stringify(contentSnapshot.reply);
  if (!unchanged) return session;
  return {
    ...session,
    commentText: '',
    commentChips: [],
    pendingAttachments: [],
    reply: null,
    editRevision: session.editRevision + 1,
  };
}

export function adoptTaskDetailDraft(
  session: TaskDetailSession,
  part: 'comment' | 'subject' | 'description',
  value: string,
  expectedRevision: number
): TaskDetailSession {
  if (session.editRevision !== expectedRevision) return session;
  return {
    ...session,
    ...(part === 'comment' ? { commentText: value } : {}),
    ...(part === 'subject' ? { subjectDraft: value } : {}),
    ...(part === 'description' ? { descriptionDraft: value } : {}),
    editRevision: session.editRevision + 1,
  };
}
