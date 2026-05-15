import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { createLogger } from '@shared/utils/logger';
import { useShallow } from 'zustand/react/shallow';

import { resolveCommandPaletteItems } from '../../core/application/resolveCommandPaletteItems';
import { executeCommandIntent } from '../adapters/executeCommandIntent';
import {
  createProjectsProvider,
  createSessionsProvider,
  createStaticActionsProvider,
  createTasksProvider,
  createTeamsProvider,
} from '../adapters/providers';

import type { CommandContext } from '../../core/domain/models/CommandContext';
import type { CommandItem } from '../../core/domain/models/CommandItem';
import type { CommandProvider } from '../../core/domain/models/CommandProvider';
import type { SearchNavigationContext } from '@renderer/store/types';
import type React from 'react';

const logger = createLogger('Feature:CommandPalette');
const ASYNC_SEARCH_DEBOUNCE_MS = 250;
const COMMAND_RESULT_LIMIT = 30;

function withoutAsync(provider: CommandProvider): CommandProvider {
  return {
    id: provider.id,
    match: (query, context) => provider.match(query, context),
  };
}

export function useCommandPaletteController(): {
  inputRef: React.RefObject<HTMLInputElement | null>;
  open: boolean;
  query: string;
  setQuery: (query: string) => void;
  items: readonly CommandItem[];
  selectedIndex: number;
  loading: boolean;
  globalSearchEnabled: boolean;
  activeProjectLabel: string | null;
  close: () => void;
  toggleGlobalSearch: () => void;
  handleBackdropClick: (event: React.MouseEvent) => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  executeItem: (item: CommandItem) => Promise<void>;
} {
  const {
    commandPaletteOpen,
    closeCommandPalette,
    selectedProjectId,
    repositoryGroups,
    fetchRepositoryGroups,
    selectRepository,
    navigateToSession,
    teams,
    teamsLoading,
    fetchTeams,
    globalTasks,
    globalTasksInitialized,
    globalTasksLoading,
    fetchAllTasks,
    selectedTeamName,
    openDashboard,
    openTeamsTab,
    openSettingsTab,
    openNotificationsTab,
    openSchedulesTab,
    openExtensionsTab,
    openTeamTab,
    openGlobalTaskDetail,
    openMemberProfile,
  } = useStore(
    useShallow((state) => ({
      commandPaletteOpen: state.commandPaletteOpen,
      closeCommandPalette: () => state.closeCommandPalette(),
      selectedProjectId: state.selectedProjectId,
      repositoryGroups: state.repositoryGroups,
      fetchRepositoryGroups: () => state.fetchRepositoryGroups(),
      selectRepository: (repositoryId: string) => state.selectRepository(repositoryId),
      navigateToSession: (
        projectId: string,
        sessionId: string,
        fromSearch: boolean,
        searchContext?: SearchNavigationContext
      ) => state.navigateToSession(projectId, sessionId, fromSearch, searchContext),
      teams: state.teams,
      teamsLoading: state.teamsLoading,
      fetchTeams: () => state.fetchTeams(),
      globalTasks: state.globalTasks,
      globalTasksInitialized: state.globalTasksInitialized,
      globalTasksLoading: state.globalTasksLoading,
      fetchAllTasks: () => state.fetchAllTasks(),
      selectedTeamName: state.selectedTeamName,
      openDashboard: () => state.openDashboard(),
      openTeamsTab: () => state.openTeamsTab(),
      openSettingsTab: (section?: string) => state.openSettingsTab(section),
      openNotificationsTab: () => state.openNotificationsTab(),
      openSchedulesTab: () => state.openSchedulesTab(),
      openExtensionsTab: () => state.openExtensionsTab(),
      openTeamTab: (teamName: string, projectPath?: string, taskId?: string) =>
        state.openTeamTab(teamName, projectPath, taskId),
      openGlobalTaskDetail: (teamName: string, taskId: string, commentId?: string) =>
        state.openGlobalTaskDetail(teamName, taskId, commentId),
      openMemberProfile: (
        memberName: string,
        teamName?: string,
        focus?: 'profile' | 'messages' | 'logs'
      ) => state.openMemberProfile(memberName, teamName, focus),
    }))
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly CommandItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [globalSearchEnabled, setGlobalSearchEnabled] = useState(false);

  const context = useMemo<CommandContext>(
    () => ({
      selectedProjectId,
      activeTeamName: selectedTeamName,
      globalSearchEnabled,
    }),
    [globalSearchEnabled, selectedProjectId, selectedTeamName]
  );

  const providers = useMemo<readonly CommandProvider[]>(
    () => [
      createStaticActionsProvider(),
      createProjectsProvider(repositoryGroups),
      createTeamsProvider(teams),
      createTasksProvider(globalTasks),
      createSessionsProvider({ searchApi: api, repositoryGroups }),
    ],
    [globalTasks, repositoryGroups, teams]
  );

  const activeProjectLabel = useMemo(() => {
    if (!selectedProjectId) {
      return null;
    }
    return (
      repositoryGroups.find((repo) =>
        repo.worktrees.some((worktree) => worktree.id === selectedProjectId)
      )?.name ?? 'Current project'
    );
  }, [repositoryGroups, selectedProjectId]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      return;
    }

    inputRef.current?.focus();
    setQuery('');
    setItems([]);
    setSelectedIndex(0);
    setLoading(false);
    setGlobalSearchEnabled(false);
  }, [commandPaletteOpen]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      return;
    }

    if (repositoryGroups.length === 0) {
      void fetchRepositoryGroups();
    }
    if (teams.length === 0 && !teamsLoading) {
      void fetchTeams();
    }
    if (!globalTasksInitialized && !globalTasksLoading) {
      void fetchAllTasks();
    }
  }, [
    commandPaletteOpen,
    fetchAllTasks,
    fetchRepositoryGroups,
    fetchTeams,
    globalTasksInitialized,
    globalTasksLoading,
    repositoryGroups.length,
    teams.length,
    teamsLoading,
  ]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      return;
    }

    let disposed = false;
    const syncController = new AbortController();
    void resolveCommandPaletteItems({
      query,
      context,
      providers: providers.map(withoutAsync),
      signal: syncController.signal,
      limit: COMMAND_RESULT_LIMIT,
    }).then((result) => {
      if (!disposed && !result.aborted) {
        setItems(result.items);
      }
      if (!disposed && result.failures.length > 0) {
        logger.warn('Command provider failed during sync resolution', result.failures);
      }
    });

    const hasAsyncProvider = providers.some((provider) => provider.matchAsync);
    const asyncEligible =
      hasAsyncProvider && query.trim().length >= 2 && (globalSearchEnabled || selectedProjectId);

    if (!asyncEligible) {
      setLoading(false);
      return () => {
        disposed = true;
        syncController.abort();
      };
    }

    const asyncController = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      void resolveCommandPaletteItems({
        query,
        context,
        providers,
        signal: asyncController.signal,
        limit: COMMAND_RESULT_LIMIT,
      })
        .then((result) => {
          if (!disposed && !result.aborted) {
            setItems(result.items);
          }
          if (!disposed && result.failures.length > 0) {
            logger.warn('Command provider failed during async resolution', result.failures);
          }
        })
        .finally(() => {
          if (!disposed && !asyncController.signal.aborted) {
            setLoading(false);
          }
        });
    }, ASYNC_SEARCH_DEBOUNCE_MS);

    return () => {
      disposed = true;
      syncController.abort();
      asyncController.abort();
      window.clearTimeout(timeoutId);
      setLoading(false);
    };
  }, [commandPaletteOpen, context, globalSearchEnabled, providers, query, selectedProjectId]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const executeItem = useCallback(
    async (item: CommandItem): Promise<void> => {
      if (item.disabledReason) {
        return;
      }

      const result = await executeCommandIntent(item.intent, {
        selectRepository,
        navigateToSession,
        openDashboard,
        openTeamsTab,
        openSettingsTab,
        openNotificationsTab,
        openSchedulesTab,
        openExtensionsTab,
        openTeamTab,
        openGlobalTaskDetail,
        openMemberProfile,
      });

      if (result.closePalette) {
        closeCommandPalette();
        return;
      }
      if (result.resetQuery) {
        setQuery('');
      }
      if (result.focusInput) {
        window.requestAnimationFrame(() => inputRef.current?.focus());
      }
    },
    [
      closeCommandPalette,
      navigateToSession,
      openDashboard,
      openExtensionsTab,
      openGlobalTaskDetail,
      openMemberProfile,
      openNotificationsTab,
      openSchedulesTab,
      openSettingsTab,
      openTeamTab,
      openTeamsTab,
      selectRepository,
    ]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.code === 'KeyG' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setGlobalSearchEnabled((value) => !value);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeCommandPalette();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((value) => Math.min(value + 1, Math.max(0, items.length - 1)));
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((value) => Math.max(value - 1, 0));
        return;
      }

      if (event.key === 'Enter' && items.length > 0) {
        event.preventDefault();
        const item = items[selectedIndex];
        if (item) {
          void executeItem(item);
        }
      }
    },
    [closeCommandPalette, executeItem, items, selectedIndex]
  );

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget) {
        closeCommandPalette();
      }
    },
    [closeCommandPalette]
  );

  return {
    inputRef,
    open: commandPaletteOpen,
    query,
    setQuery,
    items,
    selectedIndex,
    loading,
    globalSearchEnabled,
    activeProjectLabel,
    close: closeCommandPalette,
    toggleGlobalSearch: () => setGlobalSearchEnabled((value) => !value),
    handleBackdropClick,
    handleKeyDown,
    executeItem,
  };
}
