import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useTeamGroupChats } from '@features/team-group-chats/renderer';
import { useAttentionConversationNavigation } from '@features/user-attention/renderer';
import { useStore } from '@renderer/store';

import { isHostTeamSession, sessionsForTeam, teamSessionWindow } from '../teamSessionHistory';

import { buildTaskGroupOptions, projectTeamTasks } from './teamTaskProjection';

import type { TeamSessionView } from '../teamSessionHistory';
import type { KanbanFilterState } from './KanbanFilterPopover';
import type { TeamViewSnapshot } from '@shared/types';
import type { Dispatch, RefObject, SetStateAction } from 'react';

export function useTeamTaskFilters(
  teamName: string,
  data: TeamViewSnapshot | null | undefined,
  sessions: TeamSessionView[],
  filter: KanbanFilterState,
  setFilter: Dispatch<SetStateAction<KanbanFilterState>>,
  clearSearch: Dispatch<SetStateAction<string>>,
  isActive: boolean,
  contentRef: RefObject<HTMLDivElement | null>,
  revealBoard: () => void
) {
  const contextId = useStore((state) => state.activeContextId);
  const intent = useStore((state) => state.groupTaskNavigation);
  const consume = useStore((state) => state.consumeGroupTaskNavigation);
  const identity = JSON.stringify([contextId, teamName]);
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity;
      setFilter({ sessionId: null, selectedOwners: new Set(), columns: new Set() });
      clearSearch('');
    }
  }, [identity, setFilter, clearSearch]);
  // Messenger shares this session window with the board. Clear it at its owner
  // when Attention opens a conversation, without changing other board filters.
  const clearSession = useCallback(() => {
    setFilter((previous) =>
      previous.sessionId === null ? previous : { ...previous, sessionId: null }
    );
  }, [setFilter]);
  useAttentionConversationNavigation(contextId, teamName, clearSession);
  const catalog = useTeamGroupChats(teamName, contextId, '');
  const teamSessions = useMemo(
    () =>
      sessionsForTeam(
        teamName,
        { sessionHistory: data?.config.sessionHistory, leadSessionId: data?.config.leadSessionId },
        sessions
      ),
    [teamName, sessions, data?.config.sessionHistory, data?.config.leadSessionId]
  );
  useEffect(() => {
    const selected = teamSessions.find((session) => session.id === filter.sessionId);
    if (
      filter.sessionId &&
      (!selected || (isHostTeamSession(selected) && selected.clock !== 'qualified'))
    )
      setFilter((previous) => ({ ...previous, sessionId: null }));
  }, [filter.sessionId, teamSessions, setFilter]);
  const timeWindow = useMemo(
    () => teamSessionWindow(filter.sessionId, teamSessions),
    [teamSessions, filter.sessionId]
  );
  const filteredTasks = useMemo(
    () => (data ? projectTeamTasks(data.tasks, filter, timeWindow) : []),
    [data, filter, timeWindow]
  );
  const taskGroupOptions = useMemo(
    () =>
      buildTaskGroupOptions(
        data?.tasks ?? [],
        catalog.allGroups,
        !catalog.loading && !catalog.error,
        filter.groupChatId ?? null
      ),
    [data?.tasks, catalog.allGroups, catalog.loading, catalog.error, filter.groupChatId]
  );

  useEffect(() => {
    if (
      !isActive ||
      !data ||
      data.teamName !== teamName ||
      !intent ||
      intent.teamName !== teamName ||
      intent.contextId !== contextId
    )
      return;
    const section = contentRef.current?.querySelector('[data-section-id="kanban"]');
    if (!section) return;
    setFilter({
      sessionId: null,
      selectedOwners: new Set(),
      columns: new Set(),
      groupChatId: intent.groupChatId,
    });
    clearSearch('');
    revealBoard();
    consume(intent.token);
    section.dispatchEvent(new Event('team-section-navigate'));
  }, [
    isActive,
    data,
    intent,
    teamName,
    contextId,
    contentRef,
    setFilter,
    clearSearch,
    consume,
    revealBoard,
  ]);
  return { teamSessions, timeWindow, filteredTasks, taskGroupOptions };
}
