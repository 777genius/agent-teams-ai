import { MAX_FILES, MAX_TOTAL_SIZE } from '@renderer/utils/attachmentUtils';

import {
  contentIsEmpty,
  type PendingComposerDraftPersistence,
} from './persistComposerDraftBeforeHydration';

import type {
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerDraftRepository,
  ComposerEditorContext,
  PreparedComposerAttempt,
} from '@renderer/types/composerDraft';
import type { AttachmentPayload } from '@shared/types';

export interface LocalDraftState {
  readonly addressKey: string;
  readonly content: ComposerDraftContent;
  readonly editorContext: ComposerEditorContext;
}

export interface DraftMutationLease {
  readonly address: ComposerDraftAddress;
  readonly addressKey: string;
  readonly loadGeneration: number;
  readonly localEditCounter: number;
}

let localRevisionSerial = 0;

export function nextRevision(label: string): string {
  localRevisionSerial += 1;
  return `${label}:${Date.now().toString(36)}:${localRevisionSerial.toString(36)}`;
}

export function emptyContent(): ComposerDraftContent {
  return { text: '', chips: [], attachments: [], actionMode: 'do' };
}

export function validAttachments(attachments: readonly AttachmentPayload[]): boolean {
  return (
    attachments.length <= MAX_FILES &&
    attachments.reduce((sum, attachment) => sum + attachment.size, 0) <= MAX_TOTAL_SIZE
  );
}

export function canAddMoreAttachments(attachments: readonly AttachmentPayload[]): boolean {
  return (
    attachments.length < MAX_FILES &&
    attachments.reduce((sum, attachment) => sum + attachment.size, 0) < MAX_TOTAL_SIZE
  );
}

export async function preserveConflictedLocalEdit(
  repository: ComposerDraftRepository,
  pending: PendingComposerDraftPersistence,
  currentWorkingRevision: string
): Promise<void> {
  if (contentIsEmpty(pending.content)) return;
  const id = `local-edit:${encodeURIComponent(pending.addressKey)}:${pending.editCounter}`;
  const attempt: PreparedComposerAttempt = {
    attemptId: id,
    snapshot: { content: pending.content, editorContext: pending.editorContext },
    preparedRequest: {
      kind: 'local',
      teamName: pending.address.teamName,
      request: { member: '', text: pending.content.text },
    },
    createdAt: Date.now(),
  };
  const result = await repository.beginAttempt(
    pending.address,
    `stale:${currentWorkingRevision}`,
    attempt
  );
  if (result.kind === 'prepared') {
    await repository.settleAttempt(pending.address, id, {
      kind: 'not-sent',
      detail: 'A newer saved draft conflicted with this local edit.',
    });
  }
}
