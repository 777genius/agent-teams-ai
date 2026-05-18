import { Button } from '@renderer/components/ui/button';
import { FolderGit2, FolderOpen, Search } from 'lucide-react';

import { useRecentProjectsSection } from '../hooks/useRecentProjectsSection';

import { RecentProjectCard } from './RecentProjectCard';

interface RecentProjectsSectionProps {
  searchQuery: string;
}

const titleWidths = [60, 66, 50, 55, 75, 45, 40, 65];
const pathWidths = [80, 75, 85, 66, 70, 80, 60, 72];

function SelectProjectFolderCard({
  onClick,
}: Readonly<{
  onClick: () => void;
}>): React.JSX.Element {
  return (
    <button
      className="hover:bg-surface/30 group relative flex min-h-[120px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-transparent p-4 transition-all duration-300 hover:border-border-emphasis"
      onClick={onClick}
      title="Select a project folder"
    >
      <div className="mb-2 flex size-8 items-center justify-center rounded-md border border-dashed border-border transition-colors duration-300 group-hover:border-border-emphasis">
        <FolderOpen className="size-4 text-text-muted transition-colors group-hover:text-text-secondary" />
      </div>
      <span className="text-xs text-text-muted transition-colors group-hover:text-text-secondary">
        Select Folder
      </span>
    </button>
  );
}

export const RecentProjectsSection = ({
  searchQuery,
}: Readonly<RecentProjectsSectionProps>): React.JSX.Element => {
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="skeleton-card flex min-h-[120px] flex-col rounded-sm border border-border p-4"
            style={{
              animationDelay: `${index * 80}ms`,
              backgroundColor: 'var(--skeleton-base)',
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
          <p className="mb-1 text-sm text-text-secondary">Failed to load projects</p>
          <p className="max-w-xl text-xs text-text-muted">{error}</p>
        </div>
        <button
          onClick={() => void reload()}
          className="rounded-sm border border-border bg-surface-raised px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-border-emphasis hover:text-text"
        >
          Retry
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
        <p className="mb-1 text-sm text-text-secondary">No projects found</p>
        <p className="text-xs text-text-muted">No matches for &quot;{searchQuery}&quot;</p>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
        <div className="mb-4 flex size-12 items-center justify-center rounded-sm border border-border bg-surface-raised">
          <FolderGit2 className="size-6 text-text-muted" />
        </div>
        <p className="mb-1 text-sm text-text-secondary">No recent projects found</p>
        <p className="text-xs text-text-muted">
          Recent Claude and Codex activity will appear here.
        </p>
      </div>
    );
  }

  const hasSelectFolderCard = !searchQuery.trim() && isElectron;

  return (
    <div className="space-y-4">
      <div className="project-row-zebra-grid grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
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
            Load more
          </Button>
        </div>
      )}
    </div>
  );
};
