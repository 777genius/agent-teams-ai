/* eslint-disable react-refresh/only-export-components -- TeamListFilterState and EMPTY_TEAM_FILTER shared with TeamListView */
import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getBaseName } from '@renderer/utils/pathUtils';
import { Filter } from 'lucide-react';

import type { TeamSummary } from '@shared/types';

export interface TeamListFilterState {
  selectedStatuses: Set<string>;
}

export const EMPTY_TEAM_FILTER: TeamListFilterState = {
  selectedStatuses: new Set(),
};

function folderName(fullPath: string): string {
  return getBaseName(fullPath) || fullPath;
}

interface TeamListFilterPopoverProps {
  filter: TeamListFilterState;
  selectedProjectPath: string | null;
  teams: TeamSummary[];
  aliveTeams: string[];
  onFilterChange: (filter: TeamListFilterState) => void;
  onProjectChange: (projectPath: string | null) => void;
}

export const TeamListFilterPopover = ({
  filter,
  selectedProjectPath,
  teams,
  aliveTeams,
  onFilterChange,
  onProjectChange,
}: TeamListFilterPopoverProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const activeCount = useMemo(() => {
    let count = 0;
    if (filter.selectedStatuses.size > 0) count += 1;
    return count;
  }, [filter.selectedStatuses]);

  const uniqueProjects = useMemo(() => {
    const paths = new Set<string>();
    for (const team of teams) {
      if (team.projectPath?.trim()) paths.add(team.projectPath.trim());
    }
    if (selectedProjectPath?.trim()) {
      paths.add(selectedProjectPath.trim());
    }
    return [...paths].sort((a, b) => folderName(a).localeCompare(folderName(b)));
  }, [selectedProjectPath, teams]);

  const handleStatusToggle = (status: string): void => {
    const next = new Set(filter.selectedStatuses);
    if (next.has(status)) {
      next.delete(status);
    } else {
      next.add(status);
    }
    onFilterChange({ ...filter, selectedStatuses: next });
  };

  const handleProjectToggle = (project: string): void => {
    onProjectChange(selectedProjectPath === project ? null : project);
  };

  const handleClearAll = (): void => {
    onFilterChange(EMPTY_TEAM_FILTER);
  };

  const aliveSet = useMemo(() => new Set(aliveTeams), [aliveTeams]);
  const runningCount = useMemo(
    () => teams.filter((t) => aliveSet.has(t.teamName)).length,
    [teams, aliveSet]
  );
  const offlineCount = useMemo(
    () => teams.filter((t) => !aliveSet.has(t.teamName)).length,
    [teams, aliveSet]
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="relative h-8 px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              aria-label={t('list.filter.label')}
            >
              <Filter size={14} />
              {activeCount > 0 && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-medium text-white">
                  {activeCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('list.filter.label')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-0">
        {/* Status section */}
        <div className="border-b border-[var(--color-border)] p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {t('list.filter.status')}
          </p>
          <div className="space-y-1.5">
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Radix Checkbox renders a button, not a native input */}
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox
                checked={filter.selectedStatuses.has('running')}
                onCheckedChange={() => handleStatusToggle('running')}
              />
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                {t('list.status.running')}
                <span className="text-[var(--color-text-muted)]">({runningCount})</span>
              </span>
            </label>
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Radix Checkbox renders a button, not a native input */}
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox
                checked={filter.selectedStatuses.has('offline')}
                onCheckedChange={() => handleStatusToggle('offline')}
              />
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-zinc-500" />
                {t('list.status.offline')}
                <span className="text-[var(--color-text-muted)]">({offlineCount})</span>
              </span>
            </label>
          </div>
        </div>

        {/* Project section */}
        {uniqueProjects.length > 0 && (
          <div className="border-b border-[var(--color-border)] p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              {t('list.filter.projectPriority')}
            </p>
            <div className="max-h-40 space-y-1.5 overflow-y-auto">
              {uniqueProjects.map((project) => (
                <label
                  key={project}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]"
                  title={project}
                >
                  <Checkbox
                    checked={selectedProjectPath === project}
                    onCheckedChange={() => handleProjectToggle(project)}
                  />
                  <span className="truncate">{folderName(project)}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end p-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            disabled={activeCount === 0}
            onClick={handleClearAll}
          >
            {t('list.filter.clearAll')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
/* eslint-enable react-refresh/only-export-components -- pair for file-level disable */
