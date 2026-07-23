import type {
  OpenCodeRelayDelivery,
  OpenCodeRelayResult,
  TeamRosterMember,
} from '../../domain/messageDeliveryModels';
import type {
  AgentActionMode,
  AttachmentFileData,
  AttachmentMeta,
  AttachmentPayload,
  InboxMessage,
  OpenCodeRuntimeDeliveryStatus,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
  SendMessageRequest,
  SendMessageResult,
  TaskRef,
  TeamProviderId,
} from '@shared/types';

export interface TeamMessageLoggerPort {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LeadRecipientPort {
  getLeadMemberName(teamName: string): Promise<string | null>;
}

export interface TeamMessagePersistencePort {
  sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult>;
  sendRuntimeRecipientMessage(
    teamName: string,
    request: SendMessageRequest
  ): Promise<SendMessageResult>;
  sendDirectToLead(
    teamName: string,
    leadName: string,
    text: string,
    summary?: string,
    attachments?: AttachmentMeta[],
    taskRefs?: TaskRef[],
    messageId?: string
  ): Promise<SendMessageResult>;
}

export interface DurableTeamRosterPort {
  getMembers(teamName: string): Promise<TeamRosterMember[]>;
  getFallbackMembers(teamName: string): Promise<TeamRosterMember[]>;
}

export interface TeamRuntimeStatusPort {
  isTeamAlive(teamName: string): boolean;
}

export interface OpenCodeRelayOptions {
  onlyMessageId?: string;
  source?: 'ui-send';
  deliveryMetadata?: {
    replyRecipient?: string;
    actionMode?: AgentActionMode;
    taskRefs?: TaskRef[];
  };
}

export interface TeamMessageTransportPort {
  sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: AttachmentPayload[]
  ): Promise<void>;
  resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined>;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options?: OpenCodeRelayOptions
  ): Promise<OpenCodeRelayResult>;
  relayLeadInboxMessages(teamName: string): Promise<number>;
  getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null>;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
}

export interface MessageAttachmentStorePort {
  saveAttachments(
    teamName: string,
    messageId: string,
    attachments: AttachmentPayload[]
  ): Promise<Map<string, string>>;
  getAttachments(teamName: string, messageId: string): Promise<AttachmentFileData[]>;
}

export interface MessageIdGeneratorPort {
  createMessageId(): string;
}

export interface ClockPort {
  nowIso(): string;
}

export interface DeadlinePort {
  raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void
  ): Promise<{ kind: 'value'; value: T } | { kind: 'timeout' }>;
  withTimeoutValue<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T>;
}

export interface ActionModeInstructionsPort {
  buildAgentBlock(mode: AgentActionMode | undefined): string;
}

export interface OpenCodeDeliveryImpactPort {
  buildImpact(delivery: OpenCodeRelayDelivery): OpenCodeRuntimeDeliveryUserVisibleImpact;
}
