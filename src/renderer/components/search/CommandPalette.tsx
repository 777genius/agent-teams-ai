/** Desktop adapter for the shared Dashboard command palette. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { DashboardCommandPalette, usePaletteRead } from '@features/dashboard/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { formatModifierShortcut } from '@renderer/utils/keyboardUtils';
import { formatDistanceToNow } from 'date-fns';
import { Bot, FileText, FolderGit2, Globe, MessageSquare, User, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { RepositoryGroup, SearchResult } from '@renderer/types/data';

type PaletteRow =
  | { kind: 'project'; repo: RepositoryGroup }
  | { kind: 'session'; result: SearchResult };

const ProjectResultItem = ({
  repo,
  selected,
  onClick,
}: {
  repo: RepositoryGroup;
  selected: boolean;
  onClick: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const activity = repo.mostRecentSession
    ? formatDistanceToNow(new Date(repo.mostRecentSession), { addSuffix: true })
    : t('commandPalette.noRecentActivity');
  return (
    <button
      onClick={onClick}
      className={`w-full px-4 py-3 text-left transition-colors ${selected ? 'bg-surface-raised' : 'hover:bg-surface-raised/50'}`}
    >
      <div className="flex items-start gap-3">
        <FolderGit2 className="mt-0.5 size-4 shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text">{repo.name}</div>
          <div className="mt-0.5 truncate font-mono text-xs text-text-muted">
            {repo.worktrees[0]?.path || ''}
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-text-muted">
            <span>{t('commandPalette.sessionsCount', { count: repo.totalSessions })}</span>
            <span>·</span>
            <span>{activity}</span>
          </div>
        </div>
      </div>
    </button>
  );
};

function highlightMatch(context: string, matchedText: string): React.ReactNode {
  const index = context.toLowerCase().indexOf(matchedText.toLowerCase());
  if (index < 0 || !matchedText) return context;
  return (
    <>
      {context.slice(0, index)}
      <mark
        className="rounded px-0.5"
        style={{ backgroundColor: 'var(--highlight-bg)', color: 'var(--highlight-text)' }}
      >
        {context.slice(index, index + matchedText.length)}
      </mark>
      {context.slice(index + matchedText.length)}
    </>
  );
}

const SessionResultItem = ({
  result,
  selected,
  onClick,
  projectName,
}: {
  result: SearchResult;
  selected: boolean;
  onClick: () => void;
  projectName?: string;
}): React.JSX.Element => {
  return (
    <button
      onClick={onClick}
      className={`w-full px-4 py-3 text-left transition-colors ${selected ? 'bg-surface-raised' : 'hover:bg-surface-raised/50'}`}
    >
      <div className="flex items-start gap-3">
        {result.messageType === 'user' ? (
          <User className="mt-0.5 size-4 shrink-0 text-blue-400" />
        ) : (
          <Bot className="mt-0.5 size-4 shrink-0 text-green-400" />
        )}
        <div className="min-w-0 flex-1">
          {projectName && (
            <div className="mb-1 flex items-center gap-2">
              <FolderGit2 className="size-3 text-blue-400" />
              <span className="truncate text-xs font-medium text-blue-400">{projectName}</span>
            </div>
          )}
          <div className="mb-1 flex items-center gap-2">
            <FileText className="size-3 text-text-muted" />
            <span className="truncate text-xs text-text-muted">
              {result.sessionTitle.slice(0, 60)}
              {result.sessionTitle.length > 60 ? '...' : ''}
            </span>
          </div>
          <div className="text-sm leading-relaxed text-text">
            {highlightMatch(result.context, result.matchedText)}
          </div>
          <div className="text-text-muted/60 mt-1 text-xs">
            {new Date(result.timestamp).toLocaleDateString()}{' '}
            {new Date(result.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </button>
  );
};

export const CommandPalette = (): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const {
    commandPaletteOpen,
    closeCommandPalette,
    selectedProjectId,
    navigateToSession,
    repositoryGroups,
    fetchRepositoryGroups,
    selectRepository,
  } = useStore(
    useShallow((state) => ({
      commandPaletteOpen: state.commandPaletteOpen,
      closeCommandPalette: state.closeCommandPalette,
      selectedProjectId: state.selectedProjectId,
      navigateToSession: state.navigateToSession,
      repositoryGroups: state.repositoryGroups,
      fetchRepositoryGroups: state.fetchRepositoryGroups,
      selectRepository: state.selectRepository,
    }))
  );
  const [query, setQuery] = useState('');
  const [globalSearchEnabled, setGlobalSearchEnabled] = useState(false);
  const [browsingProjects, setBrowsingProjects] = useState(false);
  const mode = browsingProjects
    ? 'projects'
    : selectedProjectId || globalSearchEnabled
      ? 'sessions'
      : 'projects';

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setGlobalSearchEnabled(false);
      setBrowsingProjects(false);
    }
  }, [commandPaletteOpen]);
  useEffect(() => {
    if (
      commandPaletteOpen &&
      (mode === 'projects' || globalSearchEnabled) &&
      repositoryGroups.length === 0
    ) {
      void fetchRepositoryGroups();
    }
  }, [
    commandPaletteOpen,
    mode,
    globalSearchEnabled,
    repositoryGroups.length,
    fetchRepositoryGroups,
  ]);

  const filteredProjects = useMemo(() => {
    const search = query.trim().toLowerCase();
    return repositoryGroups
      .filter(
        (repo) =>
          !search ||
          repo.name.toLowerCase().includes(search) ||
          (repo.worktrees[0]?.path || '').toLowerCase().includes(search)
      )
      .slice(0, 10);
  }, [repositoryGroups, query]);
  const trimmedQuery = query.trim();
  const readEnabled =
    commandPaletteOpen &&
    mode === 'sessions' &&
    trimmedQuery.length >= 2 &&
    (globalSearchEnabled || !!selectedProjectId);
  const loadSessions = useCallback(
    async (_signal: AbortSignal) => {
      const result = globalSearchEnabled
        ? await api.searchAllProjects(trimmedQuery, 50)
        : await api.searchSessions(selectedProjectId!, trimmedQuery, 50);
      return { rows: result.results, total: result.totalMatches, partial: !!result.isPartial };
    },
    [globalSearchEnabled, trimmedQuery, selectedProjectId]
  );
  const search = usePaletteRead(
    JSON.stringify([
      commandPaletteOpen,
      mode,
      globalSearchEnabled,
      selectedProjectId,
      trimmedQuery,
    ]),
    readEnabled,
    400,
    loadSessions
  );
  const rows = useMemo<PaletteRow[]>(
    () =>
      mode === 'projects'
        ? filteredProjects.map((repo) => ({ kind: 'project', repo }))
        : search.rows.map((result) => ({ kind: 'session', result })),
    [mode, filteredProjects, search.rows]
  );

  const handleSelect = useCallback(
    (row: PaletteRow) => {
      if (row.kind === 'project') {
        selectRepository(row.repo.id);
        setBrowsingProjects(false);
        setQuery('');
        return;
      }
      const result = row.result;
      closeCommandPalette();
      navigateToSession(result.projectId, result.sessionId, true, {
        query: trimmedQuery,
        messageTimestamp: result.timestamp,
        matchedText: result.matchedText,
        targetGroupId: result.groupId,
        targetMatchIndexInItem: result.matchIndexInItem,
        targetMatchStartOffset: result.matchStartOffset,
        targetMessageUuid: result.messageUuid,
      });
    },
    [closeCommandPalette, navigateToSession, selectRepository, trimmedQuery]
  );

  const renderRow = useCallback(
    (row: PaletteRow, _index: number, selected: boolean, onClick: () => void) => {
      if (row.kind === 'project')
        return <ProjectResultItem repo={row.repo} selected={selected} onClick={onClick} />;
      const projectName = globalSearchEnabled
        ? repositoryGroups.find((repo) =>
            repo.worktrees.some((worktree) => worktree.id === row.result.projectId)
          )?.name
        : undefined;
      return (
        <SessionResultItem
          result={row.result}
          selected={selected}
          onClick={onClick}
          projectName={projectName}
        />
      );
    },
    [globalSearchEnabled, repositoryGroups]
  );

  const currentProjectName = repositoryGroups.find((repo) =>
    repo.worktrees.some((worktree) => worktree.id === selectedProjectId)
  )?.name;
  const modeLabel =
    mode === 'projects' ? (
      <>
        <FolderGit2 className="size-3.5" />
        <span>{t('commandPalette.mode.searchProjects')}</span>
      </>
    ) : (
      <>
        <MessageSquare className="size-3.5" />
        <span>
          {t(
            globalSearchEnabled
              ? 'commandPalette.mode.searchAcrossProjects'
              : 'commandPalette.mode.searchInProject'
          )}
        </span>
        {!globalSearchEnabled && selectedProjectId && (
          <button
            onClick={() => {
              setBrowsingProjects(true);
              setQuery('');
            }}
            className="flex max-w-[220px] items-center gap-1.5 rounded-full bg-surface-raised px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-overlay"
          >
            <span className="truncate">
              {currentProjectName ?? t('commandPalette.currentProject')}
            </span>
            <X className="size-3 shrink-0" />
          </button>
        )}
      </>
    );
  const empty =
    mode === 'projects'
      ? t(
          query.trim()
            ? 'commandPalette.empty.noProjectsForQuery'
            : 'commandPalette.empty.noProjects',
          { query }
        )
      : trimmedQuery.length < 2
        ? t('commandPalette.empty.minChars')
        : search.loading
          ? null
          : t(
              search.partial
                ? 'commandPalette.empty.noFastResults'
                : 'commandPalette.empty.noResults',
              { query }
            );
  const footerText =
    mode === 'projects'
      ? t('commandPalette.footer.projectsCount', { count: filteredProjects.length })
      : search.total > 0
        ? t(
            globalSearchEnabled
              ? 'commandPalette.footer.resultsAcrossProjects'
              : 'commandPalette.footer.results',
            {
              count: search.total,
              speed: search.partial ? t('commandPalette.footer.fastPrefix') : '',
            }
          )
        : t('commandPalette.footer.typeToSearch');
  const footer = (
    <>
      <span>{footerText}</span>
      <div className="flex items-center gap-4">
        <span>
          <kbd className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">
            {t('commandPalette.footer.upDownKey')}
          </kbd>{' '}
          {t('commandPalette.footer.navigate')}
        </span>
        <span>
          <kbd className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">↵</kbd>{' '}
          {t(mode === 'projects' ? 'commandPalette.footer.select' : 'commandPalette.footer.open')}
        </span>
        <span>
          <kbd className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">
            {formatModifierShortcut('G')}
          </kbd>{' '}
          {t('commandPalette.footer.global')}
        </span>
        <span>
          <kbd className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">
            {t('commandPalette.footer.escapeKey')}
          </kbd>{' '}
          {t('commandPalette.footer.close')}
        </span>
      </div>
    </>
  );
  return (
    <DashboardCommandPalette
      open={commandPaletteOpen}
      onClose={closeCommandPalette}
      query={query}
      onQueryChange={setQuery}
      modeKey={`${mode}:${selectedProjectId ?? ''}:${globalSearchEnabled}`}
      title={t(
        mode === 'projects'
          ? 'commandPalette.mode.searchProjects'
          : globalSearchEnabled
            ? 'commandPalette.mode.searchAcrossProjects'
            : 'commandPalette.mode.searchInProject'
      )}
      description={t('commandPalette.footer.navigate')}
      modeLabel={modeLabel}
      placeholder={t(
        mode === 'projects'
          ? 'commandPalette.placeholders.projects'
          : 'commandPalette.placeholders.conversations'
      )}
      rows={rows}
      getRowKey={(row) =>
        row.kind === 'project'
          ? row.repo.id
          : `${row.result.projectId}:${row.result.sessionId}:${row.result.timestamp}:${row.result.matchIndexInItem ?? ''}:${row.result.matchStartOffset ?? ''}`
      }
      renderRow={renderRow}
      onSelect={handleSelect}
      empty={empty}
      error={search.error ? t('states.error') : undefined}
      footer={footer}
      loading={search.loading}
      onShortcutG={() => setGlobalSearchEnabled((enabled) => !enabled)}
      headerAction={
        <button
          onClick={() => setGlobalSearchEnabled((enabled) => !enabled)}
          aria-label={t('commandPalette.global')}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${globalSearchEnabled ? 'bg-blue-500/20 text-blue-400' : 'text-text-muted hover:bg-surface-raised'}`}
        >
          <Globe className="size-3" />
          <span>{t('commandPalette.global')}</span>
        </button>
      }
    />
  );
};
