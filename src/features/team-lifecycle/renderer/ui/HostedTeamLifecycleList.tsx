import { useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  buildTeamDirectoryRows,
  resolveTeamDirectoryOpenIntent,
  TeamDirectoryQueryInput,
  TeamDirectoryRowHeading,
  TeamDirectoryRows,
  TeamDirectoryStatusFilter,
} from '@features/team-directory/renderer';
import { Button } from '@renderer/components/ui/button';
import { AlertCircle, RefreshCw, UsersRound } from 'lucide-react';

import { useTeamLifecycleList } from '../hooks/useTeamLifecycleList';

import type { TeamLifecycleReadTransportApi } from '../../contracts';
import type { HostedTeamDirectoryReadState } from '../hooks/useHostedTeamDirectorySource';
import type { TeamLifecycleListItemViewModel } from '../view-models/teamLifecycleListViewModel';
import type { HostedTeamDirectoryRow } from '@features/team-directory/renderer';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedTeamLifecycleListProps {
  readonly transport: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>;
  readonly selectedTeamId?: TeamId | null;
  readonly onSelectedTeamIdChange?: (teamId: TeamId) => void;
  readonly refreshSignal?: number;
  /** Controlled by the workspace so a transient list unmount does not erase the browse draft. */
  readonly query?: string;
  readonly onQueryChange?: (query: string) => void;
  readonly selectedStatuses?: ReadonlySet<'running' | 'offline'>;
  readonly onSelectedStatusesChange?: (statuses: ReadonlySet<'running' | 'offline'>) => void;
  /** The production workspace composition owns this single read session. */
  readonly directory?: Readonly<{
    state: HostedTeamDirectoryReadState;
    reload: () => Promise<void>;
  }>;
}

type TeamRowItem = Pick<TeamLifecycleListItemViewModel, 'teamId' | 'displayName' | 'statusTone'>;

const TeamRowContent = ({
  item,
  statusLabel,
}: Readonly<{ item: TeamRowItem; statusLabel: string }>): React.JSX.Element => {
  return (
    <TeamDirectoryRowHeading
      displayName={item.displayName}
      statusLabel={statusLabel}
      statusTone={item.statusTone}
      className="flex w-full min-w-0 items-center gap-3"
      icon={
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-surface-overlay)]">
          <UsersRound className="size-4 text-[var(--color-text-muted)]" aria-hidden="true" />
        </span>
      }
    />
  );
};

interface TeamRowProps {
  readonly item: TeamRowItem;
  readonly statusLabel: string;
  readonly selected: boolean;
  readonly onSelect?: (teamId: TeamId) => void;
}

const TeamRow = ({
  item,
  statusLabel,
  selected,
  onSelect,
}: Readonly<TeamRowProps>): React.JSX.Element => {
  const rowClasses = `flex w-full items-center gap-3 rounded-lg border p-4 text-left ${
    selected
      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
      : 'border-[var(--color-border)]'
  }`;

  return (
    <li data-testid="hosted-team-lifecycle-row" data-team-id={item.teamId}>
      {onSelect ? (
        <Button
          type="button"
          variant="ghost"
          className={`${rowClasses} h-auto justify-start whitespace-normal hover:bg-[var(--color-surface-raised)]`}
          aria-pressed={selected}
          onClick={() => onSelect(item.teamId)}
        >
          <TeamRowContent item={item} statusLabel={statusLabel} />
        </Button>
      ) : (
        <div className={rowClasses}>
          <TeamRowContent item={item} statusLabel={statusLabel} />
        </div>
      )}
    </li>
  );
};

const HostedDirectoryList = ({
  directory,
  selectedTeamId,
  onSelectedTeamIdChange,
  query: controlledQuery,
  onQueryChange,
  selectedStatuses: controlledStatuses,
  onSelectedStatusesChange,
}: Readonly<
  Required<Pick<HostedTeamLifecycleListProps, 'directory'>> &
    Pick<
      HostedTeamLifecycleListProps,
      | 'selectedTeamId'
      | 'onSelectedTeamIdChange'
      | 'query'
      | 'onQueryChange'
      | 'selectedStatuses'
      | 'onSelectedStatusesChange'
    >
>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const [localQuery, setLocalQuery] = useState('');
  const [localStatuses, setLocalStatuses] = useState<ReadonlySet<'running' | 'offline'>>(
    () => new Set()
  );
  const query = controlledQuery ?? localQuery;
  const statuses = controlledStatuses ?? localStatuses;
  const setQuery = onQueryChange ?? setLocalQuery;
  const setStatuses = onSelectedStatusesChange ?? setLocalStatuses;
  const { state, reload } = directory;
  const snapshot = state.snapshot;
  const rows = useMemo<HostedTeamDirectoryRow[]>(
    () =>
      snapshot?.items.map((item) => ({
        source: 'hosted',
        scopeKey: item.workspaceId,
        targetKey: item.teamId,
        displayName: item.displayName,
        runtime: state.runtime.byTeamId.get(item.teamId)?.runtime ?? 'unknown',
      })) ?? [],
    [snapshot, state.runtime.byTeamId]
  );
  const visibleRows = useMemo(
    () =>
      buildTeamDirectoryRows(rows, {
        query,
        selectedStatuses: statuses,
      }),
    [rows, query, statuses]
  );
  const itemsById = useMemo(
    () => new Map(snapshot?.items.map((item) => [item.teamId, item]) ?? []),
    [snapshot]
  );
  const filtered = query.trim().length > 0 || statuses.size > 0;
  const statusEvidenceIncomplete = statuses.size > 0 && state.runtime.phase !== 'complete';
  const select = (targetKey: string): void => {
    if (!snapshot || (state.freshness !== 'fresh' && state.freshness !== 'stale')) return;
    const current = resolveTeamDirectoryOpenIntent(
      {
        scopeKey: state.scopeKey,
        targetKey,
        readEpoch: snapshot.readEpoch,
      },
      { scopeKey: state.scopeKey, readEpoch: snapshot.readEpoch, rows }
    );
    if (current) onSelectedTeamIdChange?.(current.targetKey as TeamId);
  };
  const notice =
    state.freshness === 'failed' || (state.freshness === 'stale' && state.failure)
      ? t('list.loadFailed')
      : state.freshness === 'loading'
        ? t('list.loading')
        : state.freshness === 'refreshing' || state.freshness === 'stale'
          ? 'Refreshing teams...'
          : state.runtime.phase === 'incomplete'
            ? 'Some runtime statuses are unavailable. Refresh to retry.'
            : state.runtime.phase === 'reading'
              ? 'Checking runtime statuses...'
              : null;

  return (
    <section
      className="size-full overflow-auto p-4"
      aria-labelledby="hosted-team-lifecycle-list-title"
      aria-busy={state.freshness === 'loading'}
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2
          id="hosted-team-lifecycle-list-title"
          className="text-base font-semibold text-[var(--color-text)]"
        >
          {t('list.title')}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void reload()}
          aria-label={tCommon('actions.refresh')}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {tCommon('actions.refresh')}
        </Button>
      </header>
      <TeamDirectoryQueryInput
        label={t('list.searchPlaceholder')}
        query={query}
        onQueryChange={setQuery}
        className="mb-3"
      />
      <TeamDirectoryStatusFilter
        selectedStatuses={statuses}
        onSelectedStatusesChange={setStatuses}
        labels={{
          all: t('list.filter.clearAll'),
          running: t('list.status.running'),
          offline: t('list.status.offline'),
        }}
        presentation="buttons"
        ariaLabel={t('list.filter.label')}
        className="mb-3 flex gap-2"
      />
      {statuses.size > 0 ? (
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Clear filters to see teams with unknown runtime status.
        </p>
      ) : null}
      {notice ? (
        <div
          role={state.failure ? 'alert' : 'status'}
          aria-live="polite"
          className="mb-3 text-sm text-[var(--color-text-muted)]"
        >
          {notice}
        </div>
      ) : null}
      {snapshot === null ? null : snapshot.items.length === 0 && state.freshness === 'fresh' ? (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          {t('list.empty.title')}
        </p>
      ) : visibleRows.length === 0 && state.freshness === 'fresh' ? (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          {statusEvidenceIncomplete
            ? 'No confirmed match yet; some runtime statuses are unknown.'
            : filtered
              ? t('list.noMatches')
              : t('list.empty.title')}
        </p>
      ) : visibleRows.length > 0 ? (
        <TeamDirectoryRows
          as="ul"
          ariaLabel={t('list.title')}
          className="grid gap-3"
          rows={visibleRows}
          renderRow={(row) => {
            const item = itemsById.get(row.targetKey as TeamId);
            const label =
              item?.lifecycle === 'deleted'
                ? t('list.status.deleted')
                : item?.lifecycle === 'degraded'
                  ? t('list.status.partialFailure')
                  : row.runtime === 'running'
                    ? t('list.status.running')
                    : row.runtime === 'offline'
                      ? t('list.status.offline')
                      : tCommon('states.unknown');
            const tone =
              item?.lifecycle === 'deleted'
                ? 'danger'
                : item?.lifecycle === 'degraded'
                  ? 'warning'
                  : row.runtime === 'running'
                    ? 'success'
                    : 'muted';
            return (
              <TeamRow
                key={row.targetKey}
                item={{
                  teamId: row.targetKey as TeamId,
                  displayName: row.displayName,
                  statusTone: tone,
                }}
                statusLabel={label}
                selected={row.targetKey === selectedTeamId}
                onSelect={select}
              />
            );
          }}
        />
      ) : null}
    </section>
  );
};

const LegacyHostedTeamLifecycleList = ({
  transport,
  selectedTeamId = null,
  onSelectedTeamIdChange,
  refreshSignal = 0,
}: HostedTeamLifecycleListProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { viewModel, retry } = useTeamLifecycleList(transport, refreshSignal);

  return (
    <section
      className="size-full overflow-auto p-4"
      aria-labelledby="hosted-team-lifecycle-list-title"
      aria-busy={viewModel.state === 'loading'}
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2
          id="hosted-team-lifecycle-list-title"
          className="text-base font-semibold text-[var(--color-text)]"
        >
          {t('list.title')}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={retry}
          aria-label={tCommon('actions.refresh')}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {tCommon('actions.refresh')}
        </Button>
      </header>

      {viewModel.state === 'loading' ? (
        <p role="status" aria-live="polite" className="text-sm text-[var(--color-text-muted)]">
          {t('list.loading')}
        </p>
      ) : null}

      {viewModel.state === 'failure' ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-300" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-red-200">
              {tCommon('states.error')}: {t('list.loadFailed')}
            </p>
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={retry}>
              {t('list.actions.retry')}
            </Button>
          </div>
        </div>
      ) : null}

      {viewModel.state === 'empty' ? (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          {t('list.empty.title')}
        </p>
      ) : null}

      {viewModel.state === 'ready' ? (
        <ul aria-label={t('list.title')} className="grid gap-3">
          {viewModel.items.map((item) => (
            <TeamRow
              key={item.teamId}
              item={item}
              statusLabel={t(item.statusLabelKey)}
              selected={item.teamId === selectedTeamId}
              onSelect={onSelectedTeamIdChange}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
};

export const HostedTeamLifecycleList = (props: HostedTeamLifecycleListProps): React.JSX.Element =>
  props.directory ? (
    <HostedDirectoryList {...props} directory={props.directory} />
  ) : (
    <LegacyHostedTeamLifecycleList {...props} />
  );
