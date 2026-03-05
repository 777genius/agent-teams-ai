import { useCallback, useEffect, useRef, useState } from 'react';

import { draftStorage } from '@renderer/services/draftStorage';
import {
  fileToAttachmentPayload,
  MAX_FILES,
  MAX_TOTAL_SIZE,
  validateAttachment,
} from '@renderer/utils/attachmentUtils';

import type { AttachmentPayload } from '@shared/types';

interface UseAttachmentsOptions {
  /** When provided, attachments are persisted to IndexedDB under this key. */
  persistenceKey?: string;
}

interface UseAttachmentsReturn {
  attachments: AttachmentPayload[];
  error: string | null;
  totalSize: number;
  canAddMore: boolean;
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
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
    if (!persistenceKey) return;

    let cancelled = false;
    // Flush any pending debounced save for the previous key before switching.
    flushPending();
    // Clear stale attachments from previous persistenceKey before loading
    attachmentsRef.current = [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync reset before async load
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

      let batchSize = 0;
      let valid = true;
      for (const file of fileArray) {
        const validation = validateAttachment(file);
        if (!validation.valid) {
          setError(validation.error);
          valid = false;
          break;
        }
        batchSize += file.size;
      }
      if (!valid) return;

      const newPayloads: AttachmentPayload[] = [];
      for (const file of fileArray) {
        try {
          const payload = await fileToAttachmentPayload(file);
          newPayloads.push(payload);
        } catch {
          setError(`Failed to read file: ${file.name}`);
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
        if (currentTotal + batchSize > MAX_TOTAL_SIZE) {
          setError('Total attachment size exceeds 20MB limit');
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

      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        event.preventDefault();
        void addFiles(imageFiles);
      }
    },
    [addFiles]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (!files?.length) return;

      const allFiles = Array.from(files);
      const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        void addFiles(imageFiles);
      } else if (allFiles.length > 0) {
        setError('Only image files are supported');
      }
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
    handlePaste,
    handleDrop,
  };
}
