import type {
  AddTaskCommentRequest,
  GlobalTask,
  TaskChangePresenceState,
  TaskComment,
  TeamViewSnapshot,
} from '@shared/types';

export interface TeamTaskArtifactFile {
  name: string;
  type: string;
  base64: string;
}

export interface TeamTaskArtifactAnalyticsAttachment {
  size?: number;
  data?: string;
  base64Data?: string;
  base64?: string;
  mimeType?: string;
  type?: string;
}

export interface TeamTaskArtifactsRendererState {
  addCommentError: string | null;
  addingComment: boolean;
  globalTasks: GlobalTask[];
  selectedTeamData: TeamViewSnapshot | null;
  selectedTeamName: string | null;
  teamDataCacheByName: Record<string, TeamViewSnapshot>;
}

export interface TeamTaskArtifactsRendererSlice {
  addCommentError: string | null;
  addingComment: boolean;
  addTaskComment(
    teamName: string,
    taskId: string,
    request: AddTaskCommentRequest
  ): Promise<TaskComment>;
  deleteTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ): Promise<void>;
  getTaskAttachmentData(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ): Promise<string | null>;
  refreshTeamChangePresence(teamName: string): Promise<void>;
  saveTaskAttachment(teamName: string, taskId: string, file: TeamTaskArtifactFile): Promise<void>;
  setSelectedTeamTaskChangePresence(
    teamName: string,
    taskId: string,
    presence: TaskChangePresenceState
  ): void;
  setSelectedTeamTaskChangePresences(
    teamName: string,
    presencesByTaskId: Record<string, TaskChangePresenceState>
  ): void;
}

export interface TeamTaskArtifactsTransport {
  addTaskComment(
    teamName: string,
    taskId: string,
    request: AddTaskCommentRequest
  ): Promise<TaskComment>;
  deleteTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ): Promise<void>;
  getTaskAttachmentData(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ): Promise<string | null>;
  getTaskChangePresence(teamName: string): Promise<Record<string, TaskChangePresenceState>>;
  saveTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: string,
    base64: string
  ): Promise<unknown>;
}

type TeamTaskArtifactsStateUpdate = Partial<TeamTaskArtifactsRendererState>;

export interface TeamTaskArtifactsRendererSliceDependencies<
  StoreState extends TeamTaskArtifactsRendererState,
  RequestScope,
> {
  analytics: {
    classifyError(error: unknown): string;
    recordAttachment(input: {
      attachments: readonly TeamTaskArtifactAnalyticsAttachment[];
      errorClass: string;
      source: 'comment' | 'task';
      success: boolean;
    }): void;
  };
  ids: {
    randomUUID(): string;
  };
  refresh: {
    refreshTeamData(teamName: string): Promise<void>;
  };
  requestScope: {
    capture(teamName: string): RequestScope;
    isCurrent(teamName: string, scope: RequestScope): boolean;
  };
  state: {
    getState(): StoreState;
    selectTeamData(state: StoreState, teamName: string): TeamViewSnapshot | null;
    setState(
      update: TeamTaskArtifactsStateUpdate | ((state: StoreState) => TeamTaskArtifactsStateUpdate)
    ): void;
  };
  transport: TeamTaskArtifactsTransport;
}

export function createTeamTaskArtifactsRendererSlice<
  StoreState extends TeamTaskArtifactsRendererState,
  RequestScope,
>(
  dependencies: TeamTaskArtifactsRendererSliceDependencies<StoreState, RequestScope>
): TeamTaskArtifactsRendererSlice {
  const setSelectedTeamTaskChangePresences = (
    teamName: string,
    presencesByTaskId: Record<string, TaskChangePresenceState>
  ): void => {
    dependencies.state.setState((state) => {
      const updates = Object.entries(presencesByTaskId);
      if (updates.length === 0) {
        return {};
      }

      const presenceByTaskId = new Map(updates);
      const currentTeamData = dependencies.state.selectTeamData(state, teamName);
      let cacheChanged = false;
      const nextTeamData = currentTeamData
        ? {
            ...currentTeamData,
            tasks: currentTeamData.tasks.map((task) => {
              const presence = presenceByTaskId.get(task.id);
              if (!presence || task.changePresence === presence) {
                return task;
              }
              cacheChanged = true;
              return { ...task, changePresence: presence };
            }),
          }
        : null;

      let globalChanged = false;
      const nextGlobalTasks = state.globalTasks.map((task) => {
        if (task.teamName !== teamName) {
          return task;
        }
        const presence = presenceByTaskId.get(task.id);
        if (!presence || task.changePresence === presence) {
          return task;
        }
        globalChanged = true;
        return { ...task, changePresence: presence };
      });

      if (!cacheChanged && !globalChanged) {
        return {};
      }

      return {
        ...(cacheChanged && nextTeamData
          ? {
              teamDataCacheByName: {
                ...state.teamDataCacheByName,
                [teamName]: nextTeamData,
              },
            }
          : {}),
        ...(cacheChanged && state.selectedTeamName === teamName && nextTeamData
          ? { selectedTeamData: nextTeamData }
          : {}),
        ...(globalChanged ? { globalTasks: nextGlobalTasks } : {}),
      };
    });
  };

  return {
    addCommentError: null,
    addingComment: false,

    setSelectedTeamTaskChangePresence: (teamName, taskId, presence) => {
      setSelectedTeamTaskChangePresences(teamName, { [taskId]: presence });
    },

    setSelectedTeamTaskChangePresences,

    refreshTeamChangePresence: async (teamName) => {
      const requestScope = dependencies.requestScope.capture(teamName);
      if (!dependencies.state.selectTeamData(dependencies.state.getState(), teamName)) {
        return;
      }

      try {
        const presenceByTaskId = await dependencies.transport.getTaskChangePresence(teamName);
        if (!dependencies.requestScope.isCurrent(teamName, requestScope)) {
          return;
        }

        dependencies.state.setState((state) => {
          const teamData = dependencies.state.selectTeamData(state, teamName);
          if (!teamData) {
            return {};
          }

          let changed = false;
          const nextTasks = teamData.tasks.map((task) => {
            const nextPresence = presenceByTaskId[task.id] ?? 'unknown';
            if (
              nextPresence === 'unknown' &&
              task.changePresence &&
              task.changePresence !== 'unknown'
            ) {
              return task;
            }
            if (task.changePresence === nextPresence) {
              return task;
            }
            changed = true;
            return { ...task, changePresence: nextPresence };
          });

          if (!changed) {
            return {};
          }

          const nextTeamData = { ...teamData, tasks: nextTasks };
          return {
            teamDataCacheByName: {
              ...state.teamDataCacheByName,
              [teamName]: nextTeamData,
            },
            ...(state.selectedTeamName === teamName ? { selectedTeamData: nextTeamData } : {}),
          };
        });
      } catch {
        // Best-effort lightweight refresh: preserve current UI state on failure.
      }
    },

    saveTaskAttachment: async (teamName, taskId, file) => {
      const attachmentId = dependencies.ids.randomUUID();
      try {
        await dependencies.transport.saveTaskAttachment(
          teamName,
          taskId,
          attachmentId,
          file.name,
          file.type,
          file.base64
        );
        dependencies.analytics.recordAttachment({
          attachments: [file],
          source: 'task',
          success: true,
          errorClass: 'none',
        });
        await dependencies.refresh.refreshTeamData(teamName);
      } catch (error) {
        dependencies.analytics.recordAttachment({
          attachments: [file],
          source: 'task',
          success: false,
          errorClass: dependencies.analytics.classifyError(error),
        });
        throw error;
      }
    },

    deleteTaskAttachment: async (teamName, taskId, attachmentId, mimeType) => {
      await dependencies.transport.deleteTaskAttachment(teamName, taskId, attachmentId, mimeType);
      await dependencies.refresh.refreshTeamData(teamName);
    },

    getTaskAttachmentData: (teamName, taskId, attachmentId, mimeType) =>
      dependencies.transport.getTaskAttachmentData(teamName, taskId, attachmentId, mimeType),

    addTaskComment: async (teamName, taskId, request) => {
      dependencies.state.setState({ addingComment: true, addCommentError: null });
      try {
        const comment = await dependencies.transport.addTaskComment(teamName, taskId, request);
        if (request.attachments?.length) {
          dependencies.analytics.recordAttachment({
            attachments: request.attachments,
            source: 'comment',
            success: true,
            errorClass: 'none',
          });
        }
        dependencies.state.setState({ addingComment: false });
        await dependencies.refresh.refreshTeamData(teamName);
        return comment;
      } catch (error) {
        if (request.attachments?.length) {
          dependencies.analytics.recordAttachment({
            attachments: request.attachments,
            source: 'comment',
            success: false,
            errorClass: dependencies.analytics.classifyError(error),
          });
        }
        dependencies.state.setState({
          addingComment: false,
          addCommentError: error instanceof Error ? error.message : 'Failed to add comment',
        });
        throw error;
      }
    },
  };
}
