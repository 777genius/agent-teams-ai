import type {
  CanonicalListTeamLifecycleResult,
  CanonicalTeamLifecycleListItem,
  TeamLifecycleState,
} from '../../contracts';
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

export const LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL: TeamLifecycleListViewModel = Object.freeze({
  state: 'loading',
});

const STATUS_PRESENTATION: Readonly<
  Record<
    TeamLifecycleState,
    readonly [TeamLifecycleListStatusLabelKey, TeamLifecycleListStatusTone]
  >
> = Object.freeze({
  draft: ['list.status.offline', 'muted'],
  ready: ['list.status.offline', 'muted'],
  running: ['list.status.running', 'success'],
  degraded: ['list.status.partialFailure', 'warning'],
  stopped: ['list.status.offline', 'muted'],
  deleted: ['list.status.deleted', 'danger'],
});

export function toTeamLifecycleListItemViewModel(
  item: CanonicalTeamLifecycleListItem
): TeamLifecycleListItemViewModel {
  const [statusLabelKey, statusTone] = STATUS_PRESENTATION[item.lifecycle];
  return Object.freeze({
    teamId: item.teamId,
    workspaceId: item.workspaceId,
    displayName: item.displayName,
    statusLabelKey,
    statusTone,
  });
}

export function toTeamLifecycleListViewModel(
  result: CanonicalListTeamLifecycleResult
): TeamLifecycleListViewModel {
  if (result.kind === 'failure') {
    return Object.freeze({
      state: 'failure',
      failureKind: 'failure',
      retryable: result.retryable,
    });
  }
  if (result.kind === 'inapplicable') {
    return Object.freeze({
      state: 'failure',
      failureKind: 'inapplicable',
      retryable: false,
    });
  }
  if (result.items.length === 0) {
    return Object.freeze({ state: 'empty', snapshotRevision: result.snapshotRevision });
  }
  return Object.freeze({
    state: 'ready',
    snapshotRevision: result.snapshotRevision,
    items: Object.freeze(result.items.map(toTeamLifecycleListItemViewModel)),
  });
}
