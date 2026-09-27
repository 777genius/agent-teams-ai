import { useCallback, useRef } from 'react';

import { emptyContent, type LocalDraftState, nextRevision } from './composerDraftLocal';

import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerPersistenceStatus,
} from '@renderer/types/composerDraft';

interface Ref<T> {
  current: T;
}

export function useComposerDraftClear(options: {
  repository: ComposerDraftRepository;
  flush: () => Promise<void>;
  addressRef: Ref<ComposerDraftAddress>;
  addressKeyRef: Ref<string>;
  localEditCounterRef: Ref<number>;
  latestEditByAddressRef: Ref<Map<string, number>>;
  savedEditByAddressRef: Ref<Map<string, number>>;
  stateRef: Ref<LocalDraftState>;
  workingRevisionRef: Ref<string>;
  revisionByAddressRef: Ref<Map<string, string>>;
  setState: (state: LocalDraftState) => void;
  setPersistenceStatus: (status: ComposerPersistenceStatus) => void;
  setIsSaved: (saved: boolean) => void;
}): () => Promise<void> {
  const { flush, repository } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  return useCallback(async (): Promise<void> => {
    const current = optionsRef.current;
    const address = current.addressRef.current;
    const addressKey = current.addressKeyRef.current;
    const editCounter = current.localEditCounterRef.current;
    await flush();
    if (
      current.addressKeyRef.current !== addressKey ||
      current.localEditCounterRef.current !== editCounter
    ) {
      return;
    }
    current.localEditCounterRef.current += 1;
    const clearEditCounter = current.localEditCounterRef.current;
    current.latestEditByAddressRef.current.set(addressKey, clearEditCounter);
    const next: LocalDraftState = {
      addressKey,
      content: emptyContent(),
      editorContext: { kind: 'plain' },
    };
    current.stateRef.current = next;
    current.setState(next);
    current.setIsSaved(false);
    const expectedRevision = current.revisionByAddressRef.current.get(addressKey) ?? '0';
    const revision = nextRevision('clear');
    const result = await repository.saveWorking(
      address,
      expectedRevision,
      revision,
      null,
      next.editorContext
    );
    if (addressKey === current.addressKeyRef.current) {
      current.setPersistenceStatus(result.status);
    }
    if (result.kind === 'saved') {
      current.revisionByAddressRef.current.set(addressKey, result.workingRevision);
      if (addressKey === current.addressKeyRef.current) {
        current.workingRevisionRef.current = result.workingRevision;
      }
      if (current.latestEditByAddressRef.current.get(addressKey) === clearEditCounter) {
        current.savedEditByAddressRef.current.set(addressKey, clearEditCounter);
      }
    }
  }, [flush, repository]);
}
