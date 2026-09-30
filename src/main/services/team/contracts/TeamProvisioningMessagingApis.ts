import type { TeamProvisioningRuntimeDeliveryApi as FeatureTeamProvisioningRuntimeDeliveryApi } from '@features/team-provisioning/contracts';
import type {
  AgentActionMode,
  AttachmentPayload,
  InboxMessage,
  OpenCodeRuntimeDeliveryStatus,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
  TaskRef,
  TeamProviderId,
} from '@shared/types/team';

export type TeamMessageAttachmentPayload = Pick<AttachmentPayload, 'data' | 'mimeType'> &
  Partial<Pick<AttachmentPayload, 'filename'>>;

export type TeamMessagingDeliverySource =
  | 'watcher'
  | 'ui-send'
  | 'manual'
  | 'watchdog'
  | 'member-work-sync-review-pickup';

export interface TeamMessagingDeliveryMetadata {
  replyRecipient?: string;
  actionMode?: AgentActionMode;
  taskRefs?: TaskRef[];
}

export interface TeamOpenCodeMemberInboxRelayOptions {
  onlyMessageId?: string;
  source?: TeamMessagingDeliverySource;
  deliveryMetadata?: TeamMessagingDeliveryMetadata;
}

export interface TeamOpenCodeMemberInboxDelivery {
  delivered: boolean;
  accepted?: boolean;
  responsePending?: boolean;
  acceptanceUnknown?: boolean;
  responseState?: OpenCodeRuntimeDeliveryStatus['responseState'];
  ledgerStatus?: OpenCodeRuntimeDeliveryStatus['ledgerStatus'];
  ledgerRecordId?: string;
  laneId?: string;
  visibleReplyMessageId?: string;
  visibleReplyCorrelation?: OpenCodeRuntimeDeliveryStatus['visibleReplyCorrelation'];
  queuedBehindMessageId?: string;
  reason?: string;
  diagnostics?: string[];
  userVisibleImpact?: OpenCodeRuntimeDeliveryUserVisibleImpact;
}

export interface TeamOpenCodeMemberInboxRelayResult {
  relayed: number;
  attempted: number;
  delivered: number;
  failed: number;
  lastDelivery?: TeamOpenCodeMemberInboxDelivery;
  diagnostics?: string[];
}

export interface TeamMessagingApi extends Pick<
  FeatureTeamProvisioningRuntimeDeliveryApi,
  'getOpenCodeRuntimeDeliveryStatus'
> {
  sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: TeamMessageAttachmentPayload[]
  ): Promise<void>;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options?: TeamOpenCodeMemberInboxRelayOptions
  ): Promise<TeamOpenCodeMemberInboxRelayResult>;
  relayLeadInboxMessages(teamName: string): Promise<number>;
  resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined>;
  getLiveLeadProcessMessages(teamName: string): InboxMessage[];
  getCurrentLeadSessionId(teamName: string): string | null;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
}

export interface TeamCrossTeamMessagingApi {
  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null;
  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void;
  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void;
  isTeamAlive(teamName: string): boolean;
  relayInboxFileToLiveRecipient(
    teamName: string,
    inboxName: string,
    options?: TeamOpenCodeMemberInboxRelayOptions
  ): Promise<{
    kind: 'ignored' | 'native_lead' | 'native_member_noop' | 'opencode_member';
    relayed: number;
    /** Exact scoped message confirmed by the recent native-lead delivery ledger. */
    recentlyDeliveredMessageId?: string;
    /** Exact message verified in the durable inbox for a native non-lead recipient. */
    durablyStoredMessageId?: string;
    diagnostics?: string[];
    lastDelivery?: TeamOpenCodeMemberInboxDelivery;
  }>;
  relayLeadInboxMessages(teamName: string): Promise<number>;
}
