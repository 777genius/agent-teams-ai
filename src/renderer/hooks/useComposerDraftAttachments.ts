import { useCallback, useState } from 'react';

import {
  fileToAgentAttachmentPayload,
  MAX_FILES,
  MAX_TOTAL_SIZE,
  validateAttachment,
  validateOptimizedImageTotal,
} from '@renderer/utils/attachmentUtils';
import { categorizeFile } from '@shared/constants/attachments';

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
  readonly editContent: (
    update: (content: ComposerDraftContent) => ComposerDraftContent
  ) => void;
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
      const supported: File[] = [];
      const unsupportedPaths: string[] = [];
      for (const file of Array.from(files)) {
        if (categorizeFile(file) !== 'unsupported') {
          supported.push(file);
          continue;
        }
        try {
          const path = window.electronAPI.getPathForFile(file);
          if (path) unsupportedPaths.push(path);
          else setAttachmentError(`Unsupported file: ${file.name}`);
        } catch {
          setAttachmentError(`Unsupported file: ${file.name}`);
        }
      }
      for (const file of supported) {
        const validation = validateAttachment(file);
        if (!validation.valid) {
          setAttachmentError(validation.error);
          return;
        }
      }
      const payloads: AttachmentPayload[] = [];
      try {
        for (const file of supported) payloads.push(await fileToAgentAttachmentPayload(file));
      } catch (error) {
        if (identityIsCurrent(identity)) {
          setAttachmentError(error instanceof Error ? error.message : 'Failed to read attachment.');
        }
        return;
      }
      if (!identityIsCurrent(identity) || !canMutate()) return;
      editContent((content) => {
        const textPrefix = unsupportedPaths.length ? `${unsupportedPaths.join('\n')}\n` : '';
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
        const optimized = validateOptimizedImageTotal(attachments);
        if (!optimized.valid) {
          setAttachmentError(optimized.error);
          return content;
        }
        return {
          ...content,
          text: textPrefix ? `${textPrefix}${content.text}` : content.text,
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
