import { EMPTY_TASK_DETAIL_SESSION } from '@features/team-task-detail/core/domain';
import { vi } from 'vitest';

import type { TaskDetailSessionController } from '@features/team-task-detail/renderer';

export function createTaskDetailSessionFixture(taskId: string): TaskDetailSessionController {
  return {
    identity: { contextId: 'local', teamName: 'team-a', taskId },
    surfaceId: 'TEST-dialog',
    session: { ...EMPTY_TASK_DETAIL_SESSION, ownerSurfaceId: 'TEST-dialog', ownerRevision: 1 },
    isOwner: true,
    canEditNow: () => true,
    isOriginCurrent: () => true,
    canSubmit: true,
    isDraftSaved: false,
    attachmentError: null,
    setCommentText: vi.fn(),
    setCommentChips: vi.fn(),
    addCommentChip: vi.fn(),
    removeCommentChip: vi.fn(),
    setReply: vi.fn(),
    addPendingFiles: vi.fn(async () => {}),
    removePendingAttachment: vi.fn(),
    clearAttachmentError: vi.fn(),
    submitComment: vi.fn(async () => {}),
    startEditSubject: vi.fn(),
    cancelEditSubject: vi.fn(),
    setSubjectDraft: vi.fn(),
    saveSubject: vi.fn(async () => {}),
    startEditDescription: vi.fn(),
    cancelEditDescription: vi.fn(),
    setDescriptionDraft: vi.fn(),
    saveDescription: vi.fn(async () => {}),
    openInTaskTab: vi.fn(() => false),
  };
}
