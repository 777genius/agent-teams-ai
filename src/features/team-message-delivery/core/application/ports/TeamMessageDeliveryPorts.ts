import type {
  RuntimeDeliveryAttempt,
  RuntimeDeliveryStatus,
} from '../../../contracts/runtime-delivery';
import type {
  RuntimeRelayDelivery,
  RuntimeRelayResult,
  TeamRosterMember,
} from '../../domain/messageDeliveryModels';
import type { AttachmentSupportFailure } from '../../domain/messageDeliveryRoutePolicy';
import type {
  AgentActionMode,
  AttachmentFileData,
  AttachmentMeta,
  AttachmentPayload,
  InboxMessage,
  SendMessageRequest,
  SendMessageResult,
  TaskRef,
  TeamProviderId,
} from '../models/TeamMessageDeliveryModels';

export interface TeamMessageLoggerPort {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LeadRecipientPort {
  getLeadMemberName(teamName: string): Promise<string | null>;
}

export interface TeamMessagePersistencePort {
  sendMessage(teamName: string, request: SendMessageRequest): Promise<TeamMessageDeliveryResult>;
  sendRuntimeRecipientMessage(
    teamName: string,
    request: SendMessageRequest
  ): Promise<TeamMessageDeliveryResult>;
  sendDirectToLead(
    teamName: string,
    leadName: string,
    text: string,
    summary?: string,
    attachments?: AttachmentMeta[],
    taskRefs?: TaskRef[],
    messageId?: string
  ): Promise<TeamMessageDeliveryResult>;
}

export type TeamMessageDeliveryResult = Omit<SendMessageResult, 'runtimeDelivery'> & {
  runtimeDelivery?: RuntimeDeliveryAttempt;
};

export interface DurableTeamRosterPort {
  getMembers(teamName: string): Promise<TeamRosterMember[]>;
  getFallbackMembers(teamName: string): Promise<TeamRosterMember[]>;
}

export interface TeamRuntimeStatusPort {
  isTeamAlive(teamName: string): boolean;
}

export interface RuntimeRecipientRoute {
  providerId?: TeamProviderId;
  requiresRuntimeDelivery: boolean;
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
  resolveRecipientRoute(teamName: string, memberName: string): Promise<RuntimeRecipientRoute>;
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

export interface MessageDeliveryCompatibilityPort {
  requiresGeneratedMessageId(input: {
    providerId?: TeamProviderId;
    isLeadRecipient: boolean;
    replyRecipient: string;
  }): boolean;
  buildRecipientDeliveryText(input: {
    actionModeBlock: string;
    baseText: string;
    isLeadRecipient: boolean;
    memberName: string;
    messageId?: string;
    providerId?: TeamProviderId;
    replyRecipient: string;
    teamName: string;
  }): string;
  attachmentSupportError(failure: AttachmentSupportFailure): string;
}

export type RuntimeDeliveryWarningEvent =
  | {
      kind: 'late-failure';
      memberName: string;
      delivery: RuntimeRelayDelivery;
    }
  | {
      kind: 'late-rejection';
      memberName: string;
      error: unknown;
    }
  | {
      kind: 'status-lookup-failure';
      memberName: string;
      error: unknown;
    }
  | {
      kind: 'status-enrichment-failure';
      memberName: string;
      error: unknown;
    }
  | {
      kind: 'delivery-failure';
      memberName: string;
      delivery: RuntimeRelayDelivery;
    }
  | {
      kind: 'delivery-crash';
      memberName: string;
      reason: string;
    };

export interface RuntimeDeliveryCompatibilityPort {
  shouldLookupStatusAfterRelay(relay: RuntimeRelayResult): boolean;
  statusToRelayResult(status: RuntimeDeliveryStatus): RuntimeRelayResult;
  buildTimeoutRelayResult(statusLookupError?: unknown): RuntimeRelayResult;
  buildMissingDelivery(relay: RuntimeRelayResult): RuntimeRelayDelivery;
  formatWarning(event: RuntimeDeliveryWarningEvent): string | null;
}
