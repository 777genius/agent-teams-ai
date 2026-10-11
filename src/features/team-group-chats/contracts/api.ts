import type { TaskRef } from '@shared/types/teamBoardTask';

export type GroupMembership =
  | { kind: 'fixed'; memberNames: string[] }
  | { kind: 'auto'; excludedMemberNames: string[] };

export interface TeamGroupChatDTO {
  id: string;
  name: string;
  createdAt: string;
  membership: GroupMembership;
  archivedAt: string | null;
  memberNames: string[];
  /** Compatible current recipients; empty when the group is structurally blocked. */
  availableRecipientNames: string[];
  canSend: boolean;
  reason?: string;
}

export interface GroupChatCreateRequest {
  teamName: string;
  id: string;
  name: string;
  selectedMemberNames: string[];
  excludedMemberNames: string[];
  autoIncludeNewMembers: boolean;
}

export interface GroupChatSendRequest {
  teamName: string;
  groupChatId: string;
  messageId: string;
  /** Human-only target; absence addresses all current group members. */
  recipientName?: string;
  text: string;
  summary?: string;
  taskRefs?: TaskRef[];
  relayOfMessageId?: string;
}

export type GroupDeliveryStatus = 'queued' | 'accepted' | 'failed' | 'unknown' | 'skipped';

export interface GroupDeliveryRecipient {
  memberName: string;
  physicalMessageId: string;
  status: GroupDeliveryStatus;
  reason?: string;
}

export interface GroupDeliverySummary {
  recordedAt: string;
  recipients: GroupDeliveryRecipient[];
}

export interface GroupChatSendResult {
  saved: true;
  groupChatId: string;
  messageId: string;
  statusPersisted: boolean;
  deliverySummary?: GroupDeliverySummary;
}

export interface GroupMessageReactionTarget {
  teamName: string;
  groupChatId: string;
  messageId: string;
}

export interface GroupMessageReactionDTO {
  groupChatId: string;
  messageId: string;
  actorNames: string[];
  hasUserReacted: boolean;
  canReact: boolean;
}

/** Agent acknowledgement identifies its actual physical inbound, never a logical post. */
export interface GroupChatReactionRequest {
  teamName: string;
  from: string;
  groupChatId: string;
  relayOfMessageId: string;
}

export interface GroupChatReactionResult {
  saved: true;
  acknowledged: true;
  teamName: string;
  groupChatId: string;
  messageId: string;
  relayOfMessageId: string;
  from: string;
  groupRunKey: string;
}

export interface GroupInboundAcknowledgementTarget {
  teamName: string;
  groupChatId: string;
  memberName: string;
  inboxMessageId: string;
  runId: string;
}

export interface TeamGroupChatsAPI {
  getReaction(request: GroupMessageReactionTarget): Promise<GroupMessageReactionDTO>;
  setReaction(
    request: GroupMessageReactionTarget & { active: boolean }
  ): Promise<GroupMessageReactionDTO>;
  list(request: { teamName: string }): Promise<TeamGroupChatDTO[]>;
  create(request: GroupChatCreateRequest): Promise<TeamGroupChatDTO>;
  setArchived(request: {
    teamName: string;
    groupChatId: string;
    archived: boolean;
  }): Promise<TeamGroupChatDTO>;
  send(request: GroupChatSendRequest): Promise<GroupChatSendResult>;
}
