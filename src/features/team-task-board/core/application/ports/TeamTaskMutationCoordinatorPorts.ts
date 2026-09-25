export interface TaskMutationBoardPort {
  getTask?(taskId: string): unknown;
  getKanbanState?(): unknown;
  setTaskStatus(taskId: string, status: string, actor?: string): unknown;
  softDeleteTask(taskId: string, actor?: string): unknown;
  restoreTask(taskId: string, actor?: string): unknown;
  setTaskOwner(taskId: string, owner: string | null, actor?: string): unknown;
  updateTaskFields(taskId: string, fields: { subject?: string; description?: string }): unknown;
  addTaskAttachmentMeta(taskId: string, metadata: object): unknown;
  removeTaskAttachment(taskId: string, attachmentId: string): unknown;
  setNeedsClarification(taskId: string, value: string | null): unknown;
  linkTask(taskId: string, targetId: string, linkType: string): unknown;
  unlinkTask(taskId: string, targetId: string, linkType: string): unknown;
  addTaskComment(taskId: string, request: object): unknown;
  requestReview(taskId: string, request?: object): unknown;
  clearKanban(taskId: string): unknown;
  setKanbanColumn(taskId: string, column: string, options?: object): unknown;
  approveReview(taskId: string, request?: object): unknown;
  requestChanges(taskId: string, request?: object): unknown;
  updateColumnOrder(columnId: string, orderedTaskIds: string[]): unknown;
}

export interface TeamTaskMutationBoardPort {
  getTaskBoard(teamName: string): TaskMutationBoardPort;
}

export interface TeamTaskMutationProjectionPort {
  invalidateGlobalTaskProjectionCache(): void;
}

export interface TeamTaskMutationLeadRuntimeContext {
  leadName: string;
  leadSessionId?: string;
}

export interface TeamTaskMutationLeadContextPort {
  resolveLeadRuntimeContext(teamName: string): Promise<TeamTaskMutationLeadRuntimeContext>;
}

export interface TeamTaskMutationIdentityPort {
  createId(): string;
}

export interface TeamTaskMutationClockPort {
  nowIso(): string;
}

export interface TeamTaskMutationCoordinatorPorts {
  taskBoards: TeamTaskMutationBoardPort;
  taskProjection: TeamTaskMutationProjectionPort;
  leadContext: TeamTaskMutationLeadContextPort;
  identity: TeamTaskMutationIdentityPort;
  clock: TeamTaskMutationClockPort;
}
