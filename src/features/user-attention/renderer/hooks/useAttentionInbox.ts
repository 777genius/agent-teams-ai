import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { buildAttentionModel } from '../../core/domain/buildAttention';
import {
  getAttentionStoreState,
  refreshAttention,
  setAttentionContext,
  subscribeAttention,
} from './attentionSnapshotStore';

import { useStore } from '@renderer/store';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { getReadSetSnapshot } from '@renderer/utils/teamMessageReadStorage';

import type { AttentionReads } from '../../core/domain/buildAttention';

export function useAttentionInbox() {
  const contextId = useStore((state) => state.activeContextId);
  const state = useSyncExternalStore(
    subscribeAttention,
    getAttentionStoreState,
    getAttentionStoreState
  );
  useEffect(() => setAttentionContext(contextId), [contextId]);

  const model = useMemo(() => {
    if (state.contextId !== contextId || !state.snapshot) return null;
    const getReads = (teamName: string): AttentionReads => ({
      // Keep the exact current Messenger read keys; group scope is root-aware.
      direct: getReadSetSnapshot(teamName),
      group: getReadSetSnapshot(JSON.stringify(['group', contextId, teamName])),
    });
    return buildAttentionModel(state.snapshot, getReads, toMessageKey);
  }, [contextId, state]);

  return {
    model,
    loading: state.loading || state.contextId !== contextId,
    error: state.error,
    refresh: refreshAttention,
  };
}
