import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  subscribeContextScopedRequestEpoch,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { getReadSetSnapshot, seedPersistedReadKeysOnce } from '@renderer/utils/teamMessageReadStorage';

import { buildAttentionModel } from '../../core/domain/buildAttention';
import {
  getAttentionStoreState,
  refreshAttention,
  setAttentionContext,
  subscribeAttention,
} from './attentionSnapshotStore';

import type { AttentionReads } from '../../core/domain/buildAttention';

export function useAttentionInbox() {
  const contextId = useStore((state) => state.activeContextId);
  const contextEpoch = useSyncExternalStore(
    subscribeContextScopedRequestEpoch,
    captureContextScopedRequestEpoch,
    captureContextScopedRequestEpoch
  );
  const state = useSyncExternalStore(
    subscribeAttention,
    getAttentionStoreState,
    getAttentionStoreState
  );
  useEffect(() => setAttentionContext(contextId, contextEpoch), [contextId, contextEpoch]);

  useEffect(() => {
    // Messenger migrates the legacy persisted message.read flag before relying
    // on local read keys. Reuse that same migration for teams opened only in
    // Attention; the compact candidate projection is NOT a full Messenger
    // history, so never finalize the shared migration marker here.
    if (state.contextId !== contextId ||
        state.contextEpoch !== contextEpoch || !state.snapshot) return;
    for (const team of state.snapshot.teams) {
      if (team.error) continue;
      const alreadyRead = team.messages
        .filter((message) => !message.groupChatId && message.read === true)
        .map(toMessageKey);
      if (alreadyRead.length > 0) {
        seedPersistedReadKeysOnce(team.teamName, alreadyRead);
      }
    }
  }, [contextId, contextEpoch, state.snapshot, state.contextId, state.contextEpoch]);

  const model = useMemo(() => {
    if (state.contextId !== contextId || state.contextEpoch !== contextEpoch || !state.snapshot) return null;
    const getReads = (teamName: string): AttentionReads => ({
      // Keep the exact current Messenger read keys; group scope is root-aware.
      direct: getReadSetSnapshot(teamName),
      group: getReadSetSnapshot(JSON.stringify(['group', contextId, teamName])),
    });
    return buildAttentionModel(state.snapshot, getReads, toMessageKey);
  }, [contextId, contextEpoch, state]);

  return {
    model,
    loading: state.loading || state.contextId !== contextId || state.contextEpoch !== contextEpoch,
    error: state.error,
    refresh: refreshAttention,
  };
}
