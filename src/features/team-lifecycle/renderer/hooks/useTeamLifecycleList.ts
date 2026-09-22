import { useCallback, useEffect, useRef, useState } from 'react';

import { loadTeamLifecycleList } from '../utils/loadTeamLifecycleList';
import {
  LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL,
  toTeamLifecycleListViewModel,
} from '../view-models/teamLifecycleListViewModel';

import type { TeamLifecycleReadTransportApi } from '../../contracts';
import type { TeamLifecycleListViewModel } from '../view-models/teamLifecycleListViewModel';

export type {
  TeamLifecycleListItemViewModel,
  TeamLifecycleListStatusLabelKey,
  TeamLifecycleListStatusTone,
  TeamLifecycleListViewModel,
} from '../view-models/teamLifecycleListViewModel';

export interface UseTeamLifecycleListResult {
  readonly viewModel: TeamLifecycleListViewModel;
  readonly retry: () => void;
}

export function useTeamLifecycleList(
  transport: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>
): UseTeamLifecycleListResult {
  const [viewModel, setViewModel] = useState<TeamLifecycleListViewModel>(
    LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL
  );
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);

  const retry = useCallback(() => {
    const requestId = ++requestIdRef.current;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setViewModel(LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL);

    void loadTeamLifecycleList(transport, controller.signal).then((result) => {
      if (requestId === requestIdRef.current && !controller.signal.aborted) {
        setViewModel(toTeamLifecycleListViewModel(result));
      }
    });
  }, [transport]);

  useEffect(() => {
    retry();
    return () => {
      requestIdRef.current += 1;
      activeRequestRef.current?.abort();
    };
  }, [retry]);

  return { viewModel, retry };
}
