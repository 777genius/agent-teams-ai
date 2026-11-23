import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { useTeamMessageReadContextScope } from '@renderer/hooks/useTeamMessageReadContextScope';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  subscribeContextScopedRequestEpoch,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import {
  getReadSetSnapshot,
  getTeamMessageReadStorageKey,
  seedPersistedReadKeysOnce,
} from '@renderer/utils/teamMessageReadStorage';

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
  const { scope: readScope, error: readScopeError, retry: retryReadScope } =
    useTeamMessageReadContextScope(contextId);
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
    if (!readScope || captureContextScopedRequestEpoch() !== contextEpoch || state.contextId !== contextId ||
        state.contextEpoch !== contextEpoch || !state.snapshot) return;
    for (const team of state.snapshot.teams) {
      if (team.error) continue;
      const alreadyRead = team.messages
        .filter((message) => !message.groupChatId && message.read === true)
        .map(toMessageKey);
      if (alreadyRead.length > 0) {
        seedPersistedReadKeysOnce(getTeamMessageReadStorageKey(team.teamName, readScope), alreadyRead);
      }
    }
  }, [contextId, contextEpoch, readScope, state.snapshot, state.contextId, state.contextEpoch]);

  const model = useMemo(() => {
    if (!readScope || state.contextId !== contextId || state.contextEpoch !== contextEpoch || !state.snapshot) return null;
    const getReads = (teamName: string): AttentionReads => ({
      // Messenger and Attention must use the same effective workspace namespace.
      direct: getReadSetSnapshot(getTeamMessageReadStorageKey(teamName, readScope)),
      group: getReadSetSnapshot(getTeamMessageReadStorageKey(teamName, readScope, 'group')),
    });
    return buildAttentionModel(state.snapshot, getReads, toMessageKey);
  }, [contextId, contextEpoch, readScope, state]);

  const refresh = useCallback(() => {
    retryReadScope();
    refreshAttention();
  }, [retryReadScope]);

  return {
    model,
    loading: state.loading || (!readScope && !readScopeError) ||
      state.contextId !== contextId || state.contextEpoch !== contextEpoch,
    error: state.error ?? readScopeError,
    refresh,
  };
}
