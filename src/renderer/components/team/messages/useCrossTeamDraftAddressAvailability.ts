import { useCallback, useEffect, useMemo, useState } from 'react';

import { useStore } from '@renderer/store';

import { canOpenConversationAddress } from './messagesPanelDerivedData';

import type { ComposerDraftAddress } from '@renderer/types/composerDraft';

export function useCrossTeamDraftAddressAvailability(
  contextId: string,
  participants: ReadonlySet<string>
): (address: ComposerDraftAddress) => boolean {
  const targets = useStore((state) => state.crossTeamTargets);
  const fetchTargets = useStore((state) => state.fetchCrossTeamTargets);
  const contextToken = useMemo(() => ({ contextId }), [contextId]);
  const [catalog, setCatalog] = useState<{ token: object; loaded: boolean } | null>(null);

  useEffect(() => {
    let current = true;
    void fetchTargets().then(
      (loaded) => {
        if (current) setCatalog({ token: contextToken, loaded });
      },
      () => {
        if (current) setCatalog({ token: contextToken, loaded: false });
      }
    );
    return () => {
      current = false;
    };
  }, [contextToken, fetchTargets]);

  return useCallback(
    (address: ComposerDraftAddress) => {
      if (address.target.kind === 'cross-team') {
        if (catalog?.token !== contextToken) return true;
        if (!catalog.loaded) return false;
      }
      return canOpenConversationAddress(address, participants, targets);
    },
    [catalog, contextToken, participants, targets]
  );
}
