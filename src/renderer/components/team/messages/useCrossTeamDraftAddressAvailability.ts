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
  const [readyToken, setReadyToken] = useState<object | null>(null);

  useEffect(() => {
    let current = true;
    void fetchTargets().then(
      (loaded) => {
        if (current && loaded) setReadyToken(contextToken);
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [contextToken, fetchTargets]);

  return useCallback(
    (address: ComposerDraftAddress) =>
      address.target.kind === 'cross-team' && readyToken !== contextToken
        ? true
        : canOpenConversationAddress(address, participants, targets),
    [contextToken, participants, readyToken, targets]
  );
}
