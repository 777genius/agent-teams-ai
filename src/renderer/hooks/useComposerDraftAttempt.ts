import { useCallback, useRef } from 'react';

import { sameComposerDraftAddress } from '@renderer/utils/composerDraftIdentity';

import { emptyContent, type LocalDraftState } from './composerDraftLocal';

import type { PendingComposerDraftPersistence } from './persistComposerDraftBeforeHydration';
import type { ComposerBeginAttemptResult } from './useComposerDraft';
import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerPersistenceStatus,
  ComposerPreparedRequest,
  ComposerWorkingRecord,
  PreparedComposerAttempt,
} from '@renderer/types/composerDraft';

interface Ref<T> {
  current: T;
}

export type ComposerAttemptRequest =
  | ComposerPreparedRequest
  | ((snapshot: PreparedComposerAttempt['snapshot']) => ComposerPreparedRequest | null);

export function useComposerDraftAttempt(options: {
  repository: ComposerDraftRepository;
  enqueue: (operation: () => Promise<void>) => Promise<void>;
  persistPending: (pending: PendingComposerDraftPersistence) => Promise<void>;
  restoringRef: Ref<boolean>;
  hydratedRef: Ref<boolean>;
  stateRef: Ref<LocalDraftState>;
  addressRef: Ref<ComposerDraftAddress>;
  addressKeyRef: Ref<string>;
  loadGenerationRef: Ref<number>;
  localEditCounterRef: Ref<number>;
  latestEditByAddressRef: Ref<Map<string, number>>;
  savedEditByAddressRef: Ref<Map<string, number>>;
  attemptAddressKeyRef: Ref<string | null>;
  pendingSaveRef: Ref<PendingComposerDraftPersistence | null>;
  syncPendingByAddressRef: Ref<Map<string, Promise<void>>>;
  timerRef: Ref<ReturnType<typeof setTimeout> | null>;
  persistQueueRef: Ref<Promise<void>>;
  revisionByAddressRef: Ref<Map<string, string>>;
  mountedRef: Ref<boolean>;
  workingRevisionRef: Ref<string>;
  heldAttemptSaveRef: Ref<PendingComposerDraftPersistence | null>;
  setPersistenceStatus: (status: ComposerPersistenceStatus) => void;
  applyWorking: (working: ComposerWorkingRecord, key: string) => void;
  setState: (state: LocalDraftState) => void;
  setIsSaved: (saved: boolean) => void;
}) {
  const { repository, enqueue, persistPending } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  return useCallback(
    async (
      attemptId: string,
      prepareRequest: ComposerAttemptRequest
    ): Promise<ComposerBeginAttemptResult | null> => {
      const options = optionsRef.current;
      const requestedAddress = options.addressRef.current;
      const requestedAddressKey = options.addressKeyRef.current;
      const requestedGeneration = options.loadGenerationRef.current;
      let pendingSync = options.syncPendingByAddressRef.current.get(requestedAddressKey);
      while (pendingSync) {
        await pendingSync;
        if (
          !options.mountedRef.current ||
          requestedGeneration !== options.loadGenerationRef.current ||
          requestedAddressKey !== options.addressKeyRef.current ||
          !sameComposerDraftAddress(requestedAddress, options.addressRef.current)
        )
          return null;
        const next = options.syncPendingByAddressRef.current.get(requestedAddressKey);
        if (next === pendingSync) break;
        pendingSync = next;
      }
      if (
        !options.mountedRef.current ||
        options.restoringRef.current ||
        !options.hydratedRef.current ||
        options.stateRef.current.addressKey !== options.addressKeyRef.current
      )
        return null;
      const capturedAddress = options.addressRef.current;
      const capturedAddressKey = options.addressKeyRef.current;
      const capturedState = options.stateRef.current;
      const capturedCounter = options.localEditCounterRef.current;
      const snapshot = {
        content: capturedState.content,
        editorContext: capturedState.editorContext,
      };
      const preparedRequest =
        typeof prepareRequest === 'function' ? prepareRequest(snapshot) : prepareRequest;
      if (!preparedRequest) return null;
      options.attemptAddressKeyRef.current = capturedAddressKey;
      if (options.pendingSaveRef.current?.addressKey === capturedAddressKey) {
        options.pendingSaveRef.current = null;
      }
      if (options.timerRef.current != null) {
        clearTimeout(options.timerRef.current);
        options.timerRef.current = null;
      }
      const attempt: PreparedComposerAttempt = {
        attemptId,
        snapshot,
        preparedRequest,
        createdAt: Date.now(),
      };
      try {
        await options.persistQueueRef.current.catch(() => undefined);
        const expectedRevision =
          options.revisionByAddressRef.current.get(capturedAddressKey) ?? '0';
        const result = await repository.beginAttempt(capturedAddress, expectedRevision, attempt);
        if (options.mountedRef.current && capturedAddressKey === options.addressKeyRef.current) {
          options.setPersistenceStatus(result.status);
        }
        if (result.kind === 'prepared') {
          if (!result.workingCleared) {
            const latest = await repository.loadWorking(capturedAddress);
            if (
              !latest.writeBlocked &&
              options.mountedRef.current &&
              requestedGeneration === options.loadGenerationRef.current &&
              capturedCounter === options.localEditCounterRef.current &&
              capturedAddressKey === options.addressKeyRef.current &&
              sameComposerDraftAddress(capturedAddress, options.addressRef.current)
            ) {
              options.applyWorking(latest.working, capturedAddressKey);
              options.setPersistenceStatus(latest.status);
            }
          } else {
            if (options.latestEditByAddressRef.current.get(capturedAddressKey) === capturedCounter)
              options.savedEditByAddressRef.current.set(capturedAddressKey, capturedCounter);
            options.revisionByAddressRef.current.set(
              capturedAddressKey,
              result.currentWorkingRevision
            );
            if (capturedAddressKey === options.addressKeyRef.current) {
              options.workingRevisionRef.current = result.currentWorkingRevision;
            }
            if (
              options.mountedRef.current &&
              capturedCounter === options.localEditCounterRef.current &&
              sameComposerDraftAddress(capturedAddress, options.addressRef.current)
            ) {
              const next: LocalDraftState = {
                addressKey: options.addressKeyRef.current,
                content: { ...emptyContent(), actionMode: capturedState.content.actionMode },
                editorContext: { kind: 'plain' },
              };
              options.stateRef.current = next;
              options.setState(next);
              options.setIsSaved(false);
            }
          }
        }
        return { result, address: capturedAddress, attempt, localEditCounter: capturedCounter };
      } finally {
        options.attemptAddressKeyRef.current = null;
        const held = options.heldAttemptSaveRef.current;
        options.heldAttemptSaveRef.current = null;
        if (held) void enqueue(() => persistPending(held));
      }
    },
    [enqueue, persistPending, repository]
  );
}
