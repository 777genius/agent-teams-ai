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
    await flush();
    const current = optionsRef.current;
    current.localEditCounterRef.current += 1;
    current.latestEditByAddressRef.current.set(
      current.addressKeyRef.current,
      current.localEditCounterRef.current
    );
    const next: LocalDraftState = {
      addressKey: current.addressKeyRef.current,
      content: emptyContent(),
      editorContext: { kind: 'plain' },
    };
    current.stateRef.current = next;
    current.setState(next);
    const revision = nextRevision('clear');
    const result = await repository.saveWorking(
      current.addressRef.current,
      current.workingRevisionRef.current,
      revision,
      null,
      next.editorContext
    );
    current.setPersistenceStatus(result.status);
    if (result.kind === 'saved') {
      current.workingRevisionRef.current = revision;
      current.revisionByAddressRef.current.set(current.addressKeyRef.current, revision);
      current.savedEditByAddressRef.current.set(
        current.addressKeyRef.current,
        current.localEditCounterRef.current
      );
    }
    current.setIsSaved(false);
  }, [flush, repository]);
}
