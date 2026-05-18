import { useMemo } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { ActivePulseIndicator } from '@renderer/components/ui/ActivePulseIndicator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { projectColor } from '@renderer/utils/projectColor';
import { FolderGit2, FolderOpen, FolderX, GitBranch, Terminal } from 'lucide-react';

import type { RecentProjectCardModel } from '../adapters/RecentProjectsSectionAdapter';

interface RecentProjectCardProps {
  card: RecentProjectCardModel;
  onClick: () => void;
  onOpenPath: () => void;
}

export const RecentProjectCard = ({
  card,
  onClick,
  onOpenPath,
}: Readonly<RecentProjectCardProps>): React.JSX.Element => {
  const color = useMemo(() => projectColor(card.name), [card.name]);
  const isDeleted = card.filesystemState === 'deleted';
  const FolderIcon = isDeleted ? FolderX : FolderGit2;

  return (
    <button
      onClick={isDeleted ? undefined : onClick}
      aria-disabled={isDeleted}
      className={cn(
        'project-row-zebra-card group relative flex min-h-[120px] flex-col overflow-hidden rounded-lg border border-border p-4 text-left transition-all duration-300 hover:border-border-emphasis',
        isDeleted && 'cursor-default border-red-500/25 bg-red-500/[0.03] hover:border-red-500/35'
      )}
    >
      {card.activeTeams && card.activeTeams.length > 0 && (
        <ActivePulseIndicator className="absolute right-3 top-3" />
      )}

      <div className="mb-1 flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-overlay transition-colors duration-300 group-hover:border-border-emphasis">
          <FolderIcon
            className="size-4 transition-colors group-hover:text-text"
            style={{ color: isDeleted ? 'var(--field-error-text)' : color.icon }}
          />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="min-w-0 truncate text-sm font-medium text-text transition-colors duration-200 group-hover:text-text">
              {card.name}
            </h3>
            {isDeleted && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0 items-center rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[9px] font-medium text-red-300">
                    Deleted
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Project folder no longer exists</TooltipContent>
              </Tooltip>
            )}
            {card.pathSummary && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0 items-center rounded-full bg-surface-overlay px-1.5 py-0.5 text-[9px] font-medium text-text-muted">
                    {card.pathSummary.badgeLabel}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-sm">
                  <div className="space-y-2">
                    <p className="text-[11px] leading-relaxed text-text-secondary">
                      {card.pathSummary.description}
                    </p>
                    <div className="space-y-1.5">
                      {card.pathSummary.paths.map((pathItem) => (
                        <div key={`${pathItem.label}:${pathItem.fullPath}`} className="space-y-0.5">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
                            {pathItem.label}
                          </p>
                          <p className="font-mono text-[11px] text-text">{pathItem.fullPath}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            {card.providerIds.map((providerId) => (
              <span
                key={providerId}
                className="bg-surface-overlay/80 inline-flex items-center rounded-full border border-border p-1"
                title={providerId}
              >
                <ProviderBrandLogo providerId={providerId} className="size-3.5" />
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex w-full min-w-0 items-center gap-1 font-mono text-[10px] text-text-muted">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                if (isDeleted) {
                  return;
                }
                onOpenPath();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (isDeleted) {
                    return;
                  }
                  onOpenPath();
                }
              }}
              className={cn(
                'shrink-0 rounded p-0.5 transition-colors',
                isDeleted
                  ? 'cursor-not-allowed text-red-300/70'
                  : 'cursor-pointer hover:bg-white/5 hover:text-text-secondary'
              )}
            >
              <FolderOpen className="size-3" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isDeleted ? 'Project folder no longer exists' : 'Open'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate">{card.formattedPath}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            <p className="font-mono text-[11px]">{card.project.primaryPath}</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {card.primaryBranch ? (
        <div className="mb-auto mt-1 flex items-center gap-1.5 truncate">
          <GitBranch className="size-3 shrink-0 text-text-muted" />
          <span className="truncate text-[10px] text-text-secondary">{card.primaryBranch}</span>
        </div>
      ) : (
        <div className="mb-auto" />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {card.taskCounts &&
          (card.taskCounts.pending > 0 ||
            card.taskCounts.inProgress > 0 ||
            card.taskCounts.completed > 0) && (
            <>
              {card.taskCounts.inProgress > 0 && (
                <span className="inline-flex items-center rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                  {card.taskCounts.inProgress} active
                </span>
              )}
              {card.taskCounts.pending > 0 && (
                <span className="inline-flex items-center rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                  {card.taskCounts.pending} pending
                </span>
              )}
              {card.taskCounts.completed > 0 && (
                <span className="inline-flex items-center rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                  {card.taskCounts.completed} done
                </span>
              )}
              <span className="text-text-muted">·</span>
            </>
          )}
        <span className="text-[10px] text-text-muted">{card.lastActivityLabel}</span>
      </div>

      {card.tasksLoading ? (
        <div className="mt-2 w-full">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 animate-pulse overflow-hidden rounded-full bg-[var(--color-surface-raised)]" />
            <div className="h-2.5 w-6 animate-pulse rounded bg-[var(--color-surface-raised)]" />
          </div>
        </div>
      ) : (
        card.taskCounts &&
        (() => {
          const pending = card.taskCounts.pending ?? 0;
          const inProgress = card.taskCounts.inProgress ?? 0;
          const completed = card.taskCounts.completed ?? 0;
          const totalTasks = pending + inProgress + completed;
          if (totalTasks === 0) return null;
          const progressPercent = Math.round((completed / totalTasks) * 100);
          return (
            <div className="mt-2 w-full space-y-1">
              <div className="flex items-center gap-2">
                <div
                  className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-raised)]"
                  role="progressbar"
                  aria-valuenow={completed}
                  aria-valuemin={0}
                  aria-valuemax={totalTasks}
                  aria-label={`Tasks ${completed}/${totalTasks} completed`}
                >
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-200"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <span className="shrink-0 text-[10px] font-medium tracking-tight text-[var(--color-text-muted)]">
                  {completed}/{totalTasks}
                </span>
              </div>
            </div>
          );
        })()
      )}

      {card.activeTeams && card.activeTeams.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
          <Terminal className="size-3 shrink-0 text-emerald-400" />
          {card.activeTeams.map((team) => (
            <span
              key={team.teamName}
              className="inline-flex items-center rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400"
            >
              {team.displayName}
            </span>
          ))}
        </div>
      )}
    </button>
  );
};
