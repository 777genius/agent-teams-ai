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
  PreparedComposerAttempt,
} from '@renderer/types/composerDraft';

interface Ref<T> {
  current: T;
}

export function useComposerDraftAttempt(options: {
  repository: ComposerDraftRepository;
  enqueue: (operation: () => Promise<void>) => Promise<void>;
  persistPending: (pending: PendingComposerDraftPersistence) => Promise<void>;
  restoringRef: Ref<boolean>;
  hydratedRef: Ref<boolean>;
  stateRef: Ref<LocalDraftState>;
  addressRef: Ref<ComposerDraftAddress>;
  addressKeyRef: Ref<string>;
  localEditCounterRef: Ref<number>;
  attemptAddressKeyRef: Ref<string | null>;
  pendingSaveRef: Ref<PendingComposerDraftPersistence | null>;
  timerRef: Ref<ReturnType<typeof setTimeout> | null>;
  persistQueueRef: Ref<Promise<void>>;
  revisionByAddressRef: Ref<Map<string, string>>;
  mountedRef: Ref<boolean>;
  workingRevisionRef: Ref<string>;
  heldAttemptSaveRef: Ref<PendingComposerDraftPersistence | null>;
  setPersistenceStatus: (status: ComposerPersistenceStatus) => void;
  setState: (state: LocalDraftState) => void;
  setIsSaved: (saved: boolean) => void;
}) {
  const { repository, enqueue, persistPending } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  return useCallback(
    async (
      attemptId: string,
      preparedRequest: ComposerPreparedRequest
    ): Promise<ComposerBeginAttemptResult | null> => {
      const options = optionsRef.current;
      if (
        options.restoringRef.current ||
        !options.hydratedRef.current ||
        options.stateRef.current.addressKey !== options.addressKeyRef.current
      )
        return null;
      const capturedAddress = options.addressRef.current;
      const capturedAddressKey = options.addressKeyRef.current;
      const capturedState = options.stateRef.current;
      const capturedCounter = options.localEditCounterRef.current;
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
        snapshot: {
          content: capturedState.content,
          editorContext: capturedState.editorContext,
        },
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
          options.revisionByAddressRef.current.set(
            capturedAddressKey,
            result.currentWorkingRevision
          );
          if (capturedAddressKey === options.addressKeyRef.current) {
            options.workingRevisionRef.current = result.currentWorkingRevision;
          }
          if (
            result.workingCleared &&
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
