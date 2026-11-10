import { ExternalAgentPromptAction } from '@features/external-agent-connection/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Import, Network, Plus, Search } from 'lucide-react';

import { TeamListFilterPopover } from './TeamListFilterPopover';

import type { TeamListFilterState } from './TeamListFilterPopover';
import type { ExternalAgentConnectionApi } from '@features/external-agent-connection/contracts';
import type { TeamSummary } from '@shared/types';

interface Props {
  managementApi: ExternalAgentConnectionApi;
  canCreate: boolean;
  isLight: boolean;
  hasCreationDraft: boolean;
  searchQuery: string;
  onSearchChange(value: string): void;
  filter: TeamListFilterState;
  onFilterChange(value: TeamListFilterState): void;
  projectPath: string | null;
  teams: TeamSummary[];
  aliveTeams: string[];
  onProjectChange(value: string | null): void;
  onManagementApplied(): void;
  onManagementSettings(): void;
  onOrganizations(): void;
  onImport(): void;
  onCreate(): void;
  managementChangesHidden: boolean;
  onClearFilters(): void;
}

/** Compact list controls share one row; the search yields space to the actions. */
export const TeamListHeader = ({
  managementApi,
  canCreate,
  isLight,
  hasCreationDraft,
  searchQuery,
  onSearchChange,
  filter,
  onFilterChange,
  projectPath,
  teams,
  aliveTeams,
  onProjectChange,
  onManagementApplied,
  onManagementSettings,
  onOrganizations,
  onImport,
  onCreate,
  managementChangesHidden,
  onClearFilters,
}: Props): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="mb-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex min-w-[180px] flex-1 items-center gap-2">
          <h2 className="shrink-0 text-base font-semibold text-[var(--color-text)]">
            {t('list.title')}
          </h2>
          <div className="relative min-w-0 max-w-[250px] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <Input
              type="text"
              placeholder={t('list.searchPlaceholder')}
              aria-label={t('list.searchPlaceholder')}
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              className="h-8 min-w-0 pl-8 text-xs"
            />
          </div>
          <TeamListFilterPopover
            filter={filter}
            selectedProjectPath={projectPath}
            teams={teams}
            aliveTeams={aliveTeams}
            onFilterChange={onFilterChange}
            onProjectChange={onProjectChange}
          />
        </div>
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          <ExternalAgentPromptAction
            api={managementApi}
            local={canCreate}
            isLight={isLight}
            onSettings={onManagementSettings}
            onManagementApplied={onManagementApplied}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="size-8 p-0"
                onClick={onOrganizations}
                aria-label={t('list.actions.organizationMap')}
              >
                <Network size={15} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('list.actions.organizationMap')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-8 p-0"
                  disabled={!canCreate}
                  onClick={onImport}
                  aria-label={t('list.actions.importTeam')}
                >
                  <Import size={15} aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">{t('teamImport.title')}</TooltipContent>
          </Tooltip>
          <Button className="gap-2" disabled={!canCreate} onClick={onCreate}>
            <Plus size={15} />
            {hasCreationDraft
              ? t('create.draft.continue', { defaultValue: 'Continue creating' })
              : t('list.actions.createTeam')}
          </Button>
        </div>
      </div>
      {managementChangesHidden ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          {t('managementChanges.hidden')}{' '}
          <Button variant="link" size="sm" onClick={onClearFilters}>
            {t('list.filter.clearAll')}
          </Button>
        </p>
      ) : null}
      {!canCreate ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">{t('list.localOnly')}</p>
      ) : null}
    </div>
  );
};
