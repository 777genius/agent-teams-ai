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
  fileToAgentAttachmentPayload,
  MAX_FILES,
  MAX_TOTAL_SIZE,
  validateAttachment,
  validateOptimizedImageTotal,
} from '@renderer/utils/attachmentUtils';
import { categorizeFile } from '@shared/constants/attachments';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { AgentActionMode, AttachmentPayload } from '@shared/types';

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

  // Action mode
  actionMode: AgentActionMode;
  setActionMode: (mode: AgentActionMode) => void;

  // Status
  isSaved: boolean;
  isLoaded: boolean;

  // Clear all
  clearDraft: () => void;
  hideDraftForPendingSend: (content: ComposerDraftContent) => void;
  finalizePendingSendClear: (
    teamNameOverride?: string,
    submittedContent?: ComposerDraftContent
  ) => void;
  restoreDraft: (content: ComposerDraftContent) => void;
}

export interface ComposerDraftContent {
  text: string;
  chips: InlineChip[];
  attachments: AttachmentPayload[];
  actionMode?: AgentActionMode;
  pendingSendId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 400;

function draftPayloadEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotMatchesContent(
  snapshot: ComposerDraftSnapshot | null,
  content: ComposerDraftContent
): boolean {
  if (snapshot == null) return false;
  if (content.pendingSendId != null) {
    return snapshot.pendingSendId === content.pendingSendId;
  }
  if (snapshot.text !== content.text) return false;
  if (content.actionMode != null && snapshot.actionMode !== content.actionMode) return false;
  return (
    draftPayloadEquals(snapshot.chips, content.chips) &&
    draftPayloadEquals(snapshot.attachments, content.attachments)
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useComposerDraft(teamName: string): UseComposerDraftResult {
  const [text, setTextState] = useState('');
  const [chips, setChipsState] = useState<InlineChip[]>([]);
  const [attachments, setAttachmentsState] = useState<AttachmentPayload[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [actionMode, setActionModeState] = useState<AgentActionMode>('do');
  const [isSaved, setIsSaved] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Refs for latest values — avoids stale closures in callbacks
  const textRef = useRef('');
  const chipsRef = useRef<InlineChip[]>([]);
  const attachmentsRef = useRef<AttachmentPayload[]>([]);
  const actionModeRef = useRef<AgentActionMode>('do');
  const teamNameRef = useRef(teamName);
  const mountedRef = useRef(true);

  // Track whether user has interacted since last load to prevent race
  const userTouchedRef = useRef(false);

  // Debounce timer
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ teamName: string; snapshot: ComposerDraftSnapshot } | null>(null);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistenceVersionRef = useRef(0);

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
      actionMode: actionModeRef.current,
      updatedAt: Date.now(),
    };
  }, []);

  const enqueuePersist = useCallback((operation: () => Promise<void>): Promise<void> => {
    const queued = persistQueueRef.current.catch(() => undefined).then(operation);
    persistQueueRef.current = queued.catch(() => undefined);
    return queued;
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
        void enqueuePersist(() => composerDraftStorage.deleteSnapshot(pending.teamName));
      } else {
        void enqueuePersist(() =>
          composerDraftStorage.saveSnapshot(pending.teamName, pending.snapshot)
        );
      }
    }
  }, [enqueuePersist]);

  const scheduleSave = useCallback(() => {
    const snapshot = buildSnapshot();
    pendingRef.current = { teamName: teamNameRef.current, snapshot };
    const persistenceVersion = ++persistenceVersionRef.current;

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
      const persist = enqueuePersist(() =>
        isEmpty
          ? composerDraftStorage.deleteSnapshot(pending.teamName)
          : composerDraftStorage.saveSnapshot(pending.teamName, pending.snapshot)
      );
      void persist.then(() => {
        if (mountedRef.current && persistenceVersionRef.current === persistenceVersion) {
          setIsSaved(true);
        }
      });
    }, DEBOUNCE_MS);
  }, [buildSnapshot, enqueuePersist]);

  // ---------------------------------------------------------------------------
  // Apply snapshot to state
  // ---------------------------------------------------------------------------

  const applySnapshot = useCallback((snap: ComposerDraftSnapshot) => {
    textRef.current = snap.text;
    chipsRef.current = snap.chips;
    attachmentsRef.current = snap.attachments;
    actionModeRef.current = snap.actionMode ?? 'do';
    setTextState(snap.text);
    setChipsState(snap.chips);
    setAttachmentsState(snap.attachments);
    setActionModeState(snap.actionMode ?? 'do');
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
  // Action mode
  // ---------------------------------------------------------------------------

  const setActionMode = useCallback(
    (mode: AgentActionMode) => {
      userTouchedRef.current = true;
      actionModeRef.current = mode;
      setActionModeState(mode);
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

      // Split: supported → attachments, unsupported → path prepended to text
      const supported: File[] = [];
      const unsupportedPaths: string[] = [];
      for (const f of fileArray) {
        if (categorizeFile(f) === 'unsupported') {
          let filePath = '';
          try {
            filePath = window.electronAPI.getPathForFile(f);
          } catch {
            // Clipboard files or non-Electron: no path available
          }
          if (filePath) {
            unsupportedPaths.push(filePath);
          } else {
            setAttachmentError(`Unsupported file: ${f.name}`);
          }
        } else {
          supported.push(f);
        }
      }

      // Prepend unsupported file paths to text (independent of attachment validation)
      if (unsupportedPaths.length > 0) {
        const prefix = unsupportedPaths.join('\n') + '\n';
        const current = textRef.current;
        setText(current ? prefix + current : prefix);
      }

      if (supported.length === 0) return;

      for (const file of supported) {
        const validation = validateAttachment(file);
        if (!validation.valid) {
          setAttachmentError(validation.error);
          return;
        }
      }

      const newPayloads: AttachmentPayload[] = [];
      for (const file of supported) {
        try {
          const payload = await fileToAgentAttachmentPayload(file);
          newPayloads.push(payload);
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : `Failed to read file: ${file.name}`;
          setAttachmentError(reason);
          return;
        }
      }

      const prev = attachmentsRef.current;
      if (prev.length + newPayloads.length > MAX_FILES) {
        setAttachmentError(`Maximum ${MAX_FILES} attachments allowed`);
        return;
      }
      const currentTotal = prev.reduce((sum, a) => sum + a.size, 0);
      const batchSize = newPayloads.reduce((sum, a) => sum + a.size, 0);
      if (currentTotal + batchSize > MAX_TOTAL_SIZE) {
        setAttachmentError('Total attachment size exceeds 20MB limit');
        return;
      }
      const optimizedImageTotal = validateOptimizedImageTotal([...prev, ...newPayloads]);
      if (!optimizedImageTotal.valid) {
        setAttachmentError(optimizedImageTotal.error);
        return;
      }

      const next = [...prev, ...newPayloads];
      attachmentsRef.current = next;
      setAttachmentsState(next);
      setIsSaved(false);
      scheduleSave();
    },
    [scheduleSave, setText]
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

  // ---------------------------------------------------------------------------
  // Clear all
  // ---------------------------------------------------------------------------

  const toSnapshot = useCallback((content: ComposerDraftContent): ComposerDraftSnapshot => {
    return {
      version: 1,
      teamName: teamNameRef.current,
      text: content.text,
      chips: content.chips,
      attachments: content.attachments,
      actionMode: content.actionMode ?? actionModeRef.current,
      ...(content.pendingSendId ? { pendingSendId: content.pendingSendId } : {}),
      updatedAt: Date.now(),
    };
  }, []);

  const clearDraft = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;

    textRef.current = '';
    chipsRef.current = [];
    attachmentsRef.current = [];
    // actionMode is intentionally NOT reset — it is "sticky" across sends

    setTextState('');
    setChipsState([]);
    setAttachmentsState([]);
    setAttachmentError(null);
    setIsSaved(false);

    ++persistenceVersionRef.current;
    const teamNameForDelete = teamNameRef.current;
    void enqueuePersist(() => composerDraftStorage.deleteSnapshot(teamNameForDelete));
  }, [enqueuePersist]);

  const hideDraftForPendingSend = useCallback(
    (content: ComposerDraftContent) => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;

      ++persistenceVersionRef.current;
      const teamNameForSave = teamNameRef.current;
      const snapshot = toSnapshot(content);
      void enqueuePersist(() => composerDraftStorage.saveSnapshot(teamNameForSave, snapshot));

      textRef.current = '';
      chipsRef.current = [];
      attachmentsRef.current = [];

      setTextState('');
      setChipsState([]);
      setAttachmentsState([]);
      setAttachmentError(null);
      setIsSaved(false);
    },
    [enqueuePersist, toSnapshot]
  );

  const deleteSubmittedSnapshotIfCurrent = useCallback(
    (teamNameForDelete: string, submittedContent?: ComposerDraftContent) =>
      enqueuePersist(async () => {
        if (submittedContent != null) {
          await composerDraftStorage.deleteSnapshotIfMatches(teamNameForDelete, (snapshot) =>
            snapshotMatchesContent(snapshot, submittedContent)
          );
          return;
        }
        await composerDraftStorage.deleteSnapshot(teamNameForDelete);
      }),
    [enqueuePersist]
  );

  const finalizePendingSendClear = useCallback(
    (teamNameOverride?: string, submittedContent?: ComposerDraftContent) => {
      const currentTeamName = teamNameRef.current;
      const teamNameForPersist = teamNameOverride ?? currentTeamName;
      const isCurrentTeam = teamNameForPersist === currentTeamName;

      if (!isCurrentTeam) {
        void deleteSubmittedSnapshotIfCurrent(teamNameForPersist, submittedContent);
        return;
      }

      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      const persistenceVersion = ++persistenceVersionRef.current;

      const isEmpty =
        textRef.current.length === 0 &&
        chipsRef.current.length === 0 &&
        attachmentsRef.current.length === 0;
      if (isEmpty) {
        void deleteSubmittedSnapshotIfCurrent(teamNameForPersist, submittedContent);
        setIsSaved(false);
        return;
      }

      const snapshot = buildSnapshot();
      void enqueuePersist(() =>
        composerDraftStorage.saveSnapshot(teamNameForPersist, snapshot)
      ).then(() => {
        if (mountedRef.current && persistenceVersionRef.current === persistenceVersion) {
          setIsSaved(true);
        }
      });
    },
    [buildSnapshot, deleteSubmittedSnapshotIfCurrent, enqueuePersist]
  );

  const restoreDraft = useCallback(
    (content: ComposerDraftContent) => {
      userTouchedRef.current = true;
      const snapshot = toSnapshot(content);
      applySnapshot(snapshot);
      setAttachmentError(null);
      setIsSaved(false);
      scheduleSave();
    },
    [applySnapshot, scheduleSave, toSnapshot]
  );

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
    actionMode,
    setActionMode,
    isSaved,
    isLoaded,
    clearDraft,
    hideDraftForPendingSend,
    finalizePendingSendClear,
    restoreDraft,
  };
}
