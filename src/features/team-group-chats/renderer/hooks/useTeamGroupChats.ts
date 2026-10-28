import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import { DEFAULT_TEAM_GROUP_CHAT_ID } from '../../contracts';

import type { GroupChatCreateRequest, TeamGroupChatDTO } from '../../contracts';

export function useTeamGroupChats(teamName: string, contextId: string, rosterKey: string) {
  const [catalog, setCatalog] = useState<{
    identity: string;
    groups: TeamGroupChatDTO[];
    loaded: boolean;
  }>({ identity: '', groups: [], loaded: false });
  const [error, setError] = useState<string | null>(null);
  const identity = JSON.stringify([contextId, teamName]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const pending = useRef(new Map<string, { promise: Promise<void>; refreshAgain: boolean }>());
  const refresh = useCallback(
    (refreshAfterPending = false): Promise<void> => {
      const existing = pending.current.get(identity);
      if (existing) {
        if (refreshAfterPending) existing.refreshAgain = true;
        return existing.promise;
      }
      const entry = { promise: Promise.resolve(), refreshAgain: false };
      entry.promise = (async () => {
        do {
          entry.refreshAgain = false;
          try {
            const result = await api.teamGroupChats.list({ teamName });
            if (currentIdentity.current === identity) {
              setCatalog({ identity, groups: result, loaded: true });
              setError(null);
            }
          } catch (cause) {
            if (currentIdentity.current === identity)
              setError(cause instanceof Error ? cause.message : String(cause));
          }
        } while (entry.refreshAgain && currentIdentity.current === identity);
      })().finally(() => {
        if (pending.current.get(identity) === entry) pending.current.delete(identity);
      });
      pending.current.set(identity, entry);
      return entry.promise;
    },
    [identity, teamName]
  );
  useEffect(() => {
    setCatalog({ identity, groups: [], loaded: false });
    setError(null);
  }, [identity]);
  useEffect(() => {
    void refresh(true);
  }, [refresh, rosterKey]);
  useEffect(
    () =>
      api.teams.onTeamChange?.((_event, change) => {
        if (change.teamName === teamName && (change.type === 'config' || change.type === 'inbox'))
          void refresh(true);
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
      setCatalog((previous) => ({
        identity,
        loaded: true,
        groups: previous.groups.some((item) => item.id === group.id)
          ? previous.groups.map((item) => (item.id === group.id ? group : item))
          : [...previous.groups, group],
      }));
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
  const groups = catalog.identity === identity ? catalog.groups : [];
  return {
    allGroups: groups,
    loading: catalog.identity !== identity || !catalog.loaded,
    groups: groups.filter((group) => group.id !== DEFAULT_TEAM_GROUP_CHAT_ID),
    defaultGroup: groups.find((group) => group.id === DEFAULT_TEAM_GROUP_CHAT_ID),
    error: catalog.identity === identity ? error : null,
    refresh,
    create,
    setArchived,
  };
}
