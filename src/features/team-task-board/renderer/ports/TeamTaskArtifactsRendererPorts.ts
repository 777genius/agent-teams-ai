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
