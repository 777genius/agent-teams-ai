import type {
  AgentActionMode,
  AttachmentMeta,
  AttachmentPayload,
  SlashCommandMeta,
  TaskRef,
} from '../models/TeamMessageDeliveryModels';

/**
 * Structural metadata the persistence workflow retains for message rendering.
 * It is deliberately feature-owned rather than a runtime/provider DTO.
 */
export interface TeamMessageToolCall {
  name: string;
  preview?: string;
  toolUseId?: string;
}

export type TeamMessageKind =
  | 'default'
  | 'slash_command'
  | 'slash_command_result'
  | 'task_comment_notification'
  | 'task_stall_remediation'
  | 'member_work_sync_nudge'
  | 'runtime_recovery_nudge'
  | 'agent_error';

export interface TeamMessageCommandOutput {
  stream: 'stdout' | 'stderr';
  commandLabel: string;
}

export interface TeamMessageLeadMember {
  name: string;
  agentType?: string;
  role?: string;
}

export interface TeamMessageLeadContext {
  members?: readonly TeamMessageLeadMember[];
  leadSessionId?: string;
}

export interface TeamMessagePersistenceRequest {
  member: string;
  text: string;
  taskRefs?: TaskRef[];
  commentId?: string;
  actionMode?: AgentActionMode;
  summary?: string;
  from?: string;
  timestamp?: string;
  messageId?: string;
  to?: string;
  color?: string;
  attachments?: AttachmentPayload[];
  source?:
    | 'inbox'
    | 'lead_session'
    | 'lead_process'
    | 'runtime_delivery'
    | 'user_sent'
    | 'system_notification'
    | 'cross_team'
    | 'cross_team_sent';
  leadSessionId?: string;
  conversationId?: string;
  replyToConversationId?: string;
  toolSummary?: string;
  toolCalls?: TeamMessageToolCall[];
  messageKind?: TeamMessageKind;
  workSyncIntent?: 'agenda_sync' | 'review_pickup';
  workSyncIntentKey?: string;
  workSyncReviewRequestEventIds?: string[];
  slashCommand?: SlashCommandMeta;
  commandOutput?: TeamMessageCommandOutput;
}

export interface TeamMessagePersistenceResult {
  deliveredToInbox: boolean;
  deliveredViaStdin?: boolean;
  messageId: string;
  deduplicated?: boolean;
}

type ControllerPersistedMessageField =
  | 'member'
  | 'from'
  | 'text'
  | 'timestamp'
  | 'messageId'
  | 'to'
  | 'color'
  | 'conversationId'
  | 'replyToConversationId'
  | 'toolSummary'
  | 'toolCalls'
  | 'messageKind'
  | 'workSyncIntent'
  | 'workSyncIntentKey'
  | 'workSyncReviewRequestEventIds'
  | 'slashCommand'
  | 'commandOutput'
  | 'taskRefs'
  | 'actionMode'
  | 'commentId'
  | 'summary'
  | 'source'
  | 'leadSessionId'
  | 'attachments';

export type ControllerPersistedMessageRequest = Pick<
  TeamMessagePersistenceRequest,
  ControllerPersistedMessageField
>;

export interface LeadSentMessageRequest {
  from: 'user';
  to: string;
  text: string;
  taskRefs?: TaskRef[];
  summary?: string;
  source: 'user_sent';
  attachments?: AttachmentMeta[];
  leadSessionId?: string;
  messageKind?: TeamMessageKind;
  slashCommand?: SlashCommandMeta;
  messageId?: string;
}

export interface TeamMessageLeadContextPort {
  readLeadContext(teamName: string): Promise<TeamMessageLeadContext | null>;
}

export interface TeamMessageMemberMetaPort {
  readMembers(teamName: string): Promise<readonly TeamMessageLeadMember[]>;
}

export interface TeamMessageControllerPersistencePort {
  sendMessage(
    teamName: string,
    request: ControllerPersistedMessageRequest
  ): TeamMessagePersistenceResult;
  appendSentMessage(teamName: string, request: LeadSentMessageRequest): { messageId?: string };
}

export interface TeamRuntimeRecipientInboxPort {
  sendMessage(
    teamName: string,
    request: TeamMessagePersistenceRequest
  ): Promise<TeamMessagePersistenceResult>;
}

export interface TeamMessageFeedInvalidationPort {
  invalidate(teamName: string): void;
}

export interface TeamMessageIdentityPort {
  createMessageId(): string;
}

export interface TeamMessagePersistenceCoordinatorPorts {
  leadContext: TeamMessageLeadContextPort;
  memberMeta: TeamMessageMemberMetaPort;
  controllerPersistence: TeamMessageControllerPersistencePort;
  runtimeRecipientInbox: TeamRuntimeRecipientInboxPort;
  messageFeed: TeamMessageFeedInvalidationPort;
  identity: TeamMessageIdentityPort;
}

export interface LeadRuntimeContext {
  leadName: string;
  leadSessionId?: string;
}

export interface TeamMessageLeadResolutionPort {
  resolveLeadNameFromConfig(context: TeamMessageLeadContext | null): string;
  resolveLeadName(teamName: string): Promise<string>;
  resolveLeadRuntimeContext(teamName: string): Promise<LeadRuntimeContext>;
  getLeadMemberName(teamName: string): Promise<string | null>;
}

export interface TeamMessagePersistenceWritePort {
  sendMessage(
    teamName: string,
    request: TeamMessagePersistenceRequest
  ): Promise<TeamMessagePersistenceResult>;
  sendRuntimeRecipientMessage(
    teamName: string,
    request: TeamMessagePersistenceRequest
  ): Promise<TeamMessagePersistenceResult>;
  sendDirectToLead(
    teamName: string,
    leadName: string,
    text: string,
    summary?: string,
    attachments?: AttachmentMeta[],
    taskRefs?: TaskRef[],
    messageId?: string
  ): Promise<TeamMessagePersistenceResult>;
}

export type TeamMessagePersistenceDelegate = (
  teamName: string,
  request: TeamMessagePersistenceRequest
) => Promise<TeamMessagePersistenceResult>;

export interface TeamMessageSystemNotificationPort {
  sendSystemNotificationToLead(
    args: {
      teamName: string;
      summary: string;
      text: string;
      taskRefs?: TaskRef[];
    },
    persistMessage?: TeamMessagePersistenceDelegate
  ): Promise<TeamMessagePersistenceResult>;
}

export interface TeamMessagePersistenceFacade
  extends
    TeamMessageLeadResolutionPort,
    TeamMessagePersistenceWritePort,
    TeamMessageSystemNotificationPort {}
