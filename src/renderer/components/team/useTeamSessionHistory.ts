import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import { loadTeamSessionHistory } from './teamSessionHistory';

import type { TeamSessionView } from './teamSessionHistory';

interface ReadState {
  key: string;
  sessions: TeamSessionView[];
  loading: boolean;
  error: string | null;
}
/** One read per selected Team/context; abandoned reads cannot restore a previous project's sessions. */
export function useTeamSessionHistory(options: {
  teamName: string;
  projectId: string | null;
  leadSessionId: string | null;
  sessionHistory?: readonly string[];
  isActive: boolean;
  runtimeAlive?: boolean;
}) {
  const contextId = useStore((state) => state.activeContextId);
  const historyKey = JSON.stringify(options.sessionHistory ?? []);
  const sessionHistory = useMemo(() => JSON.parse(historyKey) as string[], [historyKey]);
  const { teamName, projectId, leadSessionId, isActive, runtimeAlive } = options;
  const key = JSON.stringify([
    contextId,
    teamName,
    projectId,
    leadSessionId,
    historyKey,
    runtimeAlive,
  ]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<ReadState>({
    key: '',
    sessions: [],
    loading: false,
    error: null,
  });
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setState((previous) => ({
      key,
      sessions: previous.key === key ? previous.sessions : [],
      loading: true,
      error: null,
    }));
    void loadTeamSessionHistory(api, teamName, projectId, { leadSessionId, sessionHistory }).then(
      (sessions) => {
        if (!cancelled) setState({ key, sessions, loading: false, error: null });
      },
      (error) => {
        if (!cancelled)
          setState({
            key,
            sessions: [],
            loading: false,
            error: error instanceof Error ? error.message : 'Team session history is unavailable.',
          });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, isActive, retry, teamName, projectId, leadSessionId, sessionHistory]);
  return {
    sessions: state.key === key ? state.sessions : [],
    sessionsLoading: isActive && (state.key !== key || state.loading),
    sessionsError: state.key === key ? state.error : null,
    refreshSessions: refresh,
  };
}
