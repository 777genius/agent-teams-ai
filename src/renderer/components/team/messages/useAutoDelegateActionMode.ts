import { useEffect, useRef } from 'react';

import type { AgentActionMode } from '@shared/types';

export function useAutoDelegateActionMode({
  addressKey,
  isLoaded,
  canDelegate,
  shouldAutoDelegate,
  actionMode,
  setActionMode,
}: {
  addressKey: string;
  isLoaded: boolean;
  canDelegate: boolean;
  shouldAutoDelegate: boolean;
  actionMode: AgentActionMode;
  setActionMode: (mode: AgentActionMode) => void;
}): void {
  const baselineRef = useRef<{ addressKey: string; shouldAutoDelegate: boolean } | null>(null);

  useEffect(() => {
    if (!isLoaded) return;

    if (!canDelegate && actionMode === 'delegate') {
      setActionMode('do');
      return;
    }

    // A restored action mode belongs to this draft address, not the prior chat.
    if (baselineRef.current?.addressKey !== addressKey) {
      baselineRef.current = { addressKey, shouldAutoDelegate };
      if (shouldAutoDelegate && actionMode === 'do') {
        setActionMode('delegate');
      }
      return;
    }

    if (shouldAutoDelegate === baselineRef.current.shouldAutoDelegate) return;
    baselineRef.current = { addressKey, shouldAutoDelegate };

    if (shouldAutoDelegate) {
      setActionMode('delegate');
    } else if (actionMode === 'delegate') {
      setActionMode('do');
    }
  }, [actionMode, addressKey, canDelegate, isLoaded, setActionMode, shouldAutoDelegate]);
}
