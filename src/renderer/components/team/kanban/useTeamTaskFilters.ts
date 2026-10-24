import { useEffect, useMemo, useRef } from 'react';

import { useTeamGroupChats } from '@features/team-group-chats/renderer';
import { useStore } from '@renderer/store';

import { buildTaskGroupOptions, projectTeamTasks } from './teamTaskProjection';

import type { KanbanFilterState } from './KanbanFilterPopover';
import type { Session } from '@renderer/types/data';
import type { TeamViewSnapshot } from '@shared/types';
import type { Dispatch, RefObject, SetStateAction } from 'react';

export function useTeamTaskFilters(
  teamName: string,
  data: TeamViewSnapshot | null | undefined,
  sessions: Session[],
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
  const catalog = useTeamGroupChats(teamName, contextId, '');
  const teamSessions = useMemo(() => {
    const ids = new Set(data?.config.sessionHistory ?? []);
    if (data?.config.leadSessionId) ids.add(data.config.leadSessionId);
    return ids.size ? sessions.filter((session) => ids.has(session.id)) : sessions;
  }, [sessions, data?.config.sessionHistory, data?.config.leadSessionId]);
  useEffect(() => {
    if (filter.sessionId && !teamSessions.some((session) => session.id === filter.sessionId))
      setFilter((previous) => ({ ...previous, sessionId: null }));
  }, [filter.sessionId, teamSessions, setFilter]);
  const timeWindow = useMemo(() => {
    const sorted = [...teamSessions].sort((left, right) => left.createdAt - right.createdAt);
    const index = sorted.findIndex((session) => session.id === filter.sessionId);
    return index < 0
      ? null
      : { start: sorted[index].createdAt, end: sorted[index + 1]?.createdAt ?? Infinity };
  }, [teamSessions, filter.sessionId]);
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
