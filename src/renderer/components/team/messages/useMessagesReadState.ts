import { useCallback, useMemo } from 'react';

import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { toMessageKey } from '@renderer/utils/teamMessageKey';

import type { InboxMessage } from '@shared/types';

/** Direct and group rows share the same root-scoped read authority. */
export function useMessagesReadState(teamName: string, storageScope: string,
  canonical: readonly InboxMessage[], thread: readonly InboxMessage[], messagesHasMore: boolean) {
  const legacyMessages = useMemo(() => canonical.filter(message => !message.groupChatId), [canonical]);
  const { readSet: legacyReadSet, markAllRead: markLegacyRead } = useTeamMessagesRead(teamName, legacyMessages, !messagesHasMore, storageScope);
  const groups = useMemo(() => [...canonical, ...thread].filter(m => !!m.groupChatId), [canonical, thread]);
  // Group history is independently paginated; do not finalize its backfill from a thread head.
  const { readSet: scopedReadSet, markAllRead: markScopedRead } = useTeamMessagesRead(teamName, groups, false, storageScope, 'group');
  const groupKeys = useMemo(() => new Set(groups.map(toMessageKey)), [groups]);
  const readSet = useMemo(() => new Set([
    ...[...legacyReadSet].filter(key => !groupKeys.has(key)), ...scopedReadSet,
  ]), [groupKeys, legacyReadSet, scopedReadSet]);
  const markAllRead = useCallback((keys: string[]) => {
    markLegacyRead(keys.filter(key => !groupKeys.has(key)));
    markScopedRead(keys.filter(key => groupKeys.has(key)));
  }, [groupKeys, markLegacyRead, markScopedRead]);
  return { readSet, markAllRead };
}
