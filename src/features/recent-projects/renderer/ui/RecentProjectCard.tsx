import './project-row-zebra-card.css';

import { useAppTranslation } from '@features/localization/renderer';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { ActivePulseIndicator } from '@renderer/components/ui/ActivePulseIndicator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { FolderOpen, GitBranch, Terminal } from 'lucide-react';

import type { RecentProjectCardModel } from './recentProjectsModel';

interface RecentProjectCardProps {
  card: RecentProjectCardModel;
  pending?: boolean;
  status?: string;
  onClick: () => void;
  onOpenPath?: () => void;
}

export const RecentProjectCard = ({
  card,
  pending = false,
  status,
  onClick,
  onOpenPath,
}: Readonly<RecentProjectCardProps>): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const { t: tCommon } = useAppTranslation('common');
  const canOpen = card.open.support === 'supported' && card.open.availability === 'available';
  const canReveal = card.reveal.support === 'supported' && card.reveal.availability === 'available';
  const unavailableAction =
    card.open.support === 'supported' && card.open.availability === 'unavailable'
      ? card.open
      : null;
  const deleted = unavailableAction?.cause === 'deleted';
  const revealReason =
    card.reveal.support === 'supported' && card.reveal.availability === 'unavailable'
      ? card.reveal.reason
      : tCommon('providerModelBadges.unavailable');
  const staleActivity = card.activity.kind === 'known' && card.activity.value.freshness === 'stale';
  const counts = card.taskCounts.kind === 'known' ? card.taskCounts.value : null;
  const totalTasks = counts ? counts.pending + counts.inProgress + counts.completed : 0;
  const activeTeams = card.activeTeams.kind === 'known' ? card.activeTeams.value : [];

  return (
    <div
      data-recent-project-cell="project"
      className={cn(
        'project-row-zebra-card group relative flex min-h-[112px] min-w-0 flex-col overflow-hidden transition-colors duration-200',
        deleted && 'bg-red-500/[0.03]'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!canOpen || pending}
        aria-label={`${tCommon('actions.open')} ${card.name}`}
        aria-busy={pending || undefined}
        className="flex min-h-[112px] min-w-0 flex-1 flex-col p-3.5 pr-8 text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-emphasis disabled:cursor-default"
      >
        {activeTeams.length > 0 && <ActivePulseIndicator className="absolute right-3 top-3" />}
        <div className="mb-1 flex min-w-0 items-center gap-1.5 pr-5">
          <h3 className="min-w-0 truncate text-sm font-medium text-text">{card.name}</h3>
          {unavailableAction && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'inline-flex shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium',
                    deleted
                      ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                      : 'border-border bg-surface-overlay text-text-muted'
                  )}
                >
                  {deleted
                    ? t('recentProjects.card.deleted')
                    : tCommon('providerModelBadges.unavailable')}
                </span>
              </TooltipTrigger>
              <TooltipContent>{unavailableAction.reason}</TooltipContent>
            </Tooltip>
          )}
          {card.pathBadge && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0 rounded-full bg-surface-overlay px-1.5 py-0.5 text-[9px] font-medium text-text-muted">
                  {card.pathBadge.label}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-sm">
                <p>{card.pathBadge.description}</p>
                {card.desktopPathDetails?.map((detail) => (
                  <p key={`${detail.label}:${detail.text}`} className="font-mono text-[11px]">
                    {detail.label}: {detail.text}
                  </p>
                ))}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {card.providers.kind === 'known' && card.providers.value.length > 0 && (
          <div className="mb-1 flex items-center gap-1.5">
            {card.providers.value.map((provider) => (
              <Tooltip key={provider.id}>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      'bg-surface-overlay/80 inline-flex items-center rounded-full border border-border p-1',
                      provider.freshness === 'stale' && 'opacity-50'
                    )}
                  >
                    <ProviderBrandLogo providerId={provider.id} className="size-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {provider.id}
                  {provider.freshness === 'stale' ? ' - last known' : ''}
                </TooltipContent>
              </Tooltip>
            ))}
            {card.providers.value.some((provider) => provider.freshness === 'stale') && (
              <span className="text-[10px] text-text-muted">Last known</span>
            )}
          </div>
        )}
        {card.subtitle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="w-full min-w-0 truncate pr-6 font-mono text-[10px] text-text-muted">
                {card.subtitle}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              <p className="font-mono text-[11px]">
                {card.desktopPathDetails?.[0]?.text ?? card.subtitle}
              </p>
            </TooltipContent>
          </Tooltip>
        )}
        {unavailableAction && !deleted && (
          <span className="text-[10px] text-text-muted">{unavailableAction.reason}</span>
        )}
        {card.branch.kind === 'known' ? (
          <span className="mb-auto mt-1 flex min-w-0 items-center gap-1.5 truncate text-[10px] text-text-secondary">
            <GitBranch className="size-3 shrink-0 text-text-muted" />
            {card.branch.value}
          </span>
        ) : (
          <span className="mb-auto" />
        )}
        <span className="mt-3 flex flex-wrap items-center gap-2">
          {counts && counts.inProgress > 0 && (
            <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
              {t('recentProjects.card.taskCounts.active', { count: counts.inProgress })}
            </span>
          )}
          {counts && counts.pending > 0 && (
            <span className="rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] text-yellow-600 dark:text-yellow-400">
              {t('recentProjects.card.taskCounts.pending', { count: counts.pending })}
            </span>
          )}
          {counts && counts.completed > 0 && (
            <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] text-green-600 dark:text-green-400">
              {t('recentProjects.card.taskCounts.done', { count: counts.completed })}
            </span>
          )}
          {card.activity.kind === 'known' && (
            <span className="text-[10px] text-text-muted">
              {card.activity.value.label}
              {staleActivity ? ' (last known)' : ''}
            </span>
          )}
        </span>
        {card.tasksLoading ? (
          <span className="mt-2 flex w-full items-center gap-2">
            <span className="h-1.5 flex-1 animate-pulse rounded-full bg-surface-raised" />
            <span className="h-2.5 w-6 animate-pulse rounded bg-surface-raised" />
          </span>
        ) : (
          totalTasks > 0 &&
          counts && (
            <span className="mt-2 flex w-full items-center gap-2">
              <span
                role="progressbar"
                aria-valuenow={counts.completed}
                aria-valuemin={0}
                aria-valuemax={totalTasks}
                aria-label={`Tasks ${counts.completed}/${totalTasks} completed`}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised"
              >
                <span
                  className="block h-full rounded-full bg-emerald-500"
                  style={{ width: `${Math.round((counts.completed / totalTasks) * 100)}%` }}
                />
              </span>
              <span className="text-[10px] text-text-muted">
                {counts.completed}/{totalTasks}
              </span>
            </span>
          )
        )}
        {activeTeams.length > 0 && (
          <span className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
            <Terminal className="size-3 text-emerald-600 dark:text-emerald-400" />
            {activeTeams.map((team) => (
              <span
                key={team.targetKey}
                className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-600 dark:text-emerald-400"
              >
                {team.displayName}
              </span>
            ))}
          </span>
        )}
      </button>
      {status && (
        <p role="alert" className="px-3.5 pb-2 text-[10px] text-red-700 dark:text-red-300">
          {status}
        </p>
      )}
      {card.reveal.support === 'supported' && onOpenPath && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={tCommon('actions.reveal')}
              onClick={onOpenPath}
              disabled={!canReveal || pending}
              className="absolute bottom-3 right-2 z-10 rounded p-1 text-text-muted hover:bg-surface-overlay hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-emphasis disabled:cursor-not-allowed"
            >
              <FolderOpen className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {canReveal ? tCommon('actions.reveal') : revealReason}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
