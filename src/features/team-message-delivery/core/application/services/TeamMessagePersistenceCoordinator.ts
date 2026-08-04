import {
  buildStandaloneSlashCommandMeta,
  parseStandaloneSlashCommand,
} from '../../domain/standaloneSlashCommand';

import type {
  ControllerPersistedMessageRequest,
  LeadRuntimeContext,
  TeamMessageLeadContext,
  TeamMessageLeadMember,
  TeamMessagePersistenceCoordinatorPorts,
  TeamMessagePersistenceDelegate,
  TeamMessagePersistenceFacade,
  TeamMessagePersistenceRequest,
  TeamMessagePersistenceResult,
} from '../ports/TeamMessagePersistencePorts';

const SYSTEM_NOTIFICATION_SOURCE = 'system_notification';

function isLeadMember(member: TeamMessageLeadMember): boolean {
  return (
    member.agentType === 'team-lead' ||
    member.agentType === 'lead' ||
    member.agentType === 'orchestrator' ||
    member.name.trim().toLowerCase() === 'team-lead'
  );
}

function isExplicitLeadRole(role: string | undefined): boolean {
  const normalized = role?.trim().toLowerCase();
  return normalized === 'lead' || normalized === 'team lead' || normalized === 'team-lead';
}

/**
 * Owns generic message persistence and the durable identity needed to address
 * the team lead. Runtime delivery policy remains with the delivery use case.
 */
export class TeamMessagePersistenceCoordinator implements TeamMessagePersistenceFacade {
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
      taskRefs?: TeamMessagePersistenceRequest['taskRefs'];
    },
    persistMessage: TeamMessagePersistenceDelegate = (teamName, request) =>
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
    attachments?: Parameters<TeamMessagePersistenceFacade['sendDirectToLead']>[4],
    taskRefs?: TeamMessagePersistenceRequest['taskRefs'],
    messageId?: string
  ): Promise<TeamMessagePersistenceResult> {
    let leadSessionId: string | undefined;
    try {
      const context = await this.ports.leadContext.readLeadContext(teamName);
      leadSessionId = context?.leadSessionId;
    } catch {
      // Non-critical: the sent row remains durable without session metadata.
    }

    const standaloneCommand = parseStandaloneSlashCommand(text);
    const slashCommand = standaloneCommand
      ? buildStandaloneSlashCommandMeta(standaloneCommand)
      : null;
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

    const standaloneCommand = parseStandaloneSlashCommand(enrichedRequest.text);
    const slashCommand =
      enrichedRequest.slashCommand ??
      (standaloneCommand ? buildStandaloneSlashCommandMeta(standaloneCommand) : null);
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
