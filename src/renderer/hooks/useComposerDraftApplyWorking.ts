import { useCallback, useRef } from 'react';

import { emptyContent, type LocalDraftState, validAttachments } from './composerDraftLocal';
import { contentIsEmpty } from './persistComposerDraftBeforeHydration';

import type { ComposerWorkingRecord } from '@renderer/types/composerDraft';

interface Ref<T> {
  current: T;
}

export function useComposerDraftApplyWorking(options: {
  stateRef: Ref<LocalDraftState>;
  workingRevisionRef: Ref<string>;
  revisionByAddressRef: Ref<Map<string, string>>;
  savedEditByAddressRef: Ref<Map<string, number>>;
  latestEditByAddressRef: Ref<Map<string, number>>;
  setState: (state: LocalDraftState) => void;
}): (working: ComposerWorkingRecord, key: string) => void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  return useCallback((working: ComposerWorkingRecord, key: string): void => {
    const current = optionsRef.current;
    const content =
      working.content ??
      (current.stateRef.current.addressKey === key &&
      contentIsEmpty(current.stateRef.current.content)
        ? current.stateRef.current.content
        : emptyContent());
    const nextContent = validAttachments(content.attachments)
      ? content
      : { ...content, attachments: [] };
    current.workingRevisionRef.current = working.workingRevision;
    current.revisionByAddressRef.current.set(key, working.workingRevision);
    current.savedEditByAddressRef.current.set(
      key,
      current.latestEditByAddressRef.current.get(key) ?? 0
    );
    current.stateRef.current = {
      addressKey: key,
      content: nextContent,
      editorContext: working.editorContext,
    };
    current.setState(current.stateRef.current);
  }, []);
}
