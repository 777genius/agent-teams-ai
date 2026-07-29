import { isLeadMember } from '@shared/utils/leadDetection';
import { buildStandaloneSlashCommandMeta } from '@shared/utils/slashCommands';

import type {
  AgentActionMode,
  AttachmentMeta,
  AttachmentPayload,
  CommandOutputMeta,
  InboxMessageKind,
  SlashCommandMeta,
  TaskRef,
  ToolCallMeta,
} from '@shared/types';

const SYSTEM_NOTIFICATION_SOURCE = 'system_notification';

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
  toolCalls?: ToolCallMeta[];
  messageKind?: InboxMessageKind;
  workSyncIntent?: 'agenda_sync' | 'review_pickup';
  workSyncIntentKey?: string;
  workSyncReviewRequestEventIds?: string[];
  slashCommand?: SlashCommandMeta;
  commandOutput?: CommandOutputMeta;
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
  messageKind?: InboxMessageKind;
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

function isExplicitLeadRole(role: string | undefined): boolean {
  const normalized = role?.trim().toLowerCase();
  return normalized === 'lead' || normalized === 'team lead' || normalized === 'team-lead';
}

/**
 * Owns generic message persistence and the durable identity needed to address
 * the team lead. Delivery policy remains with the team-message-delivery use case.
 */
export class TeamMessagePersistenceCoordinator {
  constructor(private readonly ports: TeamMessagePersistenceCoordinatorPorts) {}

  async sendMessage(
    teamName: string,
    request: TeamMessagePersistenceRequest
  ): Promise<TeamMessagePersistenceResult> {
    const enrichedRequest = await this.enrichRequest(teamName, request);
    const result = this.ports.controllerPersistence.sendMessage(
      teamName,
      this.toControllerPersistedMessage(enrichedRequest)
    );
    this.ports.messageFeed.invalidate(teamName);
    return result;
  }

  async sendRuntimeRecipientMessage(
    teamName: string,
    request: TeamMessagePersistenceRequest
  ): Promise<TeamMessagePersistenceResult> {
    const enrichedRequest = await this.enrichRequest(teamName, request);
    const result = await this.ports.runtimeRecipientInbox.sendMessage(teamName, enrichedRequest);
    this.ports.messageFeed.invalidate(teamName);
    return result;
  }

  async sendSystemNotificationToLead(
    args: {
      teamName: string;
      summary: string;
      text: string;
      taskRefs?: TaskRef[];
    },
    persistMessage: (
      teamName: string,
      request: TeamMessagePersistenceRequest
    ) => Promise<TeamMessagePersistenceResult> = (teamName, request) =>
      this.sendMessage(teamName, request)
  ): Promise<TeamMessagePersistenceResult> {
    const leadName = await this.resolveLeadName(args.teamName);
    return persistMessage(args.teamName, {
      member: leadName,
      from: 'system',
      summary: args.summary,
      text: args.text,
      ...(args.taskRefs && args.taskRefs.length > 0 ? { taskRefs: args.taskRefs } : {}),
      source: SYSTEM_NOTIFICATION_SOURCE,
    });
  }

  async sendDirectToLead(
    teamName: string,
    leadName: string,
    text: string,
    summary?: string,
    attachments?: AttachmentMeta[],
    taskRefs?: TaskRef[],
    messageId?: string
  ): Promise<TeamMessagePersistenceResult> {
    let leadSessionId: string | undefined;
    try {
      const context = await this.ports.leadContext.readLeadContext(teamName);
      leadSessionId = context?.leadSessionId;
    } catch {
      // Non-critical: the sent row remains durable without session metadata.
    }

    const slashCommand = buildStandaloneSlashCommandMeta(text);
    const persisted = this.ports.controllerPersistence.appendSentMessage(teamName, {
      from: 'user',
      to: leadName,
      text,
      taskRefs,
      summary,
      source: 'user_sent',
      attachments: attachments?.length ? attachments : undefined,
      leadSessionId,
      ...(slashCommand
        ? {
            messageKind: 'slash_command',
            slashCommand,
          }
        : {}),
      ...(messageId ? { messageId } : {}),
    });
    return {
      deliveredToInbox: false,
      deliveredViaStdin: true,
      messageId: persisted.messageId ?? this.ports.identity.createMessageId(),
    };
  }

  resolveLeadNameFromConfig(context: TeamMessageLeadContext | null): string {
    if (!context) return 'team-lead';
    const members = context.members ?? [];
    const lead =
      members.find((member) => isLeadMember(member)) ??
      members.find((member) => member.name?.trim().toLowerCase() === 'lead') ??
      members.find((member) => isExplicitLeadRole(member.role));
    return lead?.name ?? context.members?.[0]?.name ?? 'team-lead';
  }

  async resolveLeadName(teamName: string): Promise<string> {
    try {
      const context = await this.ports.leadContext.readLeadContext(teamName);
      return this.resolveLeadNameFromConfig(context);
    } catch {
      return 'team-lead';
    }
  }

  async resolveLeadRuntimeContext(teamName: string): Promise<LeadRuntimeContext> {
    try {
      const context = await this.ports.leadContext.readLeadContext(teamName);
      return {
        leadName: this.resolveLeadNameFromConfig(context),
        leadSessionId: context?.leadSessionId,
      };
    } catch {
      return { leadName: 'team-lead' };
    }
  }

  async getLeadMemberName(teamName: string): Promise<string | null> {
    try {
      const context = await this.ports.leadContext.readLeadContext(teamName);

      if (context?.members?.length) {
        const lead = context.members.find((member) => isLeadMember(member));
        if (lead?.name) return lead.name;
      }

      const metaMembers = await this.ports.memberMeta.readMembers(teamName);
      if (metaMembers.length > 0) {
        const lead = metaMembers.find((member) => isLeadMember(member));
        if (lead?.name) return lead.name;
        return metaMembers[0]?.name ?? null;
      }

      return context?.members?.[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  private async enrichRequest(
    teamName: string,
    request: TeamMessagePersistenceRequest
  ): Promise<TeamMessagePersistenceRequest> {
    let enrichedRequest = request;
    if (!enrichedRequest.leadSessionId) {
      try {
        const context = await this.ports.leadContext.readLeadContext(teamName);
        if (context?.leadSessionId) {
          enrichedRequest = { ...enrichedRequest, leadSessionId: context.leadSessionId };
        }
      } catch {
        // Non-critical: persistence can proceed without session metadata.
      }
    }

    const slashCommand =
      enrichedRequest.slashCommand ?? buildStandaloneSlashCommandMeta(enrichedRequest.text);
    if (slashCommand) {
      enrichedRequest = {
        ...enrichedRequest,
        messageKind: 'slash_command',
        slashCommand,
      };
    }
    return enrichedRequest;
  }

  private toControllerPersistedMessage(
    request: TeamMessagePersistenceRequest
  ): ControllerPersistedMessageRequest {
    return {
      member: request.member,
      from: request.from,
      text: request.text,
      timestamp: request.timestamp,
      messageId: request.messageId,
      to: request.to,
      color: request.color,
      conversationId: request.conversationId,
      replyToConversationId: request.replyToConversationId,
      toolSummary: request.toolSummary,
      toolCalls: request.toolCalls,
      messageKind: request.messageKind,
      workSyncIntent: request.workSyncIntent,
      workSyncIntentKey: request.workSyncIntentKey,
      workSyncReviewRequestEventIds: request.workSyncReviewRequestEventIds,
      slashCommand: request.slashCommand,
      commandOutput: request.commandOutput,
      taskRefs: request.taskRefs,
      actionMode: request.actionMode,
      commentId: request.commentId,
      summary: request.summary,
      source: request.source,
      leadSessionId: request.leadSessionId,
      attachments: request.attachments,
    };
  }
}
