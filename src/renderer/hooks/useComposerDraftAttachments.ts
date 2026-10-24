import { useCallback, useState } from 'react';

import {
  fileToAgentAttachmentPayload,
  MAX_FILES,
  MAX_TOTAL_SIZE,
  validateAttachment,
  validateOptimizedImageTotal,
} from '@renderer/utils/attachmentUtils';

import type { LocalDraftState } from './composerDraftLocal';
import type { ComposerDraftAddress, ComposerDraftContent } from '@renderer/types/composerDraft';
import type { AttachmentPayload } from '@shared/types';

interface AttachmentOperationIdentity {
  readonly address: ComposerDraftAddress;
  readonly addressKey: string;
  readonly loadGeneration: number;
}

interface UseComposerDraftAttachmentsOptions {
  readonly canMutate: () => boolean;
  readonly captureIdentity: () => AttachmentOperationIdentity;
  readonly identityIsCurrent: (identity: AttachmentOperationIdentity) => boolean;
  readonly editContent: (update: (content: ComposerDraftContent) => ComposerDraftContent) => void;
}

export function useComposerDraftAttachments({
  canMutate,
  captureIdentity,
  identityIsCurrent,
  editContent,
}: UseComposerDraftAttachmentsOptions): {
  readonly attachmentError: string | null;
  readonly addFiles: (files: FileList | File[]) => Promise<void>;
  readonly clearAttachmentError: () => void;
  readonly handlePaste: (event: React.ClipboardEvent) => void;
  readonly handleDrop: (event: React.DragEvent) => void;
} {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const addFiles = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      if (!canMutate()) return;
      const identity = captureIdentity();
      setAttachmentError(null);
      const supported = Array.from(files);
      for (const file of supported) {
        const validation = validateAttachment(file, true);
        if (!validation.valid) {
          setAttachmentError(validation.error);
          return;
        }
      }
      const payloads: AttachmentPayload[] = [];
      try {
        for (const file of supported) payloads.push(await fileToAgentAttachmentPayload(file, true));
      } catch (error) {
        if (identityIsCurrent(identity)) {
          setAttachmentError(error instanceof Error ? error.message : 'Failed to read attachment.');
        }
        return;
      }
      if (!identityIsCurrent(identity) || !canMutate()) return;
      editContent((content) => {
        const attachments = [...content.attachments, ...payloads];
        if (attachments.length > MAX_FILES) {
          setAttachmentError(`Maximum ${MAX_FILES} attachments allowed`);
          return content;
        }
        const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
        if (total > MAX_TOTAL_SIZE) {
          setAttachmentError('Total attachment size exceeds 20MB limit');
          return content;
        }
        const optimized = validateOptimizedImageTotal(attachments, true);
        if (!optimized.valid) {
          setAttachmentError(optimized.error);
          return content;
        }
        return {
          ...content,
          attachments,
        };
      });
    },
    [canMutate, captureIdentity, editContent, identityIsCurrent]
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent): void => {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file != null);
      if (files.length) {
        event.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles]
  );
  const handleDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer.files.length) void addFiles(Array.from(event.dataTransfer.files));
    },
    [addFiles]
  );

  return {
    attachmentError,
    addFiles,
    clearAttachmentError: () => setAttachmentError(null),
    handlePaste,
    handleDrop,
  };
}

/** Clears share the same byte-read fence as address changes and accepted sends. */
export function useAttachmentDraftClear(
  options: {
    clearDraftContent: () => Promise<void>;
    clearAttachmentError: () => void;
    editContent: UseComposerDraftAttachmentsOptions['editContent'];
  },
  loadGenerationRef: { current: number }
): { clearDraft: () => Promise<void>; clearAttachments: () => void } {
  const { clearDraftContent, clearAttachmentError, editContent } = options;
  const clearDraft = useCallback(() => {
    loadGenerationRef.current++;
    return clearDraftContent();
  }, [clearDraftContent, loadGenerationRef]);
  const clearAttachments = useCallback(() => {
    loadGenerationRef.current++;
    clearAttachmentError();
    editContent((content) => ({ ...content, attachments: [] }));
  }, [clearAttachmentError, editContent, loadGenerationRef]);
  return { clearDraft, clearAttachments };
}

/** Content projection shared by attachment add/clear while the draft owns the full editor state. */
export function useComposerContentEdit(
  edit: (update: (state: LocalDraftState) => LocalDraftState) => void
): UseComposerDraftAttachmentsOptions['editContent'] {
  return useCallback(
    (update) => edit((current) => ({ ...current, content: update(current.content) })),
    [edit]
  );
}
