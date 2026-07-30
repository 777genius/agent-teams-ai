import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL,
  toTeamLifecycleListViewModel,
} from '../adapters/teamLifecycleListViewModel';
import { loadTeamLifecycleList } from '../utils/loadTeamLifecycleList';

import type { TeamLifecycleReadTransportApi } from '../../contracts';
import type { Revision, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export type TeamLifecycleListStatusLabelKey =
  | 'list.status.deleted'
  | 'list.status.offline'
  | 'list.status.partialFailure'
  | 'list.status.running';

export type TeamLifecycleListStatusTone = 'danger' | 'muted' | 'success' | 'warning';

export interface TeamLifecycleListItemViewModel {
  readonly teamId: TeamId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly statusLabelKey: TeamLifecycleListStatusLabelKey;
  readonly statusTone: TeamLifecycleListStatusTone;
}

export type TeamLifecycleListViewModel =
  | Readonly<{ state: 'loading' }>
  | Readonly<{ state: 'empty'; snapshotRevision: Revision }>
  | Readonly<{
      state: 'ready';
      snapshotRevision: Revision;
      items: readonly TeamLifecycleListItemViewModel[];
    }>
  | Readonly<{
      state: 'failure';
      failureKind: 'failure' | 'inapplicable';
      retryable: boolean;
    }>;

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
