import type { InboxMessage } from '@shared/types';

export interface TeamProvisioningMessagePersistenceLogger {
  warn(message: string): void;
}

export interface TeamProvisioningMessageController {
  messages: {
    appendSentMessage(message: TeamProvisioningPersistedMessagePayload): unknown;
    sendMessage(message: TeamProvisioningPersistedInboxMessagePayload): unknown;
  };
}

export interface TeamProvisioningMessagePersistencePorts {
  createController(input: {
    teamName: string;
    claudeDir: string;
  }): TeamProvisioningMessageController;
  getClaudeBasePath(): string;
  logger: TeamProvisioningMessagePersistenceLogger;
}

export interface TeamProvisioningInboxMessagePersistencePorts extends TeamProvisioningMessagePersistencePorts {
  emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void;
}

export interface TeamProvisioningPersistedMessagePayload extends Record<string, unknown> {
  from: InboxMessage['from'];
  to: InboxMessage['to'];
  text: InboxMessage['text'];
  timestamp: InboxMessage['timestamp'];
  actionMode: InboxMessage['actionMode'];
  commentId: InboxMessage['commentId'];
  summary: InboxMessage['summary'];
  messageId: InboxMessage['messageId'];
  relayOfMessageId: InboxMessage['relayOfMessageId'];
  source: InboxMessage['source'];
  leadSessionId: InboxMessage['leadSessionId'];
  conversationId: InboxMessage['conversationId'];
  replyToConversationId: InboxMessage['replyToConversationId'];
  taskRefs: InboxMessage['taskRefs'];
  attachments: InboxMessage['attachments'];
  color: InboxMessage['color'];
  toolSummary: InboxMessage['toolSummary'];
  toolCalls: InboxMessage['toolCalls'];
  messageKind: InboxMessage['messageKind'];
  workSyncIntent: InboxMessage['workSyncIntent'];
  workSyncIntentKey: InboxMessage['workSyncIntentKey'];
  workSyncReviewRequestEventIds: InboxMessage['workSyncReviewRequestEventIds'];
  slashCommand: InboxMessage['slashCommand'];
  commandOutput: InboxMessage['commandOutput'];
}

export type TeamProvisioningPersistedInboxMessagePayload = Omit<
  TeamProvisioningPersistedMessagePayload,
  'to'
> & {
  member: string;
};

function mapControllerMessagePayload(
  message: InboxMessage
): TeamProvisioningPersistedMessagePayload {
  const actionMode =
    message.actionMode === 'do' || message.actionMode === 'ask' || message.actionMode === 'delegate'
      ? message.actionMode
      : undefined;
  const commentId =
    typeof message.commentId === 'string' && message.commentId.trim()
      ? message.commentId.trim()
      : undefined;

  return {
    from: message.from,
    to: message.to,
    text: message.text,
    timestamp: message.timestamp,
    actionMode,
    commentId,
    summary: message.summary,
    messageId: message.messageId,
    relayOfMessageId: message.relayOfMessageId,
    source: message.source,
    leadSessionId: message.leadSessionId,
    conversationId: message.conversationId,
    replyToConversationId: message.replyToConversationId,
    taskRefs: message.taskRefs,
    attachments: message.attachments,
    color: message.color,
    toolSummary: message.toolSummary,
    toolCalls: message.toolCalls,
    messageKind: message.messageKind,
    workSyncIntent: message.workSyncIntent,
    workSyncIntentKey: message.workSyncIntentKey,
    workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
    slashCommand: message.slashCommand,
    commandOutput: message.commandOutput,
  };
}

function mapControllerInboxMessagePayload(
  recipient: string,
  message: InboxMessage
): TeamProvisioningPersistedInboxMessagePayload {
  const payload = mapControllerMessagePayload(message);
  return {
    member: recipient,
    from: payload.from,
    text: payload.text,
    timestamp: payload.timestamp,
    actionMode: payload.actionMode,
    commentId: payload.commentId,
    summary: payload.summary,
    messageId: payload.messageId,
    relayOfMessageId: payload.relayOfMessageId,
    source: payload.source,
    leadSessionId: payload.leadSessionId,
    conversationId: payload.conversationId,
    replyToConversationId: payload.replyToConversationId,
    taskRefs: payload.taskRefs,
    attachments: payload.attachments,
    color: payload.color,
    toolSummary: payload.toolSummary,
    toolCalls: payload.toolCalls,
    messageKind: payload.messageKind,
    workSyncIntent: payload.workSyncIntent,
    workSyncIntentKey: payload.workSyncIntentKey,
    workSyncReviewRequestEventIds: payload.workSyncReviewRequestEventIds,
    slashCommand: payload.slashCommand,
    commandOutput: payload.commandOutput,
  };
}

function createControllerForTeam(
  teamName: string,
  ports: TeamProvisioningMessagePersistencePorts
): TeamProvisioningMessageController {
  return ports.createController({
    teamName,
    claudeDir: ports.getClaudeBasePath(),
  });
}

export function persistTeamProvisioningSentMessage(
  teamName: string,
  message: InboxMessage,
  ports: TeamProvisioningMessagePersistencePorts
): void {
  try {
    createControllerForTeam(teamName, ports).messages.appendSentMessage(
      mapControllerMessagePayload(message)
    );
  } catch (error) {
    ports.logger.warn(`[${teamName}] sent-message persist failed: ${String(error)}`);
  }
}

export function persistTeamProvisioningInboxMessage(
  teamName: string,
  recipient: string,
  message: InboxMessage,
  ports: TeamProvisioningInboxMessagePersistencePorts
): void {
  try {
    createControllerForTeam(teamName, ports).messages.sendMessage(
      mapControllerInboxMessagePayload(recipient, message)
    );
    ports.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message);
  } catch (error) {
    ports.logger.warn(
      `[${teamName}] inbox-message persist for ${recipient} failed: ${String(error)}`
    );
  }
}
