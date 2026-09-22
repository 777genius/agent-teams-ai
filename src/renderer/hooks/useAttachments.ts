import { useCallback, useEffect, useRef, useState } from 'react';

import { draftStorage } from '@renderer/services/draftStorage';
import {
  fileToAgentAttachmentPayload,
  MAX_FILES,
  MAX_TOTAL_SIZE,
  validateAttachment,
  validateOptimizedImageTotal,
} from '@renderer/utils/attachmentUtils';
import { categorizeFile } from '@shared/constants/attachments';

import type { AttachmentPayload } from '@shared/types';

interface UseAttachmentsOptions {
  /** When provided, attachments are persisted to IndexedDB under this key. */
  persistenceKey?: string;
  /** Called with unsupported files so the consumer can handle them (e.g. insert paths into text). */
  onUnsupportedFiles?: (files: File[]) => void;
}

interface UseAttachmentsReturn {
  attachments: AttachmentPayload[];
  error: string | null;
  totalSize: number;
  canAddMore: boolean;
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  clearError: () => void;
  handlePaste: (event: React.ClipboardEvent) => void;
  handleDrop: (event: React.DragEvent) => void;
}

const DEBOUNCE_MS = 500;

function isValidAttachmentArray(data: unknown): data is AttachmentPayload[] {
  if (!Array.isArray(data)) return false;
  return data.every((raw) => {
    if (typeof raw !== 'object' || raw === null) return false;
    const item = raw as Record<string, unknown>;
    return (
      typeof item.id === 'string' &&
      typeof item.filename === 'string' &&
      typeof item.mimeType === 'string' &&
      typeof item.size === 'number' &&
      typeof item.data === 'string'
    );
  });
}

export function useAttachments(options?: UseAttachmentsOptions): UseAttachmentsReturn {
  const persistenceKey = options?.persistenceKey;

  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [error, setError] = useState<string | null>(null);

  const attachmentsRef = useRef<AttachmentPayload[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ key: string; value: AttachmentPayload[] } | null>(null);
  const keyRef = useRef(persistenceKey);
  // eslint-disable-next-line react-hooks/refs -- synchronous ref sync during render is intentional to avoid stale key in callbacks
  keyRef.current = persistenceKey;
  const onUnsupportedRef = useRef(options?.onUnsupportedFiles);
  // eslint-disable-next-line react-hooks/refs -- synchronous ref sync during render is intentional to avoid stale callback in handlers
  onUnsupportedRef.current = options?.onUnsupportedFiles;

  // Sync ref with state
  const updateAttachments = useCallback((next: AttachmentPayload[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  // Persist helper — schedule debounced save
  const schedulePersist = useCallback((nextAttachments: AttachmentPayload[]) => {
    const key = keyRef.current;
    if (!key) return;

    pendingRef.current = { key, value: nextAttachments };

    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending == null) return;

      if (pending.value.length === 0) {
        void draftStorage.deleteDraft(pending.key);
      } else {
        void draftStorage.saveDraft(pending.key, JSON.stringify(pending.value));
      }
    }, DEBOUNCE_MS);
  }, []);

  const flushPending = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current != null) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending.value.length === 0) {
        void draftStorage.deleteDraft(pending.key);
      } else {
        void draftStorage.saveDraft(pending.key, JSON.stringify(pending.value));
      }
    }
  }, []);

  // Load persisted attachments on mount
  useEffect(() => {
    if (!persistenceKey) {
      // Transitioning to non-persistent context: flush pending save and clear stale state
      flushPending();
      attachmentsRef.current = [];
      setAttachments([]);
      return;
    }

    let cancelled = false;
    // Flush any pending debounced save for the previous key before switching.
    flushPending();
    // Clear stale attachments from previous persistenceKey before loading
    attachmentsRef.current = [];
    setAttachments([]);
    void (async () => {
      const raw = await draftStorage.loadDraft(persistenceKey);
      if (cancelled || raw == null) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isValidAttachmentArray(parsed)) {
          // Verify total size is still within limits
          const total = parsed.reduce((sum, a) => sum + a.size, 0);
          if (total <= MAX_TOTAL_SIZE && parsed.length <= MAX_FILES) {
            attachmentsRef.current = parsed;
            setAttachments(parsed);
          } else {
            // Stored data exceeds limits — discard
            void draftStorage.deleteDraft(persistenceKey);
          }
        }
      } catch {
        // Invalid JSON — ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistenceKey, flushPending]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);
  const canAddMore = attachments.length < MAX_FILES && totalSize < MAX_TOTAL_SIZE;

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      setError(null);
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;

      // Split: supported → attachments, unsupported → callback or error
      const supported: File[] = [];
      const unsupported: File[] = [];
      for (const f of fileArray) {
        if (categorizeFile(f) === 'unsupported') {
          unsupported.push(f);
        } else {
          supported.push(f);
        }
      }

      if (unsupported.length > 0) {
        if (onUnsupportedRef.current) {
          onUnsupportedRef.current(unsupported);
        } else {
          setError(`Unsupported file type: ${unsupported[0].name}`);
        }
      }

      if (supported.length === 0) return;

      let valid = true;
      for (const file of supported) {
        const validation = validateAttachment(file);
        if (!validation.valid) {
          setError(validation.error);
          valid = false;
          break;
        }
      }
      if (!valid) return;

      const newPayloads: AttachmentPayload[] = [];
      for (const file of supported) {
        try {
          const payload = await fileToAgentAttachmentPayload(file);
          newPayloads.push(payload);
        } catch (error) {
          setError(error instanceof Error ? error.message : `Failed to read file: ${file.name}`);
          valid = false;
          break;
        }
      }
      if (!valid) return;

      setAttachments((prev) => {
        if (prev.length + newPayloads.length > MAX_FILES) {
          setError(`Maximum ${MAX_FILES} attachments allowed`);
          return prev;
        }
        const currentTotal = prev.reduce((sum, a) => sum + a.size, 0);
        const batchSize = newPayloads.reduce((sum, a) => sum + a.size, 0);
        if (currentTotal + batchSize > MAX_TOTAL_SIZE) {
          setError('Total attachment size exceeds 20MB limit');
          return prev;
        }
        const optimizedImageTotal = validateOptimizedImageTotal([...prev, ...newPayloads]);
        if (!optimizedImageTotal.valid) {
          setError(optimizedImageTotal.error);
          return prev;
        }
        const next = [...prev, ...newPayloads];
        attachmentsRef.current = next;
        schedulePersist(next);
        return next;
      });
    },
    [schedulePersist]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const next = prev.filter((a) => a.id !== id);
        attachmentsRef.current = next;
        schedulePersist(next);
        return next;
      });
      setError(null);
    },
    [schedulePersist]
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const clearAttachments = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    attachmentsRef.current = [];
    updateAttachments([]);
    setError(null);
    const key = keyRef.current;
    if (key) {
      void draftStorage.deleteDraft(key);
    }
  }, [updateAttachments]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const pastedFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }

      if (pastedFiles.length > 0) {
        event.preventDefault();
        void addFiles(pastedFiles);
      }
    },
    [addFiles]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      void addFiles(Array.from(files));
    },
    [addFiles]
  );

  return {
    attachments,
    error,
    totalSize,
    canAddMore,
    addFiles,
    removeAttachment,
    clearAttachments,
    clearError,
    handlePaste,
    handleDrop,
  };
}
