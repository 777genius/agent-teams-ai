declare module 'agent-teams-controller' {
  export interface ControllerContextOptions {
    teamName: string;
    claudeDir?: string;
  }

  export interface ControllerTaskApi {
    createTask(flags: Record<string, unknown>): unknown;
    getTask(taskId: string): unknown;
    listTasks(): unknown[];
    listDeletedTasks(): unknown[];
    resolveTaskId(taskRef: string): string;
    setTaskStatus(taskId: string, status: string, actor?: string): unknown;
    startTask(taskId: string, actor?: string): unknown;
    completeTask(taskId: string, actor?: string): unknown;
    softDeleteTask(taskId: string, actor?: string): unknown;
    restoreTask(taskId: string, actor?: string): unknown;
    setTaskOwner(taskId: string, owner: string | null): unknown;
    updateTaskFields(taskId: string, fields: { subject?: string; description?: string }): unknown;
    addTaskComment(taskId: string, flags: Record<string, unknown>): unknown;
    attachTaskFile(taskId: string, flags: Record<string, unknown>): unknown;
    attachCommentFile(taskId: string, commentId: string, flags: Record<string, unknown>): unknown;
    addTaskAttachmentMeta(taskId: string, meta: Record<string, unknown>): unknown;
    removeTaskAttachment(taskId: string, attachmentId: string): unknown;
    setNeedsClarification(taskId: string, value: string | null): unknown;
    linkTask(taskId: string, targetId: string, linkType: string): unknown;
    unlinkTask(taskId: string, targetId: string, linkType: string): unknown;
    taskBriefing(memberName: string): Promise<string>;
  }

  export interface ControllerKanbanApi {
    getKanbanState(): unknown;
    setKanbanColumn(taskId: string, column: string): unknown;
    clearKanban(taskId: string): unknown;
    listReviewers(): string[];
    addReviewer(reviewer: string): string[];
    removeReviewer(reviewer: string): string[];
    updateColumnOrder(columnId: string, orderedTaskIds: string[]): unknown;
  }

  export interface ControllerReviewApi {
    requestReview(taskId: string, flags?: Record<string, unknown>): unknown;
    approveReview(taskId: string, flags?: Record<string, unknown>): unknown;
    requestChanges(taskId: string, flags?: Record<string, unknown>): unknown;
  }

  export interface ControllerMessageApi {
    appendSentMessage(flags: Record<string, unknown>): unknown;
    lookupMessage(messageId: string): { message: Record<string, unknown>; store: string };
    sendMessage(flags: Record<string, unknown>): unknown;
  }

  export interface ControllerProcessApi {
    registerProcess(flags: Record<string, unknown>): unknown;
    stopProcess(flags: Record<string, unknown>): unknown;
    unregisterProcess(flags: Record<string, unknown>): unknown;
    listProcesses(): unknown[];
  }

  export interface ControllerMaintenanceApi {
    reconcileArtifacts(flags?: Record<string, unknown>): unknown;
  }

  export interface ControllerCrossTeamApi {
    sendCrossTeamMessage(flags: Record<string, unknown>): unknown;
    listCrossTeamTargets(flags?: Record<string, unknown>): unknown;
    getCrossTeamOutbox(): unknown;
  }

  export interface AgentBlocksApi {
    AGENT_BLOCK_TAG: string;
    AGENT_BLOCK_OPEN: string;
    AGENT_BLOCK_CLOSE: string;
    AGENT_BLOCK_RE: RegExp;
    stripAgentBlocks(text: string): string;
    wrapAgentBlock(text: string): string;
  }

  export interface AgentTeamsController {
    tasks: ControllerTaskApi;
    kanban: ControllerKanbanApi;
    review: ControllerReviewApi;
    messages: ControllerMessageApi;
    processes: ControllerProcessApi;
    maintenance: ControllerMaintenanceApi;
    crossTeam: ControllerCrossTeamApi;
  }

  /** Context-free protocol text builders, shared across lead and member prompts. */
  export interface ProtocolsApi {
    buildActionModeProtocolText(delegateDescription: string): string;
    MEMBER_DELEGATE_DESCRIPTION: string;
    buildProcessProtocolText(teamName: string): string;
  }

  export type AgentTeamsMcpToolGroupId =
    | 'task'
    | 'kanban'
    | 'review'
    | 'message'
    | 'process'
    | 'runtime'
    | 'crossTeam';

  export interface AgentTeamsMcpToolGroup {
    id: AgentTeamsMcpToolGroupId;
    teammateOperational: boolean;
    toolNames: readonly string[];
  }

  export function createController(options: ControllerContextOptions): AgentTeamsController;

  export const agentBlocks: AgentBlocksApi;

  export const protocols: ProtocolsApi;
  export const AGENT_TEAMS_TASK_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_REVIEW_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_MESSAGE_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_CROSS_TEAM_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_PROCESS_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_KANBAN_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_RUNTIME_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_MCP_TOOL_GROUPS: readonly AgentTeamsMcpToolGroup[];
  export const AGENT_TEAMS_REGISTERED_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES: readonly string[];
}
