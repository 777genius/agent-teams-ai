import { normalizePath } from '@renderer/utils/pathNormalize';

import type {
  GlobalTaskDetailState,
  PendingMemberProfileState,
  PendingReviewRequestState,
  PendingTeamSectionFocusState,
  TeamsProjectNavigationIntent,
} from './teamSliceStateTypes';
import type { PaneLayout } from '@renderer/types/panes';
import type { Tab, TabInput } from '@renderer/types/tabs';

export interface TeamNavigationSlice {
  globalTaskDetail: GlobalTaskDetailState | null;
  openGlobalTaskDetail: (teamName: string, taskId: string, commentId?: string) => void;
  closeGlobalTaskDetail: () => void;
  pendingMemberProfile: PendingMemberProfileState | null;
  openMemberProfile: (
    memberName: string,
    teamName?: string,
    focus?: PendingMemberProfileState['focus']
  ) => void;
  closeMemberProfile: () => void;
  pendingTeamSectionFocus: PendingTeamSectionFocusState | null;
  focusTeamSection: (teamName: string, section: PendingTeamSectionFocusState['section']) => void;
  clearTeamSectionFocus: () => void;
  pendingReviewRequest: PendingReviewRequestState | null;
  setPendingReviewRequest: (request: PendingReviewRequestState | null) => void;
  teamsProjectNavigationIntent: TeamsProjectNavigationIntent | null;
  kanbanFilterQuery: string | null;
  clearKanbanFilter: () => void;
  openTeamsTab: (projectPath?: string) => void;
  openTeamTab: (teamName: string, projectPath?: string, taskId?: string) => void;
}

export interface TeamNavigationHostState {
  selectedProjectId: string | null;
  projects: Array<{ id: string; path: string }>;
  paneLayout: PaneLayout;
  teamByName: Record<string, { displayName?: string } | undefined>;
  selectedTeamName: string | null;
  selectedTeamData: { config: { name: string } } | null;
  getAllPaneTabs: () => Tab[];
  openTab: (tab: TabInput) => void;
  selectProject: (projectId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabLabel: (tabId: string, label: string) => void;
}

export interface TeamNavigationStatePort {
  getState: () => TeamNavigationHostState;
  setState: (update: Partial<TeamNavigationSlice>) => void;
}

export interface TeamNavigationSliceDependencies {
  state: TeamNavigationStatePort;
}

export function createTeamNavigationSlice({
  state: { getState, setState },
}: TeamNavigationSliceDependencies): TeamNavigationSlice {
  return {
    globalTaskDetail: null,
    pendingMemberProfile: null,
    pendingTeamSectionFocus: null,
    pendingReviewRequest: null,
    teamsProjectNavigationIntent: null,
    kanbanFilterQuery: null,
    openGlobalTaskDetail: (teamName, taskId, commentId) => {
      setState({ globalTaskDetail: { teamName, taskId, commentId } });
    },
    closeGlobalTaskDetail: () => setState({ globalTaskDetail: null }),
    openMemberProfile: (memberName, teamName, focus) =>
      setState({ pendingMemberProfile: { memberName, teamName, focus } }),
    closeMemberProfile: () => setState({ pendingMemberProfile: null }),
    focusTeamSection: (teamName, section) =>
      setState({ pendingTeamSectionFocus: { teamName, section } }),
    clearTeamSectionFocus: () => setState({ pendingTeamSectionFocus: null }),
    setPendingReviewRequest: (request) => setState({ pendingReviewRequest: request }),
    clearKanbanFilter: () => setState({ kanbanFilterQuery: null }),
    openTeamsTab: (projectPath) => {
      const current = getState();
      const normalizedProjectPath = projectPath?.trim() ?? '';
      setState({
        teamsProjectNavigationIntent:
          normalizedProjectPath && current.selectedProjectId
            ? {
                projectId: current.selectedProjectId,
                projectPath: normalizedProjectPath,
              }
            : null,
      });
      const focusedPane = current.paneLayout.panes.find(
        (pane) => pane.id === current.paneLayout.focusedPaneId
      );
      const teamsTab = focusedPane?.tabs.find((tab) => tab.type === 'teams');
      if (teamsTab) {
        current.setActiveTab(teamsTab.id);
        return;
      }
      current.openTab({
        type: 'teams',
        label: 'Teams',
      });
    },
    openTeamTab: (teamName, projectPath, _taskId) => {
      if (!teamName.trim()) return;
      if (projectPath) {
        const projectState = getState();
        const normalizedProjectPath = normalizePath(projectPath);
        const matchingProject = projectState.projects.find(
          (project) => normalizePath(project.path) === normalizedProjectPath
        );
        if (matchingProject && projectState.selectedProjectId !== matchingProject.id) {
          projectState.selectProject(matchingProject.id);
        }
      }
      const current = getState();
      const teamSummary = current.teamByName[teamName];
      const selectedTeamDisplayName =
        current.selectedTeamName === teamName ? current.selectedTeamData?.config.name : undefined;
      const displayName = teamSummary?.displayName || selectedTeamDisplayName || teamName;
      const existing = current
        .getAllPaneTabs()
        .find((tab) => tab.type === 'team' && tab.teamName === teamName);
      if (existing) {
        current.setActiveTab(existing.id);
        if (existing.label !== displayName) {
          current.updateTabLabel(existing.id, displayName);
        }
        return;
      }
      current.openTab({
        type: 'team',
        label: displayName,
        teamName,
      });
    },
  };
}
