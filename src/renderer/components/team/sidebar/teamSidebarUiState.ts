import { DEFAULT_CLAUDE_LOGS_FILTER } from '../ClaudeLogsFilterPopover';

import type { ClaudeLogsFilterState } from '../ClaudeLogsFilterPopover';
import type { ClaudeLogsViewerState } from '../CliLogsRichView';
import type { MessagesFilterState } from '../messages/MessagesFilterPopover';

export interface TeamMessagesSidebarUiState {
  messagesSearchQuery: string;
  messagesFilter: MessagesFilterState;
  messagesFilterOpen: boolean;
  messagesCollapsed: boolean;
  messagesSearchBarVisible: boolean;
  expandedItemKey: string | null;
  messagesScrollTop: number;
  bottomSheetSnapIndex: number;
}

export interface TeamClaudeLogsSidebarUiState {
  searchQuery: string;
  filter: ClaudeLogsFilterState;
  filterOpen: boolean;
  viewerState: ClaudeLogsViewerState;
}

const messagesStateByTeam = new Map<string, TeamMessagesSidebarUiState>();
const pendingRepliesStateByTeam = new Map<string, Record<string, number>>();
const claudeLogsStateByTeam = new Map<string, TeamClaudeLogsSidebarUiState>();

function cloneMessagesFilter(filter: MessagesFilterState): MessagesFilterState {
  return {
    from: new Set(filter.from),
    to: new Set(filter.to),
    showNoise: filter.showNoise,
  };
}

function cloneClaudeLogsFilter(filter: ClaudeLogsFilterState): ClaudeLogsFilterState {
  return {
    streams: new Set(filter.streams),
    kinds: new Set(filter.kinds),
  };
}

function cloneViewerState(viewerState: ClaudeLogsViewerState): ClaudeLogsViewerState {
  return {
    collapsedGroupIds: new Set(viewerState.collapsedGroupIds),
    expandedItemIds: new Set(viewerState.expandedItemIds),
    expandedSubagentIds: new Set(viewerState.expandedSubagentIds),
    viewport: { ...viewerState.viewport },
  };
}

export function createDefaultMessagesSidebarUiState(): TeamMessagesSidebarUiState {
  return {
    messagesSearchQuery: '',
    messagesFilter: {
      from: new Set(),
      to: new Set(),
      showNoise: false,
    },
    messagesFilterOpen: false,
    messagesCollapsed: true,
    messagesSearchBarVisible: false,
    expandedItemKey: null,
    messagesScrollTop: 0,
    bottomSheetSnapIndex: 2,
  };
}

export function createDefaultClaudeLogsSidebarUiState(): TeamClaudeLogsSidebarUiState {
  return {
    searchQuery: '',
    filter: {
      streams: new Set(DEFAULT_CLAUDE_LOGS_FILTER.streams),
      kinds: new Set(DEFAULT_CLAUDE_LOGS_FILTER.kinds),
    },
    filterOpen: false,
    viewerState: {
      collapsedGroupIds: new Set(),
      expandedItemIds: new Set(),
      expandedSubagentIds: new Set(),
      viewport: { mode: 'edge', edge: 'newest' },
    },
  };
}

export function getTeamMessagesSidebarUiState(teamName: string): TeamMessagesSidebarUiState {
  const state = messagesStateByTeam.get(teamName) ?? createDefaultMessagesSidebarUiState();
  return {
    ...state,
    messagesFilter: cloneMessagesFilter(state.messagesFilter),
  };
}

export function setTeamMessagesSidebarUiState(
  teamName: string,
  state: TeamMessagesSidebarUiState
): void {
  messagesStateByTeam.set(teamName, {
    ...state,
    messagesFilter: cloneMessagesFilter(state.messagesFilter),
  });
}

export function getTeamPendingRepliesState(teamName: string): Record<string, number> {
  return { ...(pendingRepliesStateByTeam.get(teamName) ?? {}) };
}

export function setTeamPendingRepliesState(
  teamName: string,
  pendingRepliesByMember: Record<string, number>
): void {
  pendingRepliesStateByTeam.set(teamName, { ...pendingRepliesByMember });
}

export function getTeamClaudeLogsSidebarUiState(teamName: string): TeamClaudeLogsSidebarUiState {
  const state = claudeLogsStateByTeam.get(teamName) ?? createDefaultClaudeLogsSidebarUiState();
  return {
    searchQuery: state.searchQuery,
    filter: cloneClaudeLogsFilter(state.filter),
    filterOpen: state.filterOpen,
    viewerState: cloneViewerState(state.viewerState),
  };
}

export function setTeamClaudeLogsSidebarUiState(
  teamName: string,
  state: TeamClaudeLogsSidebarUiState
): void {
  claudeLogsStateByTeam.set(teamName, {
    searchQuery: state.searchQuery,
    filter: cloneClaudeLogsFilter(state.filter),
    filterOpen: state.filterOpen,
    viewerState: cloneViewerState(state.viewerState),
  });
}
