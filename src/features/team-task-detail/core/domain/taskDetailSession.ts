import type {
  TaskDetailEditPart,
  TaskDetailPartRevisions,
  TaskDetailSavePart,
  TaskDetailSaveRevision,
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
  draft: { text?: string; commentChips?: TaskDetailSession['commentChips'] }
): TaskDetailSession {
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
  >
): TaskDetailSession {
  void contentSnapshot;
  return {
    ...session,
    submitRevision: session.submitRevision + 1,
    submitPending: true,
    submitError: null,
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
  const nextPartRevisions = { ...session.partRevisions };
  for (const part of clearParts) nextPartRevisions[part] += 1;
  return {
    ...session,
    commentText: clearParts.has('commentText') ? '' : session.commentText,
    commentChips: clearParts.has('commentChips') ? [] : session.commentChips,
    pendingAttachments: clearParts.has('pendingAttachments') ? [] : session.pendingAttachments,
    reply: clearParts.has('reply') ? null : session.reply,
    partRevisions: nextPartRevisions,
    editRevision: session.editRevision + (clearParts.size > 0 ? 1 : 0),
    submittedPartRevisions: null,
    submitPending: false,
    submitError: null,
  };
}

export function failTaskDetailSubmit(
  session: TaskDetailSession,
  submittedRevision: number,
  error: string
): TaskDetailSession {
  if (session.submitRevision !== submittedRevision || !session.submitPending) return session;
  return {
    ...session,
    submitPending: false,
    submitError: error,
    submittedPartRevisions: null,
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
