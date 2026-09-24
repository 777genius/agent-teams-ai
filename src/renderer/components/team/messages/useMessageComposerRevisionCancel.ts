import { useCallback, useRef } from 'react';

import type { UseComposerDraftResult } from '@renderer/hooks/useComposerDraft';
import type { ComposerDraftAddress, MessageRevisionContext } from '@renderer/types/composerDraft';

type RevisionDraft = Pick<
  UseComposerDraftResult,
  'address' | 'addressKey' | 'loadGeneration' | 'revisionContext' | 'clearRevision'
>;

export function useMessageComposerRevisionCancel(
  draft: RevisionDraft,
  onCancel: ((revision?: MessageRevisionContext | null, address?: ComposerDraftAddress) => boolean | void | Promise<boolean>) | undefined,
  focusComposer: () => void
): () => Promise<void> {
  const currentTargetRef = useRef({
    addressKey: draft.addressKey,
    loadGeneration: draft.loadGeneration,
    requestId: draft.revisionContext?.requestId,
  });
  currentTargetRef.current = {
    addressKey: draft.addressKey,
    loadGeneration: draft.loadGeneration,
    requestId: draft.revisionContext?.requestId,
  };

  return useCallback(async () => {
    const target = currentTargetRef.current;
    const cancelled = await onCancel?.(draft.revisionContext, draft.address);
    if (cancelled === false) return;
    const current = currentTargetRef.current;
    if (
      current.addressKey !== target.addressKey ||
      current.loadGeneration !== target.loadGeneration ||
      current.requestId !== target.requestId
    ) return;
    draft.clearRevision();
    focusComposer();
  }, [draft, focusComposer, onCancel]);
}
