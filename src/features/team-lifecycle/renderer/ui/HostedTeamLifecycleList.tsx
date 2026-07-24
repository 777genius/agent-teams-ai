import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { AlertCircle, RefreshCw, UsersRound } from 'lucide-react';

import { useTeamLifecycleList } from '../hooks/useTeamLifecycleList';

import type { TeamLifecycleReadTransportApi } from '../../contracts';
import type {
  TeamLifecycleListItemViewModel,
  TeamLifecycleListStatusTone,
} from '../adapters/teamLifecycleListViewModel';

export interface HostedTeamLifecycleListProps {
  readonly transport: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>;
}

const STATUS_CLASSES: Readonly<Record<TeamLifecycleListStatusTone, string>> = Object.freeze({
  danger: 'bg-red-500/15 text-red-300',
  muted: 'bg-zinc-500/15 text-zinc-400',
  success: 'bg-emerald-500/15 text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-300',
});

const TeamRow = ({
  item,
  statusLabel,
}: Readonly<{ item: TeamLifecycleListItemViewModel; statusLabel: string }>): React.JSX.Element => {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-surface-overlay)]">
        <UsersRound className="size-4 text-[var(--color-text-muted)]" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-text)]">
        {item.displayName}
      </span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASSES[item.statusTone]}`}
      >
        {statusLabel}
      </span>
    </li>
  );
};

export const HostedTeamLifecycleList = ({
  transport,
}: HostedTeamLifecycleListProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { viewModel, retry } = useTeamLifecycleList(transport);

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
            <TeamRow key={item.teamId} item={item} statusLabel={t(item.statusLabelKey)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
};
