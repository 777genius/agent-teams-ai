import { createStore } from 'zustand/vanilla';

import {
  createTeamNavigationSlice,
  type TeamNavigationHostState,
  type TeamNavigationSlice,
} from '../../../src/renderer/store/team/createTeamNavigationSlice';

import type { PaneLayout } from '../../../src/renderer/types/panes';
import type { Tab, TabInput } from '../../../src/renderer/types/tabs';
import type { Mock } from 'vitest';

interface TestState extends TeamNavigationHostState, TeamNavigationSlice {
  openTab: Mock<(tab: TabInput) => void>;
  selectProject: Mock<(projectId: string) => void>;
  setActiveTab: Mock<(tabId: string) => void>;
  updateTabLabel: Mock<(tabId: string, label: string) => void>;
}

const createTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'tab-1',
  type: 'team',
  teamName: 'alpha',
  label: 'Alpha',
  createdAt: 1,
  ...overrides,
});

const createPaneLayout = (tabs: Tab[] = [], backgroundTabs: Tab[] = []): PaneLayout => ({
  panes: [
    {
      id: 'pane-focused',
      tabs,
      activeTabId: tabs[0]?.id ?? null,
      selectedTabIds: [],
      widthFraction: backgroundTabs.length > 0 ? 0.5 : 1,
    },
    ...(backgroundTabs.length > 0
      ? [
          {
            id: 'pane-background',
            tabs: backgroundTabs,
            activeTabId: backgroundTabs[0]?.id ?? null,
            selectedTabIds: [],
            widthFraction: 0.5,
          },
        ]
      : []),
  ],
  focusedPaneId: 'pane-focused',
});

function createNavigationStore(overrides: Partial<TeamNavigationHostState> = {}) {
  return createStore<TestState>()((set, get) => {
    const openTab = vi.fn<(tab: TabInput) => void>();
    const selectProject = vi.fn<(projectId: string) => void>();
    const setActiveTab = vi.fn<(tabId: string) => void>();
    const updateTabLabel = vi.fn<(tabId: string, label: string) => void>();
    const hostState: TeamNavigationHostState = {
      selectedProjectId: 'project-alpha',
      projects: [
        { id: 'project-alpha', path: '/work/alpha' },
        { id: 'project-beta', path: '/work/beta' },
      ],
      paneLayout: createPaneLayout(),
      teamByName: {},
      selectedTeamName: null,
      selectedTeamData: null,
      getAllPaneTabs: () => get().paneLayout.panes.flatMap((pane) => pane.tabs),
      openTab,
      selectProject,
      setActiveTab,
      updateTabLabel,
      ...overrides,
    };

    return {
      ...hostState,
      openTab,
      selectProject,
      setActiveTab,
      updateTabLabel,
      ...createTeamNavigationSlice({
        state: {
          getState: get,
          setState: (update) => set(update),
        },
      }),
    };
  });
}

describe('createTeamNavigationSlice', () => {
  it('owns transient navigation state without changing Zustand merge semantics', () => {
    const store = createNavigationStore();
    const reviewRequest = {
      taskId: 'task-1',
      filePath: 'src/index.ts',
      requestOptions: { owner: 'alice', status: 'in_progress' },
    };

    expect(store.getState()).toMatchObject({
      globalTaskDetail: null,
      pendingMemberProfile: null,
      pendingTeamSectionFocus: null,
      pendingReviewRequest: null,
      teamsProjectNavigationIntent: null,
      kanbanFilterQuery: null,
    });

    store.getState().openGlobalTaskDetail('alpha', 'task-1', 'comment-1');
    store.getState().openMemberProfile('alice', 'alpha', 'messages');
    store.getState().focusTeamSection('alpha', 'messages');
    store.getState().setPendingReviewRequest(reviewRequest);
    store.setState({ kanbanFilterQuery: 'owner:alice' });
    store.getState().clearKanbanFilter();

    expect(store.getState()).toMatchObject({
      globalTaskDetail: { teamName: 'alpha', taskId: 'task-1', commentId: 'comment-1' },
      pendingMemberProfile: { memberName: 'alice', teamName: 'alpha', focus: 'messages' },
      pendingTeamSectionFocus: { teamName: 'alpha', section: 'messages' },
      pendingReviewRequest: reviewRequest,
      kanbanFilterQuery: null,
      selectedProjectId: 'project-alpha',
    });

    store.getState().closeGlobalTaskDetail();
    store.getState().closeMemberProfile();
    store.getState().clearTeamSectionFocus();
    store.getState().setPendingReviewRequest(null);

    expect(store.getState()).toMatchObject({
      globalTaskDetail: null,
      pendingMemberProfile: null,
      pendingTeamSectionFocus: null,
      pendingReviewRequest: null,
    });
  });

  it('records project-scoped Teams intent and focuses only a Teams tab in the focused pane', () => {
    const teamsTab = createTab({
      id: 'teams-focused',
      type: 'teams',
      teamName: undefined,
      label: 'Teams',
    });
    const store = createNavigationStore({ paneLayout: createPaneLayout([teamsTab]) });

    store.getState().openTeamsTab('  /work/alpha  ');

    expect(store.getState().teamsProjectNavigationIntent).toEqual({
      projectId: 'project-alpha',
      projectPath: '/work/alpha',
    });
    expect(store.getState().setActiveTab).toHaveBeenCalledWith('teams-focused');
    expect(store.getState().openTab).not.toHaveBeenCalled();

    store.getState().openTeamsTab();

    expect(store.getState().teamsProjectNavigationIntent).toBeNull();
  });

  it('opens a Teams tab when the focused pane does not already contain one', () => {
    const backgroundTeamsTab = createTab({
      id: 'teams-background',
      type: 'teams',
      teamName: undefined,
      label: 'Teams',
    });
    const store = createNavigationStore({
      selectedProjectId: null,
      paneLayout: createPaneLayout([], [backgroundTeamsTab]),
    });

    store.getState().openTeamsTab('/work/alpha');

    expect(store.getState().teamsProjectNavigationIntent).toBeNull();
    expect(store.getState().setActiveTab).not.toHaveBeenCalled();
    expect(store.getState().openTab).toHaveBeenCalledWith({
      type: 'teams',
      label: 'Teams',
    });
  });

  it('selects a matching project and focuses and relabels an existing team tab', () => {
    const teamTab = createTab({ id: 'team-alpha', label: 'Old Alpha' });
    const store = createNavigationStore({
      selectedProjectId: 'project-beta',
      paneLayout: createPaneLayout([teamTab]),
      teamByName: { alpha: { displayName: 'Alpha Team' } },
    });

    store.getState().openTeamTab('alpha', '/work/alpha', 'task-ignored');

    expect(store.getState().selectProject).toHaveBeenCalledWith('project-alpha');
    expect(store.getState().setActiveTab).toHaveBeenCalledWith('team-alpha');
    expect(store.getState().updateTabLabel).toHaveBeenCalledWith('team-alpha', 'Alpha Team');
    expect(store.getState().openTab).not.toHaveBeenCalled();
  });

  it('opens a new team tab with the selected snapshot label and ignores blank names', () => {
    const store = createNavigationStore({
      selectedTeamName: 'alpha',
      selectedTeamData: { config: { name: 'Selected Alpha' } },
    });

    store.getState().openTeamTab('   ');
    expect(store.getState().openTab).not.toHaveBeenCalled();

    store.getState().openTeamTab('alpha');

    expect(store.getState().openTab).toHaveBeenCalledWith({
      type: 'team',
      label: 'Selected Alpha',
      teamName: 'alpha',
    });
  });
});
