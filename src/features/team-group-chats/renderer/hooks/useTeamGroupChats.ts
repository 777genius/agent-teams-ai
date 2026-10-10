import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import { DEFAULT_TEAM_GROUP_CHAT_ID } from '../../contracts';

import type { GroupChatCreateRequest, TeamGroupChatDTO } from '../../contracts';

export function useTeamGroupChats(teamName: string, contextId: string, rosterKey: string) {
  const [groups, setGroups] = useState<TeamGroupChatDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const identity = `${contextId}:${teamName}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const refresh = useCallback(async () => {
    try {
      const result = await api.teamGroupChats.list({ teamName });
      if (currentIdentity.current === identity) {
        setGroups(result);
        setError(null);
      }
    } catch (cause) {
      if (currentIdentity.current === identity)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [identity, teamName]);
  useEffect(() => {
    setGroups([]);
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [refresh, rosterKey]);
  useEffect(
    () =>
      api.teams.onTeamChange?.((_event, change) => {
        if (change.teamName === teamName && (change.type === 'config' || change.type === 'inbox'))
          void refresh();
      }),
    [refresh, teamName]
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const upsert = useCallback(
    (group: TeamGroupChatDTO) => {
      if (currentIdentity.current !== identity) return;
      setGroups((previous) =>
        previous.some((item) => item.id === group.id)
          ? previous.map((item) => (item.id === group.id ? group : item))
          : [...previous, group]
      );
    },
    [identity]
  );
  const create = useCallback(
    async (request: GroupChatCreateRequest) => {
      const group = await api.teamGroupChats.create(request);
      upsert(group);
      return group;
    },
    [upsert]
  );
  const setArchived = useCallback(
    async (groupChatId: string, archived: boolean) => {
      const group = await api.teamGroupChats.setArchived({ teamName, groupChatId, archived });
      upsert(group);
    },
    [teamName, upsert]
  );
  return {
    groups: groups.filter((group) => group.id !== DEFAULT_TEAM_GROUP_CHAT_ID),
    defaultGroup: groups.find((group) => group.id === DEFAULT_TEAM_GROUP_CHAT_ID),
    error,
    refresh,
    create,
    setArchived,
  };
}
