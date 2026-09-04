import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { FolderGit2, FolderOpen, Search } from 'lucide-react';

import { useRecentProjectsSection } from '../hooks/useRecentProjectsSection';

import { RecentProjectCard } from './RecentProjectCard';

interface RecentProjectsSectionProps {
  searchQuery: string;
}

const titleWidths = [60, 66, 50, 55, 75, 45, 40, 65];
const pathWidths = [80, 75, 85, 66, 70, 80, 60, 72];

const SelectProjectFolderCard = ({
  onClick,
}: Readonly<{
  onClick: () => void;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  return (
    <button
      className="project-row-zebra-card group relative flex min-h-[112px] flex-col items-center justify-center p-3.5 transition-colors duration-200 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-emphasis"
      onClick={onClick}
      aria-label={t('recentProjects.selectFolderTitle')}
      data-recent-project-cell="select-folder"
    >
      <div className="mb-2 flex size-8 items-center justify-center rounded-md border border-dashed border-border transition-colors duration-300 group-hover:border-border-emphasis">
        <FolderOpen className="size-4 text-text-muted transition-colors group-hover:text-text-secondary" />
      </div>
      <span className="text-xs text-text-muted transition-colors group-hover:text-text-secondary">
        {t('recentProjects.selectFolder')}
      </span>
    </button>
  );
};

export const RecentProjectsSection = ({
  searchQuery,
}: Readonly<RecentProjectsSectionProps>): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const {
    cards,
    loading,
    error,
    canLoadMore,
    isElectron,
    loadMore,
    reload,
    openRecentProject,
    openProjectPath,
    selectProjectFolder,
  } = useRecentProjectsSection(searchQuery);

  if (loading) {
    return (
      <div
        className="project-row-zebra-grid grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-3 xl:grid-cols-4"
        data-recent-projects-grid
      >
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="project-row-zebra-card skeleton-card flex min-h-[112px] flex-col p-3.5"
            style={{
              animationDelay: `${index * 80}ms`,
            }}
          >
            <div
              className="mb-3 size-8 rounded-sm"
              style={{ backgroundColor: 'var(--skeleton-base-light)' }}
            />
            <div
              className="mb-2 h-3.5 rounded-sm"
              style={{
                width: `${titleWidths[index]}%`,
                backgroundColor: 'var(--skeleton-base-light)',
              }}
            />
            <div
              className="mb-auto h-2.5 rounded-sm"
              style={{
                width: `${pathWidths[index]}%`,
                backgroundColor: 'var(--skeleton-base-dim)',
              }}
            />
            <div className="mt-3 flex gap-2">
              <div
                className="h-2.5 w-16 rounded-sm"
                style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
              />
              <div
                className="h-2.5 w-12 rounded-sm"
                style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error && cards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-sm border border-dashed border-border px-8 py-16">
        <div className="mb-1 flex size-12 items-center justify-center rounded-sm border border-border bg-surface-raised">
          <FolderGit2 className="size-6 text-text-muted" />
        </div>
        <div className="text-center">
          <p className="mb-1 text-sm text-text-secondary">{t('recentProjects.failedToLoad')}</p>
          <p className="max-w-xl text-xs text-text-muted">{error}</p>
        </div>
        <button
          onClick={() => void reload()}
          className="rounded-sm border border-border bg-surface-raised px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-border-emphasis hover:text-text"
        >
          {t('recentProjects.retry')}
        </button>
      </div>
    );
  }

  if (cards.length === 0 && searchQuery.trim()) {
    return (
      <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
        <div className="mb-4 flex size-12 items-center justify-center rounded-sm border border-border bg-surface-raised">
          <Search className="size-6 text-text-muted" />
        </div>
        <p className="mb-1 text-sm text-text-secondary">{t('recentProjects.noProjects')}</p>
        <p className="text-xs text-text-muted">
          {t('recentProjects.noMatches', { query: searchQuery })}
        </p>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
        <div className="mb-4 flex size-12 items-center justify-center rounded-sm border border-border bg-surface-raised">
          <FolderGit2 className="size-6 text-text-muted" />
        </div>
        <p className="mb-1 text-sm text-text-secondary">{t('recentProjects.noRecentProjects')}</p>
        <p className="text-xs text-text-muted">{t('recentProjects.emptyDescription')}</p>
      </div>
    );
  }

  const hasSelectFolderCard = !searchQuery.trim() && isElectron;

  return (
    <div className="space-y-4">
      <div
        className="project-row-zebra-grid grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-3 xl:grid-cols-4"
        data-recent-projects-grid
      >
        {hasSelectFolderCard && (
          <SelectProjectFolderCard onClick={() => void selectProjectFolder()} />
        )}
        {cards.map((card) => (
          <RecentProjectCard
            key={card.id}
            card={card}
            onClick={() => void openRecentProject(card.project)}
            onOpenPath={() => void openProjectPath(card.project.primaryPath)}
          />
        ))}
      </div>

      {canLoadMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore}>
            {t('recentProjects.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
};
