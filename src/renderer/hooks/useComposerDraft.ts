import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { composerDraftRepository } from '@renderer/services/composerDraftRepository';
import {
  composerDraftAddressKey,
  sameComposerDraftAddress,
} from '@renderer/utils/composerDraftIdentity';

import {
  canAddMoreAttachments,
  type DraftMutationLease,
  emptyContent,
  type LocalDraftState,
  nextRevision,
  preserveConflictedLocalEdit,
} from './composerDraftLocal';
import {
  loadWorkingAfterEvents,
  subscribeToComposerWorkingChanges,
} from './composerDraftWorkingSync';
import {
  contentEquals,
  contentIsEmpty,
  type PendingComposerDraftPersistence,
  persistComposerDraftBeforeHydration,
} from './persistComposerDraftBeforeHydration';
import { useComposerDraftApplyWorking } from './useComposerDraftApplyWorking';
import { useComposerDraftAttachments } from './useComposerDraftAttachments';
import { type ComposerAttemptRequest, useComposerDraftAttempt } from './useComposerDraftAttempt';
import { useComposerDraftClear } from './useComposerDraftClear';
import { useComposerDraftTextActions } from './useComposerDraftTextActions';

import type {
  BeginAttemptResult,
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerDraftRepository,
  ComposerEditorContext,
  ComposerPersistenceStatus,
  ComposerWorkingRecord,
  ComposerWorkingSummary,
  MessageRevisionContext,
  PreparedComposerAttempt,
  RestoreRecoveryResult,
} from '@renderer/types/composerDraft';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { AgentActionMode, AttachmentPayload } from '@shared/types';

export type { ComposerDraftContent } from '@renderer/types/composerDraft';
export interface ComposerBeginAttemptResult {
  readonly result: BeginAttemptResult;
  readonly address: ComposerDraftAddress;
  readonly attempt: PreparedComposerAttempt;
  readonly localEditCounter: number;
}

export interface UseComposerDraftResult {
  text: string;
  setText: (value: string) => void;
  chips: InlineChip[];
  addChip: (chip: InlineChip) => void;
  removeChip: (chipId: string) => void;
  attachments: AttachmentPayload[];
  attachmentError: string | null;
  canAddMore: boolean;
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  clearAttachmentError: () => void;
  handlePaste: (event: React.ClipboardEvent) => void;
  handleDrop: (event: React.DragEvent) => void;
  actionMode: AgentActionMode;
  setActionMode: (mode: AgentActionMode) => void;
  editorContext: ComposerEditorContext;
  revisionContext: MessageRevisionContext | null;
  setRevision: (context: MessageRevisionContext, content: ComposerDraftContent) => boolean;
  clearRevision: () => void;
  isSaved: boolean;
  isLoaded: boolean;
  isRestoring: boolean;
  persistenceStatus: ComposerPersistenceStatus;
  readError: string | null;
  address: ComposerDraftAddress;
  addressKey: string;
  renderedAddressKey: string;
  workingRevision: string;
  localEditCounter: number;
  loadGeneration: number;
  canSubmit: boolean;
  snapshot: () => ComposerDraftContent;
  clearDraft: () => Promise<void>;
  flush: () => Promise<void>;
  beginAttempt: (
    attemptId: string,
    prepareRequest: ComposerAttemptRequest
  ) => Promise<ComposerBeginAttemptResult | null>;
  stashWorking: () => Promise<RestoreRecoveryResult>;
  restoreRecovery: (
    sourceContextId: string,
    sourceTeamName: string,
    id: string,
    options?: { readonly asNewMessage?: boolean }
  ) => Promise<RestoreRecoveryResult>;
  moveWorkingAsNew: (summary: ComposerWorkingSummary) => Promise<RestoreRecoveryResult>;
  adoptWorking: (
    working: ComposerWorkingRecord,
    expected?: {
      readonly addressKey: string;
      readonly loadGeneration: number;
      readonly localEditCounter: number;
    }
  ) => boolean;
}

const DEBOUNCE_MS = 400;
export function useComposerDraft(
  address: ComposerDraftAddress,
  repository: ComposerDraftRepository = composerDraftRepository
): UseComposerDraftResult {
  const addressKey = composerDraftAddressKey(address);
  const [state, setState] = useState<LocalDraftState>(() => ({
    addressKey,
    content: emptyContent(),
    editorContext: { kind: 'plain' },
  }));
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [persistenceStatus, setPersistenceStatus] = useState<ComposerPersistenceStatus>('durable');
  const [readError, setReadError] = useState<string | null>(null);
  const addressRef = useRef(address);
  const addressKeyRef = useRef(addressKey);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const workingEventVersionRef = useRef(0);
  const localEditCounterRef = useRef(0);
  const workingRevisionRef = useRef('0');
  const hydratedRef = useRef(false);
  const restoringRef = useRef(false);
  const revisionByAddressRef = useRef(new Map<string, string>());
  const hydratedAddressKeysRef = useRef(new Set<string>());
  const latestEditByAddressRef = useRef(new Map<string, number>());
  const savedEditByAddressRef = useRef(new Map<string, number>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<PendingComposerDraftPersistence | null>(null);
  const syncPendingByAddressRef = useRef(new Map<string, Promise<void>>());
  const activePersistenceByAddressRef = useRef(new Map<string, number>());
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const attemptAddressKeyRef = useRef<string | null>(null);
  const heldAttemptSaveRef = useRef<NonNullable<typeof pendingSaveRef.current> | null>(null);
  addressRef.current = address;
  addressKeyRef.current = addressKey;
  stateRef.current = state;
  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const queued = persistQueueRef.current.catch(() => undefined).then(operation);
    persistQueueRef.current = queued.catch(() => undefined);
    return queued;
  }, []);
  const applyWorking = useComposerDraftApplyWorking({
    stateRef,
    workingRevisionRef,
    revisionByAddressRef,
    savedEditByAddressRef,
    latestEditByAddressRef,
    setState,
  });
  const persistPending = useCallback(
    async (pending: NonNullable<typeof pendingSaveRef.current>): Promise<void> => {
      activePersistenceByAddressRef.current.set(pending.addressKey, pending.editCounter);
      try {
        let sync = syncPendingByAddressRef.current.get(pending.addressKey);
        while (sync) {
          await sync;
          const next = syncPendingByAddressRef.current.get(pending.addressKey);
          if (next === sync) break;
          sync = next;
        }
        if (pending.editCounter !== latestEditByAddressRef.current.get(pending.addressKey)) return;
        const expectedRevision = revisionByAddressRef.current.get(pending.addressKey) ?? '0';
        const nextWorkingRevision = nextRevision(`edit:${pending.editCounter}`);
        const result = await repository.saveWorking(
          pending.address,
          expectedRevision,
          nextWorkingRevision,
          contentIsEmpty(pending.content) ? null : pending.content,
          pending.editorContext
        );
        setPersistenceStatus(result.status);
        if (result.kind === 'saved') {
          revisionByAddressRef.current.set(pending.addressKey, result.workingRevision);
          if (latestEditByAddressRef.current.get(pending.addressKey) === pending.editCounter)
            savedEditByAddressRef.current.set(pending.addressKey, pending.editCounter);
          if (pending.addressKey === addressKeyRef.current) {
            workingRevisionRef.current = result.workingRevision;
          }
          if (
            mountedRef.current &&
            pending.addressKey === addressKeyRef.current &&
            pending.editCounter === localEditCounterRef.current
          ) {
            setIsSaved(true);
          }
        } else if (result.kind === 'conflict') {
          await preserveConflictedLocalEdit(repository, pending, result.currentWorkingRevision);
        } else {
          setReadError(result.error);
        }
      } finally {
        if (activePersistenceByAddressRef.current.get(pending.addressKey) === pending.editCounter) {
          activePersistenceByAddressRef.current.delete(pending.addressKey);
        }
      }
    },
    [repository]
  );

  const persistBeforeHydration = useCallback(
    (pending: NonNullable<typeof pendingSaveRef.current>) =>
      persistComposerDraftBeforeHydration({
        repository,
        pending,
        nextWorkingRevision: nextRevision(`edit:${pending.editCounter}`),
        isLatest: () =>
          pending.editCounter === latestEditByAddressRef.current.get(pending.addressKey),
        preserveConflict: (revision) => preserveConflictedLocalEdit(repository, pending, revision),
      }),
    [repository]
  );

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) {
      const wasHydrated = hydratedAddressKeysRef.current.has(pending.addressKey);
      await enqueue(() =>
        wasHydrated ? persistPending(pending) : persistBeforeHydration(pending)
      );
    }
    await persistQueueRef.current.catch(() => undefined);
  }, [enqueue, persistBeforeHydration, persistPending]);

  const persistOrHold = useCallback(
    (pending: NonNullable<typeof pendingSaveRef.current>): void => {
      if (attemptAddressKeyRef.current === pending.addressKey) {
        heldAttemptSaveRef.current = pending;
        return;
      }
      void enqueue(() => persistPending(pending));
    },
    [enqueue, persistPending]
  );

  const scheduleSave = useCallback(
    (nextState: LocalDraftState): void => {
      const pending = {
        address: addressRef.current,
        addressKey: addressKeyRef.current,
        editCounter: localEditCounterRef.current,
        content: nextState.content,
        editorContext: nextState.editorContext,
      };
      pendingSaveRef.current = pending;
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (pendingSaveRef.current !== pending) return;
        if (!hydratedAddressKeysRef.current.has(pending.addressKey)) return;
        pendingSaveRef.current = null;
        persistOrHold(pending);
      }, DEBOUNCE_MS);
    },
    [persistOrHold]
  );

  const edit = useCallback(
    (update: (current: LocalDraftState) => LocalDraftState): void => {
      if (restoringRef.current) return;
      localEditCounterRef.current += 1;
      latestEditByAddressRef.current.set(addressKeyRef.current, localEditCounterRef.current);
      const base =
        stateRef.current.addressKey === addressKeyRef.current
          ? stateRef.current
          : {
              addressKey: addressKeyRef.current,
              content: emptyContent(),
              editorContext: { kind: 'plain' as const },
            };
      const next = update(base);
      stateRef.current = next;
      setState(next);
      setIsSaved(false);
      scheduleSave(next);
    },
    [scheduleSave]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(
    () =>
      subscribeToComposerWorkingChanges({
        repository,
        addressRef,
        addressKeyRef,
        mountedRef,
        hydratedRef,
        workingEventVersionRef,
        loadGenerationRef,
        localEditCounterRef,
        latestEditByAddressRef,
        savedEditByAddressRef,
        pendingSaveRef,
        heldAttemptSaveRef,
        activePersistenceByAddressRef,
        attemptAddressKeyRef,
        syncPendingByAddressRef,
        onClearedRevision: (key, revision) => {
          revisionByAddressRef.current.set(key, revision);
          workingRevisionRef.current = revision;
        },
        apply: (working, key, loaded) => {
          setPersistenceStatus(loaded.status);
          setReadError(loaded.readError ?? null);
          applyWorking(working, key);
          setIsSaved(working.content != null);
        },
      }),
    [applyWorking, repository]
  );

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    const loadAddress = addressRef.current;
    const loadAddressKey = addressKey;
    const isCurrentLoad = () =>
      mountedRef.current &&
      generation === loadGenerationRef.current &&
      loadAddressKey === addressKeyRef.current;
    hydratedRef.current = false;
    hydratedAddressKeysRef.current.delete(loadAddressKey);
    setIsLoaded(false);
    setIsSaved(false);
    setReadError(null);
    const editCounterAtStart = localEditCounterRef.current;
    const previousPending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (previousPending) {
      if (hydratedAddressKeysRef.current.has(previousPending.addressKey)) {
        persistOrHold(previousPending);
      } else {
        void enqueue(() => persistBeforeHydration(previousPending));
      }
    }
    stateRef.current = {
      addressKey: loadAddressKey,
      content: emptyContent(),
      editorContext: { kind: 'plain' },
    };
    setState(stateRef.current);

    void (async () => {
      await persistQueueRef.current;
      if (!isCurrentLoad()) return null;
      return loadWorkingAfterEvents(repository, loadAddress, workingEventVersionRef, isCurrentLoad);
    })().then(async (result) => {
      if (!result) return;
      while (isCurrentLoad() && result.observedVersion !== workingEventVersionRef.current)
        result = await loadWorkingAfterEvents(
          repository,
          loadAddress,
          workingEventVersionRef,
          isCurrentLoad
        );
      if (!isCurrentLoad()) return;
      const { loaded } = result;
      setPersistenceStatus(loaded.status);
      setReadError(loaded.readError ?? null);
      const editedWhileLoading = localEditCounterRef.current !== editCounterAtStart;
      hydratedRef.current = true;
      hydratedAddressKeysRef.current.add(loadAddressKey);
      workingRevisionRef.current = loaded.working.workingRevision;
      revisionByAddressRef.current.set(loadAddressKey, loaded.working.workingRevision);
      if (!editedWhileLoading) {
        applyWorking(loaded.working, loadAddressKey);
        setIsSaved(loaded.working.content != null);
      } else {
        const local = stateRef.current;
        if (
          loaded.working.content &&
          !contentIsEmpty(loaded.working.content) &&
          !contentEquals(loaded.working.content, local.content)
        ) {
          const displacedId = `displaced:${encodeURIComponent(loadAddressKey)}:${loaded.working.workingRevision}`;
          const stashed = await repository.stashWorking(
            loadAddress,
            loaded.working.workingRevision,
            displacedId
          );
          if (!isCurrentLoad()) return;
          if (stashed.kind === 'restored') {
            workingRevisionRef.current = stashed.working.workingRevision;
            revisionByAddressRef.current.set(loadAddressKey, stashed.working.workingRevision);
          } else {
            setReadError(
              'The existing saved draft could not be preserved. Your new edit remains in memory.'
            );
            return;
          }
        }
        const pending = pendingSaveRef.current;
        if (pending?.addressKey === loadAddressKey) {
          pendingSaveRef.current = null;
          await enqueue(() => persistPending(pending));
        }
      }
      if (mountedRef.current && generation === loadGenerationRef.current) setIsLoaded(true);
    });
  }, [
    addressKey,
    applyWorking,
    enqueue,
    persistBeforeHydration,
    persistOrHold,
    persistPending,
    repository,
  ]);
  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (pending) {
        if (hydratedAddressKeysRef.current.has(pending.addressKey)) persistOrHold(pending);
        else void persistBeforeHydration(pending);
      }
    },
    [persistBeforeHydration, persistOrHold]
  );

  const visibleState =
    state.addressKey === addressKey
      ? state
      : {
          addressKey,
          content: emptyContent(),
          editorContext: { kind: 'plain' as const },
        };
  const { content, editorContext } = visibleState;

  const { setText, addChip, removeChip, setActionMode } = useComposerDraftTextActions(edit);
  const editContent = useCallback(
    (update: (content: ComposerDraftContent) => ComposerDraftContent) =>
      edit((current) => ({ ...current, content: update(current.content) })),
    [edit]
  );
  const { attachmentError, addFiles, clearAttachmentError, handleDrop, handlePaste } =
    useComposerDraftAttachments({
      canMutate: () => !restoringRef.current,
      captureIdentity: () => ({
        address: addressRef.current,
        addressKey: addressKeyRef.current,
        loadGeneration: loadGenerationRef.current,
      }),
      identityIsCurrent: (identity) =>
        identity.loadGeneration === loadGenerationRef.current &&
        identity.addressKey === addressKeyRef.current &&
        sameComposerDraftAddress(identity.address, addressRef.current),
      editContent,
    });
  const removeAttachment = useCallback(
    (id: string) => {
      clearAttachmentError();
      edit((current) => ({
        ...current,
        content: {
          ...current.content,
          attachments: current.content.attachments.filter((attachment) => attachment.id !== id),
        },
      }));
    },
    [clearAttachmentError, edit]
  );
  const clearAttachments = useCallback(() => {
    clearAttachmentError();
    edit((current) => ({ ...current, content: { ...current.content, attachments: [] } }));
  }, [clearAttachmentError, edit]);

  const clearDraft = useComposerDraftClear({
    repository,
    flush,
    addressRef,
    addressKeyRef,
    localEditCounterRef,
    latestEditByAddressRef,
    savedEditByAddressRef,
    stateRef,
    workingRevisionRef,
    revisionByAddressRef,
    setState,
    setPersistenceStatus,
    setIsSaved,
  });

  const beginAttempt = useComposerDraftAttempt({
    repository,
    enqueue,
    persistPending,
    restoringRef,
    hydratedRef,
    stateRef,
    addressRef,
    addressKeyRef,
    loadGenerationRef,
    localEditCounterRef,
    latestEditByAddressRef,
    savedEditByAddressRef,
    attemptAddressKeyRef,
    pendingSaveRef,
    syncPendingByAddressRef,
    timerRef,
    persistQueueRef,
    revisionByAddressRef,
    mountedRef,
    workingRevisionRef,
    workingEventVersionRef,
    heldAttemptSaveRef,
    setPersistenceStatus,
    applyWorking,
    setState,
    setIsSaved,
  });
  const stashWorking = useCallback(async (): Promise<RestoreRecoveryResult> => {
    if (restoringRef.current) return { kind: 'active', status: persistenceStatus };
    const capturedAddress = addressRef.current;
    const capturedAddressKey = addressKeyRef.current;
    const capturedGeneration = loadGenerationRef.current;
    const capturedCounter = localEditCounterRef.current;
    restoringRef.current = true;
    setIsRestoring(true);
    try {
      await flush();
      const capturedRevision = revisionByAddressRef.current.get(capturedAddressKey) ?? '0';
      if (capturedCounter !== latestEditByAddressRef.current.get(capturedAddressKey)) {
        return { kind: 'conflict', status: persistenceStatus };
      }
      const result = await repository.stashWorking(
        capturedAddress,
        capturedRevision,
        `stash:${Date.now().toString(36)}:${capturedCounter}`
      );
      if (
        result.kind === 'restored' &&
        capturedAddressKey === addressKeyRef.current &&
        capturedGeneration === loadGenerationRef.current &&
        capturedCounter === localEditCounterRef.current
      ) {
        applyWorking(result.working, capturedAddressKey);
      }
      return result;
    } finally {
      restoringRef.current = false;
      if (mountedRef.current) setIsRestoring(false);
    }
  }, [applyWorking, flush, persistenceStatus, repository]);

  const restoreRecovery = useCallback(
    async (
      sourceContextId: string,
      sourceTeamName: string,
      id: string,
      options?: { readonly asNewMessage?: boolean }
    ): Promise<RestoreRecoveryResult> => {
      if (restoringRef.current || !hydratedRef.current) {
        return { kind: 'active', status: persistenceStatus };
      }
      restoringRef.current = true;
      setIsRestoring(true);
      const lease: DraftMutationLease = {
        address: addressRef.current,
        addressKey: addressKeyRef.current,
        localEditCounter: localEditCounterRef.current,
        loadGeneration: ++loadGenerationRef.current,
      };
      try {
        await flush();
        const expectedRevision = revisionByAddressRef.current.get(lease.addressKey) ?? '0';
        const result = await repository.restoreRecovery(
          sourceContextId,
          sourceTeamName,
          id,
          lease.address,
          expectedRevision,
          options
        );
        if (
          result.kind === 'restored' &&
          lease.addressKey === addressKeyRef.current &&
          lease.loadGeneration === loadGenerationRef.current &&
          lease.localEditCounter === localEditCounterRef.current &&
          expectedRevision === (revisionByAddressRef.current.get(lease.addressKey) ?? '0') &&
          sameComposerDraftAddress(lease.address, addressRef.current)
        ) {
          applyWorking(result.working, lease.addressKey);
        }
        return result;
      } finally {
        restoringRef.current = false;
        if (mountedRef.current) setIsRestoring(false);
      }
    },
    [applyWorking, flush, persistenceStatus, repository]
  );

  const moveWorkingAsNew = useCallback(
    async (summary: ComposerWorkingSummary): Promise<RestoreRecoveryResult> => {
      if (restoringRef.current || !hydratedRef.current) {
        return { kind: 'active', status: persistenceStatus };
      }
      restoringRef.current = true;
      setIsRestoring(true);
      const lease: DraftMutationLease = {
        address: addressRef.current,
        addressKey: addressKeyRef.current,
        localEditCounter: localEditCounterRef.current,
        loadGeneration: ++loadGenerationRef.current,
      };
      try {
        await flush();
        const expectedRevision = revisionByAddressRef.current.get(lease.addressKey) ?? '0';
        const result = await repository.moveWorkingAsNew(
          summary.address,
          summary.workingRevision,
          lease.address,
          expectedRevision
        );
        if (
          result.kind === 'restored' &&
          lease.addressKey === addressKeyRef.current &&
          lease.loadGeneration === loadGenerationRef.current &&
          lease.localEditCounter === localEditCounterRef.current &&
          expectedRevision === (revisionByAddressRef.current.get(lease.addressKey) ?? '0') &&
          sameComposerDraftAddress(lease.address, addressRef.current)
        ) {
          applyWorking(result.working, lease.addressKey);
        }
        return result;
      } finally {
        restoringRef.current = false;
        if (mountedRef.current) setIsRestoring(false);
      }
    },
    [applyWorking, flush, persistenceStatus, repository]
  );

  const setRevision = useCallback(
    (context: MessageRevisionContext, nextContent: ComposerDraftContent): boolean => {
      if (!hydratedRef.current || !contentIsEmpty(stateRef.current.content)) return false;
      edit(() => ({
        addressKey: addressKeyRef.current,
        content: nextContent,
        editorContext: context,
      }));
      return true;
    },
    [edit]
  );
  const clearRevision = useCallback(() => {
    edit((current) => ({ ...current, editorContext: { kind: 'plain' } }));
  }, [edit]);
  const adoptWorking = useCallback(
    (
      working: ComposerWorkingRecord,
      expected?: {
        readonly addressKey: string;
        readonly loadGeneration: number;
        readonly localEditCounter: number;
      }
    ): boolean => {
      if (
        !sameComposerDraftAddress(working.address, addressRef.current) ||
        (expected != null &&
          (expected.addressKey !== addressKeyRef.current ||
            expected.loadGeneration !== loadGenerationRef.current ||
            expected.localEditCounter !== localEditCounterRef.current))
      ) {
        return false;
      }
      localEditCounterRef.current += 1;
      latestEditByAddressRef.current.set(addressKeyRef.current, localEditCounterRef.current);
      applyWorking(working, addressKeyRef.current);
      setIsLoaded(true);
      setIsSaved(true);
      return true;
    },
    [applyWorking]
  );
  const snapshot = useCallback(() => stateRef.current.content, []);

  const canAddMore = canAddMoreAttachments(content.attachments);
  const canSubmit =
    isLoaded &&
    !isRestoring &&
    hydratedRef.current &&
    state.addressKey === addressKey &&
    addressKeyRef.current === addressKey;

  return useMemo(
    () => ({
      text: content.text,
      setText,
      chips: content.chips,
      addChip,
      removeChip,
      attachments: content.attachments,
      attachmentError,
      canAddMore,
      addFiles,
      removeAttachment,
      clearAttachments,
      clearAttachmentError,
      handlePaste,
      handleDrop,
      actionMode: content.actionMode,
      setActionMode,
      editorContext,
      revisionContext: editorContext.kind === 'revision' ? editorContext : null,
      setRevision,
      clearRevision,
      isSaved,
      isLoaded,
      isRestoring,
      persistenceStatus,
      readError,
      address,
      addressKey,
      renderedAddressKey: state.addressKey,
      workingRevision: workingRevisionRef.current,
      localEditCounter: localEditCounterRef.current,
      loadGeneration: loadGenerationRef.current,
      canSubmit,
      snapshot,
      clearDraft,
      flush,
      beginAttempt,
      stashWorking,
      restoreRecovery,
      moveWorkingAsNew,
      adoptWorking,
    }),
    [
      addChip,
      addFiles,
      address,
      addressKey,
      adoptWorking,
      attachmentError,
      beginAttempt,
      canAddMore,
      canSubmit,
      clearAttachmentError,
      clearAttachments,
      clearDraft,
      clearRevision,
      content,
      editorContext,
      flush,
      handleDrop,
      handlePaste,
      isLoaded,
      isRestoring,
      isSaved,
      persistenceStatus,
      readError,
      removeAttachment,
      removeChip,
      setActionMode,
      setRevision,
      setText,
      snapshot,
      moveWorkingAsNew,
      restoreRecovery,
      stashWorking,
      state.addressKey,
    ]
  );
}
