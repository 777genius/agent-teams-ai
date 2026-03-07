/**
 * Unified composer draft hook — atomic persistence of text + chips + attachments.
 *
 * Replaces the trio of `useDraftPersistence`, `useChipDraftPersistence`, and
 * `useAttachments` for the team `MessageComposer`.
 *
 * Key guarantees:
 * - Single IndexedDB key per team (`composer:<teamName>`), no TTL.
 * - Race-safe: late async load never overwrites fresh user input.
 * - Debounced writes with immediate flush on unmount and lifecycle transitions.
 * - Legacy migration from three-key format on first load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type ComposerDraftSnapshot,
  composerDraftStorage,
} from '@renderer/services/composerDraftStorage';
import {
  fileToAttachmentPayload,
  MAX_FILES,
  MAX_TOTAL_SIZE,
  validateAttachment,
} from '@renderer/utils/attachmentUtils';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { AttachmentPayload } from '@shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseComposerDraftResult {
  // Text
  text: string;
  setText: (v: string) => void;

  // Chips
  chips: InlineChip[];
  addChip: (chip: InlineChip) => void;
  removeChip: (chipId: string) => void;

  // Attachments
  attachments: AttachmentPayload[];
  attachmentError: string | null;
  canAddMore: boolean;
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  clearAttachmentError: () => void;
  handlePaste: (event: React.ClipboardEvent) => void;
  handleDrop: (event: React.DragEvent) => void;

  // Status
  isSaved: boolean;
  isLoaded: boolean;

  // Clear all
  clearDraft: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useComposerDraft(teamName: string): UseComposerDraftResult {
  const [text, setTextState] = useState('');
  const [chips, setChipsState] = useState<InlineChip[]>([]);
  const [attachments, setAttachmentsState] = useState<AttachmentPayload[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Refs for latest values — avoids stale closures in callbacks
  const textRef = useRef('');
  const chipsRef = useRef<InlineChip[]>([]);
  const attachmentsRef = useRef<AttachmentPayload[]>([]);
  const teamNameRef = useRef(teamName);
  const mountedRef = useRef(true);

  // Track whether user has interacted since last load to prevent race
  const userTouchedRef = useRef(false);

  // Debounce timer
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ teamName: string; snapshot: ComposerDraftSnapshot } | null>(null);

  // Keep teamNameRef in sync
  useEffect(() => {
    teamNameRef.current = teamName;
  }, [teamName]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Persist helpers
  // ---------------------------------------------------------------------------

  const buildSnapshot = useCallback((): ComposerDraftSnapshot => {
    return {
      version: 1,
      teamName: teamNameRef.current,
      text: textRef.current,
      chips: chipsRef.current,
      attachments: attachmentsRef.current,
      updatedAt: Date.now(),
    };
  }, []);

  const flushPending = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current != null) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      const isEmpty =
        pending.snapshot.text.length === 0 &&
        pending.snapshot.chips.length === 0 &&
        pending.snapshot.attachments.length === 0;
      if (isEmpty) {
        void composerDraftStorage.deleteSnapshot(pending.teamName);
      } else {
        void composerDraftStorage.saveSnapshot(pending.teamName, pending.snapshot);
      }
    }
  }, []);

  const scheduleSave = useCallback(() => {
    const snapshot = buildSnapshot();
    pendingRef.current = { teamName: teamNameRef.current, snapshot };

    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending == null) return;

      const isEmpty =
        pending.snapshot.text.length === 0 &&
        pending.snapshot.chips.length === 0 &&
        pending.snapshot.attachments.length === 0;
      if (isEmpty) {
        void composerDraftStorage.deleteSnapshot(pending.teamName);
        if (mountedRef.current) setIsSaved(true);
      } else {
        void composerDraftStorage.saveSnapshot(pending.teamName, pending.snapshot).then(() => {
          if (mountedRef.current) setIsSaved(true);
        });
      }
    }, DEBOUNCE_MS);
  }, [buildSnapshot]);

  // ---------------------------------------------------------------------------
  // Apply snapshot to state
  // ---------------------------------------------------------------------------

  const applySnapshot = useCallback((snap: ComposerDraftSnapshot) => {
    textRef.current = snap.text;
    chipsRef.current = snap.chips;
    attachmentsRef.current = snap.attachments;
    setTextState(snap.text);
    setChipsState(snap.chips);
    setAttachmentsState(snap.attachments);
  }, []);

  // ---------------------------------------------------------------------------
  // Load on mount / teamName change
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    flushPending();
    userTouchedRef.current = false;

    // Reset to empty for the new teamName.
    // Wrapped in queueMicrotask to avoid synchronous setState inside effect body.
    const empty = composerDraftStorage.emptySnapshot(teamName);
    queueMicrotask(() => {
      if (cancelled) return;
      applySnapshot(empty);
      setIsSaved(false);
      setIsLoaded(false);
      setAttachmentError(null);
    });

    void (async () => {
      // Try loading unified snapshot first
      let snapshot = await composerDraftStorage.loadSnapshot(teamName);

      // If none found, try legacy migration
      if (snapshot == null) {
        snapshot = await composerDraftStorage.migrateLegacy(teamName);
      }

      if (cancelled) return;

      // Race protection: if user already started typing, don't overwrite
      if (userTouchedRef.current) {
        if (mountedRef.current) setIsLoaded(true);
        return;
      }

      if (snapshot != null) {
        // Validate attachment limits
        const totalSize = snapshot.attachments.reduce((sum, a) => sum + a.size, 0);
        if (totalSize > MAX_TOTAL_SIZE || snapshot.attachments.length > MAX_FILES) {
          snapshot = { ...snapshot, attachments: [] };
        }

        applySnapshot(snapshot);
        setIsSaved(true);
      }

      if (mountedRef.current) setIsLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [teamName, flushPending, applySnapshot]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  // ---------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------

  const setText = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      textRef.current = v;
      setTextState(v);
      setIsSaved(false);
      scheduleSave();
    },
    [scheduleSave]
  );

  // ---------------------------------------------------------------------------
  // Chips
  // ---------------------------------------------------------------------------

  const addChip = useCallback(
    (chip: InlineChip) => {
      userTouchedRef.current = true;
      const next = [...chipsRef.current, chip];
      chipsRef.current = next;
      setChipsState(next);
      setIsSaved(false);
      scheduleSave();
    },
    [scheduleSave]
  );

  const removeChip = useCallback(
    (chipId: string) => {
      userTouchedRef.current = true;
      const next = chipsRef.current.filter((c) => c.id !== chipId);
      chipsRef.current = next;
      setChipsState(next);
      setIsSaved(false);
      scheduleSave();
    },
    [scheduleSave]
  );

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);
  const canAddMore = attachments.length < MAX_FILES && totalSize < MAX_TOTAL_SIZE;

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      userTouchedRef.current = true;
      setAttachmentError(null);
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;

      let batchSize = 0;
      for (const file of fileArray) {
        const validation = validateAttachment(file);
        if (!validation.valid) {
          setAttachmentError(validation.error);
          return;
        }
        batchSize += file.size;
      }

      const newPayloads: AttachmentPayload[] = [];
      for (const file of fileArray) {
        try {
          const payload = await fileToAttachmentPayload(file);
          newPayloads.push(payload);
        } catch {
          setAttachmentError(`Failed to read file: ${file.name}`);
          return;
        }
      }

      const prev = attachmentsRef.current;
      if (prev.length + newPayloads.length > MAX_FILES) {
        setAttachmentError(`Maximum ${MAX_FILES} attachments allowed`);
        return;
      }
      const currentTotal = prev.reduce((sum, a) => sum + a.size, 0);
      if (currentTotal + batchSize > MAX_TOTAL_SIZE) {
        setAttachmentError('Total attachment size exceeds 20MB limit');
        return;
      }

      const next = [...prev, ...newPayloads];
      attachmentsRef.current = next;
      setAttachmentsState(next);
      setIsSaved(false);
      scheduleSave();
    },
    [scheduleSave]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      userTouchedRef.current = true;
      const next = attachmentsRef.current.filter((a) => a.id !== id);
      attachmentsRef.current = next;
      setAttachmentsState(next);
      setAttachmentError(null);
      setIsSaved(false);
      scheduleSave();
    },
    [scheduleSave]
  );

  const clearAttachments = useCallback(() => {
    userTouchedRef.current = true;
    attachmentsRef.current = [];
    setAttachmentsState([]);
    setAttachmentError(null);
    setIsSaved(false);
    scheduleSave();
  }, [scheduleSave]);

  const clearAttachmentError = useCallback(() => {
    setAttachmentError(null);
  }, []);

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
        setAttachmentError('Only image files are supported');
      }
    },
    [addFiles]
  );

  // ---------------------------------------------------------------------------
  // Clear all
  // ---------------------------------------------------------------------------

  const clearDraft = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;

    textRef.current = '';
    chipsRef.current = [];
    attachmentsRef.current = [];

    setTextState('');
    setChipsState([]);
    setAttachmentsState([]);
    setAttachmentError(null);
    setIsSaved(false);

    void composerDraftStorage.deleteSnapshot(teamNameRef.current);
  }, []);

  return {
    text,
    setText,
    chips,
    addChip,
    removeChip,
    attachments,
    attachmentError,
    canAddMore,
    addFiles,
    removeAttachment,
    clearAttachments,
    clearAttachmentError,
    handlePaste,
    handleDrop,
    isSaved,
    isLoaded,
    clearDraft,
  };
}
