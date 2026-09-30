import './project-row-zebra-card.css';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { FolderGit2, FolderOpen, Search } from 'lucide-react';

import {
  type RecentProjectsCollectionSource,
  useRecentProjectsCollection,
} from '../hooks/useRecentProjectsCollection';

import { RecentProjectCard } from './RecentProjectCard';

interface RecentProjectsSectionViewProps {
  source: RecentProjectsCollectionSource;
  searchQuery: string;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const titleWidths = [60, 66, 50, 55, 75, 45, 40, 65];
const pathWidths = [80, 75, 85, 66, 70, 80, 60, 72];

export const RecentProjectsSectionView = ({
  source,
  searchQuery,
  loading,
  error,
  reload,
}: Readonly<RecentProjectsSectionViewProps>): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const collection = useRecentProjectsCollection(source, searchQuery);
  const {
    rows,
    canLoadMore,
    loadMore,
    pendingKey,
    message,
    messageKey,
    openProject,
    revealProject,
    runExtension,
  } = collection;
  const extension = source.extensionAction;
  const partial = source.completeness === 'partial';
  const extensionStatus =
    message && messageKey?.startsWith('extension:') ? (
      <p role="alert" className="text-xs text-red-700 dark:text-red-300">
        {message}
      </p>
    ) : null;
  const staleStatus = source.stale ? (
    <p role="status" className="text-xs text-text-secondary">
      Last known projects - refresh to check for updates.
    </p>
  ) : null;

  if (loading) {
    return (
      <div
        className="project-row-zebra-grid grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-recent-projects-grid
      >
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="project-row-zebra-card skeleton-card flex min-h-[112px] flex-col p-3.5"
            style={{ animationDelay: `${index * 80}ms` }}
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

  if ((error || partial || source.stale) && rows.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 rounded-sm border border-dashed border-border px-8 py-16"
        role="alert"
      >
        <FolderGit2 className="size-6 text-text-muted" />
        {(partial || error) && (
          <p className="text-sm text-text-secondary">
            {partial ? t('tokenUsage.partialData') : t('recentProjects.failedToLoad')}
          </p>
        )}
        {error && <p className="max-w-xl text-xs text-text-muted">{error}</p>}
        {staleStatus}
        <Button variant="outline" size="sm" onClick={() => void reload()}>
          {t('recentProjects.retry')}
        </Button>
        {extension && (
          <Button size="sm" onClick={runExtension}>
            {extension.label}
          </Button>
        )}
        {extensionStatus}
      </div>
    );
  }

  if (rows.length === 0 && searchQuery.trim()) {
    return (
      <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
        <Search className="mb-4 size-6 text-text-muted" />
        <p className="mb-1 text-sm text-text-secondary">{t('recentProjects.noProjects')}</p>
        <p className="text-xs text-text-muted">
          {t('recentProjects.noMatches', { query: searchQuery })}
        </p>
        {extensionStatus}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
        <FolderGit2 className="mb-4 size-6 text-text-muted" />
        <p className="mb-1 text-sm text-text-secondary">{t('recentProjects.noRecentProjects')}</p>
        <p className="mb-4 text-xs text-text-muted">{t('recentProjects.emptyDescription')}</p>
        {extension && (
          <Button size="sm" onClick={runExtension}>
            {extension.icon === 'folder' ? (
              <FolderOpen className="size-4" />
            ) : (
              <FolderGit2 className="size-4" />
            )}
            {extension.label}
          </Button>
        )}
        {extensionStatus}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(error || partial) && (
        <div role="alert" className="flex items-center gap-2 text-xs text-text-secondary">
          <span>{error ?? t('tokenUsage.partialData')}</span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t('recentProjects.retry')}
          </Button>
        </div>
      )}
      {staleStatus}
      {extensionStatus}
      <div
        className="project-row-zebra-grid grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-recent-projects-grid
      >
        {!searchQuery.trim() && extension && (
          <button
            type="button"
            className="project-row-zebra-card group relative flex min-h-[112px] flex-col items-center justify-center p-3.5 transition-colors duration-200 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-emphasis"
            onClick={runExtension}
            aria-label={extension.ariaLabel}
            data-recent-project-cell={extension.icon === 'folder' ? 'select-folder' : 'extension'}
          >
            <span className="mb-2 flex size-8 items-center justify-center rounded-md border border-dashed border-border group-hover:border-border-emphasis">
              {extension.icon === 'folder' ? (
                <FolderOpen className="size-4 text-text-muted" />
              ) : (
                <FolderGit2 className="size-4 text-text-muted" />
              )}
            </span>
            <span className="text-xs text-text-muted">{extension.label}</span>
          </button>
        )}
        {rows.map((card) => {
          const identity = card.identity;
          const isPending =
            pendingKey ===
              `open:${identity.scopeKey}:${identity.readEpoch}:${identity.targetKey}` ||
            pendingKey ===
              `reveal:${identity.scopeKey}:${identity.readEpoch}:${identity.targetKey}`;
          return (
            <RecentProjectCard
              key={identity.targetKey}
              card={card}
              pending={isPending}
              status={
                messageKey?.endsWith(
                  `:${identity.scopeKey}:${identity.readEpoch}:${identity.targetKey}`
                )
                  ? (message ?? undefined)
                  : undefined
              }
              onClick={() => openProject(identity)}
              onOpenPath={source.revealProject ? () => revealProject(identity) : undefined}
            />
          );
        })}
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
