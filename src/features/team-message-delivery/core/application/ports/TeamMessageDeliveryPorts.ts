import type { RuntimeDeliveryStatus } from '../../../contracts/runtime-delivery';
import type {
  RuntimeRelayDelivery,
  RuntimeRelayResult,
  TeamRosterMember,
} from '../../domain/messageDeliveryModels';
import type {
  AgentActionMode,
  AttachmentFileData,
  AttachmentMeta,
  AttachmentPayload,
  InboxMessage,
  SendMessageRequest,
  SendMessageResult,
  TaskRef,
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

export interface RuntimeRelayOptions {
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
  requiresRuntimeDelivery(teamName: string, memberName: string): Promise<boolean>;
  relayRuntimeRecipientInboxMessages(
    teamName: string,
    memberName: string,
    options?: RuntimeRelayOptions
  ): Promise<RuntimeRelayResult>;
  relayLeadInboxMessages(teamName: string): Promise<number>;
  getRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<RuntimeDeliveryStatus | null>;
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

export interface RuntimeDeliveryImpactPort {
  buildImpact(
    delivery: RuntimeRelayDelivery
  ): NonNullable<RuntimeDeliveryStatus['userVisibleImpact']>;
}
