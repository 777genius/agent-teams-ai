import type {
  TaskDetailEditPart,
  TaskDetailPartRevisions,
  TaskDetailSavePart,
  TaskDetailSession,
  TaskDetailSubmitPart,
} from '../../contracts';

const zeroPartRevisions = (): TaskDetailPartRevisions => ({
  commentText: 0,
  commentChips: 0,
  pendingAttachments: 0,
  reply: 0,
  subject: 0,
  description: 0,
});

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
  partRevisions: zeroPartRevisions(),
  submitRevision: 0,
  submittedPartRevisions: null,
  saveRevision: 0,
  savedPartRevisions: null,
  inlineEditOwnerSurfaceId: null,
  ownerSurfaceId: null,
  ownerRevision: 0,
};

function partForUpdate(part: TaskDetailEditPart, session: TaskDetailSession): TaskDetailSession {
  return {
    ...session,
    partRevisions: {
      ...session.partRevisions,
      [part]: session.partRevisions[part] + 1,
    },
    editRevision: session.editRevision + 1,
  };
}

export function touchTaskDetailPart(
  session: TaskDetailSession,
  part: TaskDetailEditPart
): TaskDetailSession {
  const next = partForUpdate(part, session);
  return {
    ...next,
    ...(part === 'subject' ? { editingSubject: true } : {}),
    ...(part === 'description' ? { editingDescription: true } : {}),
  };
}

export function updateTaskDetailPart(
  session: TaskDetailSession,
  part: TaskDetailEditPart,
  value: unknown
): TaskDetailSession {
  const next = partForUpdate(part, session);
  return {
    ...next,
    ...(part === 'commentText' ? { commentText: value as string } : {}),
    ...(part === 'subject' ? { subjectDraft: value as string, editingSubject: true } : {}),
    ...(part === 'description'
      ? { descriptionDraft: value as string, editingDescription: true }
      : {}),
  };
}

function revisionsFor(
  session: TaskDetailSession,
  parts: readonly TaskDetailEditPart[]
): Partial<Record<TaskDetailEditPart, number>> {
  return Object.fromEntries(parts.map((part) => [part, session.partRevisions[part]]));
}

export function beginTaskDetailSubmit(
  session: TaskDetailSession,
  contentSnapshot: Pick<
    TaskDetailSession,
    'commentText' | 'commentChips' | 'pendingAttachments' | 'reply'
  >
): TaskDetailSession {
  void contentSnapshot;
  return {
    ...session,
    submitRevision: session.submitRevision + 1,
    submittedPartRevisions: revisionsFor(session, [
      'commentText',
      'commentChips',
      'pendingAttachments',
      'reply',
    ]) as Partial<Record<TaskDetailSubmitPart, number>>,
  };
}

export function completeTaskDetailSubmit(
  session: TaskDetailSession,
  submittedRevision: number
): TaskDetailSession {
  if (session.submitRevision !== submittedRevision || !session.submittedPartRevisions) {
    return session;
  }
  const parts: TaskDetailSubmitPart[] = [
    'commentText',
    'commentChips',
    'pendingAttachments',
    'reply',
  ];
  const submittedPartRevisions = session.submittedPartRevisions;
  const clearParts = new Set(
    parts.filter((part) => session.partRevisions[part] === submittedPartRevisions[part])
  );
  if (clearParts.size === 0) return session;
  return {
    ...session,
    commentText: clearParts.has('commentText') ? '' : session.commentText,
    commentChips: clearParts.has('commentChips') ? [] : session.commentChips,
    pendingAttachments: clearParts.has('pendingAttachments') ? [] : session.pendingAttachments,
    reply: clearParts.has('reply') ? null : session.reply,
    editRevision: session.editRevision + 1,
    submittedPartRevisions: null,
  };
}

export function beginTaskDetailSave(
  session: TaskDetailSession,
  parts: readonly TaskDetailSavePart[]
): TaskDetailSession {
  return {
    ...session,
    saveRevision: session.saveRevision + 1,
    savedPartRevisions: revisionsFor(session, parts) as Partial<Record<TaskDetailSavePart, number>>,
  };
}

export function completeTaskDetailSave(
  session: TaskDetailSession,
  savedRevision: number
): TaskDetailSession {
  if (session.saveRevision !== savedRevision || !session.savedPartRevisions) return session;
  return {
    ...session,
    savedPartRevisions: null,
    editingSubject:
      session.partRevisions.subject === session.savedPartRevisions.subject
        ? false
        : session.editingSubject,
    editingDescription:
      session.partRevisions.description === session.savedPartRevisions.description
        ? false
        : session.editingDescription,
    editRevision: session.editRevision + 1,
  };
}

export function claimTaskDetailOwner(
  session: TaskDetailSession,
  surfaceId: string
): TaskDetailSession {
  if (session.ownerSurfaceId === surfaceId) return session;
  if (session.ownerSurfaceId !== null) return session;
  return {
    ...session,
    ownerSurfaceId: surfaceId,
    ownerRevision: session.ownerRevision + 1,
  };
}

export function transferTaskDetailOwner(
  session: TaskDetailSession,
  fromSurfaceId: string,
  toSurfaceId: string,
  expectedOwnerRevision: number
): TaskDetailSession {
  if (
    session.ownerSurfaceId !== fromSurfaceId ||
    session.ownerRevision !== expectedOwnerRevision ||
    fromSurfaceId === toSurfaceId
  ) {
    return session;
  }
  return {
    ...session,
    ownerSurfaceId: toSurfaceId,
    ownerRevision: session.ownerRevision + 1,
  };
}

export function releaseTaskDetailOwner(
  session: TaskDetailSession,
  surfaceId: string,
  expectedOwnerRevision: number
): TaskDetailSession {
  if (session.ownerSurfaceId !== surfaceId || session.ownerRevision !== expectedOwnerRevision) {
    return session;
  }
  return {
    ...session,
    ownerSurfaceId: null,
    ownerRevision: session.ownerRevision + 1,
  };
}
