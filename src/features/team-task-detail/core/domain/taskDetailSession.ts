import type {
  TaskDetailEditPart,
  TaskDetailPartRevisions,
  TaskDetailSavePart,
  TaskDetailSaveRevision,
  TaskDetailSession,
  TaskDetailSubmitPart,
} from '../../contracts';
import type { AddTaskCommentRequest, TeamTask } from '@shared/types/team';

/** The first draft content captures its question; a later snapshot cannot rebind an unsent answer. */
export function taskDetailDraftClarificationRequestId(
  session: TaskDetailSession,
  task: Pick<TeamTask, 'needsClarification' | 'clarificationRequestId'> | null | undefined
): string | null | undefined {
  const hasContent = Boolean(session.commentText.trim() || session.commentChips.length ||
    session.pendingAttachments.length || session.reply);
  if (!hasContent) return undefined;
  if (session.answerClarificationRequestId !== undefined) return session.answerClarificationRequestId;
  return task?.needsClarification === 'user' ? task.clarificationRequestId ?? null : null;
}

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
  answerClarificationRequestId: undefined,
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
  saveRevisionByPart: { subject: 0, description: 0 },
  savedPartRevisionByPart: { subject: null, description: null },
  ownerSurfaceId: null,
  ownerRevision: 0,
  submitPending: false,
  submitError: null,
  saveErrorByPart: { subject: null, description: null },
  pendingAttachmentPreparationIds: [],
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
    ...(part === 'commentChips'
      ? { commentChips: value as TaskDetailSession['commentChips'] }
      : {}),
    ...(part === 'pendingAttachments'
      ? { pendingAttachments: value as TaskDetailSession['pendingAttachments'] }
      : {}),
    ...(part === 'reply' ? { reply: value as TaskDetailSession['reply'] } : {}),
    ...(part === 'subject' ? { subjectDraft: value as string, editingSubject: true } : {}),
    ...(part === 'description'
      ? { descriptionDraft: value as string, editingDescription: true }
      : {}),
  };
}

export function hydrateTaskDetailDraft(
  session: TaskDetailSession,
  draft: {
    text?: string;
    commentChips?: TaskDetailSession['commentChips'];
    answerClarificationRequestId?: string | null;
  }
): TaskDetailSession {
  // A draft is a single snapshot (content + clarification generation).
  // Never mix a late-hydrated A snapshot with an already-started B composer:
  // that could submit A's answer with B's ID and erroneously clear B.
  const localCompositionStarted =
    session.answerClarificationRequestId !== undefined ||
    session.partRevisions.commentText > 0 ||
    session.partRevisions.commentChips > 0 ||
    session.partRevisions.pendingAttachments > 0 ||
    session.partRevisions.reply > 0;
  if (localCompositionStarted &&
      (session.answerClarificationRequestId ?? null) !==
        (draft.answerClarificationRequestId ?? null)) {
    return session;
  }

  let next = session;
  if (draft.text && next.partRevisions.commentText === 0 && next.commentText === '') {
    next = updateTaskDetailPart(next, 'commentText', draft.text);
  }
  if (
    draft.commentChips &&
    draft.commentChips.length > 0 &&
    next.partRevisions.commentChips === 0 &&
    next.commentChips.length === 0
  ) {
    next = updateTaskDetailPart(next, 'commentChips', draft.commentChips);
  }
  // Existing text/chips belong to the original draft, never silently
  // rebind to whatever clarification happens to be current after hydration.
  if (next !== session && session.answerClarificationRequestId === undefined) {
    next = {
      ...next,
      answerClarificationRequestId: draft.answerClarificationRequestId ?? null,
    };
  }
  return next;
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
  >,
  request?: AddTaskCommentRequest
): TaskDetailSession {
  void contentSnapshot;
  const submittedPartRevisions = revisionsFor(session, [
    'commentText',
    'commentChips',
    'pendingAttachments',
    'reply',
  ]) as Partial<Record<TaskDetailSubmitPart, number>>;
  const commentIntent =
    session.commentIntent ??
    (request?.command
      ? {
          request: structuredClone(request),
          submittedPartRevisions,
        }
      : undefined);
  return {
    ...session,
    submitRevision: session.submitRevision + 1,
    submitPending: true,
    submitError: null,
    submittedPartRevisions: commentIntent?.submittedPartRevisions ?? submittedPartRevisions,
    ...(commentIntent ? { commentIntent } : {}),
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
  const nextPartRevisions = { ...session.partRevisions };
  for (const part of clearParts) nextPartRevisions[part] += 1;
  const commentText = clearParts.has('commentText') ? '' : session.commentText;
  const commentChips = clearParts.has('commentChips') ? [] : session.commentChips;
  const pendingAttachments = clearParts.has('pendingAttachments') ? [] : session.pendingAttachments;
  const reply = clearParts.has('reply') ? null : session.reply;
  // A changed part can still end up empty (e.g. the user removed an attachment
  // while sending). Do not retain a consumed request ID on an empty composer.
  const hasRemainingDraft = Boolean(commentText.trim() || commentChips.length ||
    pendingAttachments.length || reply);
  return {
    ...session,
    commentText,
    commentChips,
    pendingAttachments,
    reply,
    answerClarificationRequestId:
      hasRemainingDraft ? session.answerClarificationRequestId : undefined,
    partRevisions: nextPartRevisions,
    editRevision: session.editRevision + (clearParts.size > 0 ? 1 : 0),
    submittedPartRevisions: null,
    ...(session.commentIntent ? { commentIntent: undefined } : {}),
    submitPending: false,
    submitError: null,
  };
}

export function failTaskDetailSubmit(
  session: TaskDetailSession,
  submittedRevision: number,
  error: string,
  provenNoEffect = false
): TaskDetailSession {
  if (session.submitRevision !== submittedRevision || !session.submitPending) return session;
  return {
    ...session,
    submitPending: false,
    submitError: error,
    submittedPartRevisions: null,
    ...(provenNoEffect && session.commentIntent ? { commentIntent: undefined } : {}),
  };
}

export function beginTaskDetailSave(
  session: TaskDetailSession,
  parts: readonly TaskDetailSavePart[]
): TaskDetailSession {
  const saveRevisionByPart = { ...session.saveRevisionByPart };
  const savedPartRevisionByPart = { ...session.savedPartRevisionByPart };
  for (const part of parts) {
    saveRevisionByPart[part] += 1;
    savedPartRevisionByPart[part] = session.partRevisions[part];
  }
  return {
    ...session,
    saveRevisionByPart,
    savedPartRevisionByPart,
    saveErrorByPart: {
      subject: parts.includes('subject') ? null : session.saveErrorByPart.subject,
      description: parts.includes('description') ? null : session.saveErrorByPart.description,
    },
  };
}

export function completeTaskDetailSave(
  session: TaskDetailSession,
  savedRevision: Partial<Record<TaskDetailSavePart, number>>
): TaskDetailSession {
  let changed = false;
  let editingSubject = session.editingSubject;
  let editingDescription = session.editingDescription;
  const savedPartRevisionByPart = { ...session.savedPartRevisionByPart };
  const saveErrorByPart = { ...session.saveErrorByPart };
  for (const part of ['subject', 'description'] as const) {
    const revision = savedRevision[part];
    const savedPartRevision = savedPartRevisionByPart[part];
    if (
      revision === undefined ||
      revision !== session.saveRevisionByPart[part] ||
      savedPartRevision === null
    ) {
      continue;
    }
    changed = true;
    savedPartRevisionByPart[part] = null;
    saveErrorByPart[part] = null;
    if (session.partRevisions[part] === savedPartRevision) {
      if (part === 'subject') editingSubject = false;
      else editingDescription = false;
    }
  }
  if (!changed) return session;
  return {
    ...session,
    savedPartRevisionByPart,
    saveErrorByPart,
    editingSubject,
    editingDescription,
    editRevision: session.editRevision + 1,
  };
}

export function failTaskDetailSave(
  session: TaskDetailSession,
  savedRevision: TaskDetailSaveRevision,
  error: string
): TaskDetailSession {
  let changed = false;
  const savedPartRevisionByPart = { ...session.savedPartRevisionByPart };
  const saveErrorByPart = { ...session.saveErrorByPart };
  for (const part of ['subject', 'description'] as const) {
    const revision = savedRevision[part];
    if (
      revision === undefined ||
      revision !== session.saveRevisionByPart[part] ||
      savedPartRevisionByPart[part] === null
    ) {
      continue;
    }
    changed = true;
    savedPartRevisionByPart[part] = null;
    saveErrorByPart[part] = error;
  }
  return changed ? { ...session, savedPartRevisionByPart, saveErrorByPart } : session;
}

export function beginTaskDetailPendingAttachment(
  session: TaskDetailSession,
  attachment: TaskDetailSession['pendingAttachments'][number]
): TaskDetailSession {
  const attachmentId = attachment.id;
  if (session.pendingAttachments.some((current) => current.id === attachmentId)) return session;
  return {
    ...session,
    pendingAttachments: [...session.pendingAttachments, attachment],
    pendingAttachmentPreparationIds: [...session.pendingAttachmentPreparationIds, attachmentId],
    partRevisions: {
      ...session.partRevisions,
      pendingAttachments: session.partRevisions.pendingAttachments + 1,
    },
    editRevision: session.editRevision + 1,
  };
}

export function completeTaskDetailPendingAttachment(
  session: TaskDetailSession,
  attachmentId: string,
  attachment: TaskDetailSession['pendingAttachments'][number]
): TaskDetailSession {
  if (
    !session.pendingAttachmentPreparationIds.includes(attachmentId) ||
    attachment.id !== attachmentId
  ) {
    return session;
  }
  return {
    ...session,
    pendingAttachments: session.pendingAttachments.map((current) =>
      current.id === attachmentId ? attachment : current
    ),
    pendingAttachmentPreparationIds: session.pendingAttachmentPreparationIds.filter(
      (id) => id !== attachmentId
    ),
    partRevisions: {
      ...session.partRevisions,
      pendingAttachments: session.partRevisions.pendingAttachments + 1,
    },
    editRevision: session.editRevision + 1,
  };
}

export function ignoreTaskDetailPendingAttachment(
  session: TaskDetailSession,
  attachmentId: string
): TaskDetailSession {
  const hadPending =
    session.pendingAttachments.some((attachment) => attachment.id === attachmentId) ||
    session.pendingAttachmentPreparationIds.includes(attachmentId);
  if (!hadPending) return session;
  return {
    ...session,
    pendingAttachments: session.pendingAttachments.filter(
      (attachment) => attachment.id !== attachmentId
    ),
    pendingAttachmentPreparationIds: session.pendingAttachmentPreparationIds.filter(
      (id) => id !== attachmentId
    ),
    partRevisions: {
      ...session.partRevisions,
      pendingAttachments: session.partRevisions.pendingAttachments + 1,
    },
    editRevision: session.editRevision + 1,
  };
}

export function retireTaskDetailSessionWork(
  session: TaskDetailSession,
  preservePendingAttachmentPreparation = false
): TaskDetailSession {
  const savingSubject = session.savedPartRevisionByPart.subject !== null;
  const savingDescription = session.savedPartRevisionByPart.description !== null;
  if (
    session.ownerSurfaceId === null &&
    !session.submitPending &&
    !savingSubject &&
    !savingDescription &&
    session.pendingAttachmentPreparationIds.length === 0
  )
    return session;
  return {
    ...session,
    ownerSurfaceId: null,
    ownerRevision: session.ownerRevision + 1,
    submitPending: false,
    submitRevision: session.submitRevision + 1,
    submittedPartRevisions: null,
    saveRevisionByPart: {
      subject: session.saveRevisionByPart.subject + (savingSubject ? 1 : 0),
      description: session.saveRevisionByPart.description + (savingDescription ? 1 : 0),
    },
    savedPartRevisionByPart: { subject: null, description: null },
    pendingAttachments: preservePendingAttachmentPreparation
      ? session.pendingAttachments
      : session.pendingAttachments.filter(
          (attachment) => !session.pendingAttachmentPreparationIds.includes(attachment.id)
        ),
    pendingAttachmentPreparationIds: preservePendingAttachmentPreparation
      ? session.pendingAttachmentPreparationIds
      : [],
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
