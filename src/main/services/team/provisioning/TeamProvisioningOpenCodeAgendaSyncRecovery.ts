import { normalizeOpenCodeTaskRefsForComparison } from '../opencode/delivery/OpenCodeRuntimeDeliveryProofMatching';

import {
  hasStableInboxMessageId,
  isOpenCodeProtocolProofMissingRecord,
  openCodeTaskRefsOverlap,
} from './TeamProvisioningInboxRelayPolicy';

import type { OpenCodePromptDeliveryLedgerRecord } from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { InboxMessage, TaskRef } from '@shared/types';

export interface OpenCodeAgendaSyncDeliveryIdentity {
  ok: true;
  laneId: string;
  canonicalMemberName: string;
}

export interface OpenCodeAgendaSyncRecoveryBypassPorts {
  resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeAgendaSyncDeliveryIdentity | null>;
  readLaneState(teamName: string, laneId: string): Promise<string | null>;
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<boolean>;
  listOpenCodePromptDeliveryLedgerRecords(
    teamName: string,
    laneId: string
  ): Promise<OpenCodePromptDeliveryLedgerRecord[] | null>;
}

export async function getOpenCodeAgendaSyncRecoveryBypassMessageIds(
  input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    taskRefs?: TaskRef[];
    foregroundMessages: InboxMessage[];
  },
  ports: OpenCodeAgendaSyncRecoveryBypassPorts
): Promise<Set<string>> {
  const bypassMessageIds = new Set<string>();
  if (input.workSyncIntent !== 'agenda_sync') {
    return bypassMessageIds;
  }

  const expectedRefs = normalizeOpenCodeTaskRefsForComparison(input.taskRefs);
  if (expectedRefs.length === 0) {
    return bypassMessageIds;
  }

  const candidateMessages = input.foregroundMessages.filter(
    (message): message is InboxMessage & { messageId: string } => {
      if (!hasStableInboxMessageId(message)) {
        return false;
      }
      if (typeof message.text !== 'string' || message.text.trim().length === 0) {
        return false;
      }
      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        return false;
      }
      return true;
    }
  );
  if (candidateMessages.length === 0) {
    return bypassMessageIds;
  }

  const identity = await ports
    .resolveOpenCodeMemberDeliveryIdentity(input.teamName, input.memberName)
    .catch(() => null);
  if (!identity?.ok) {
    return bypassMessageIds;
  }

  const laneState = await ports.readLaneState(input.teamName, identity.laneId).catch(() => null);
  if (laneState === null || laneState === 'unreadable') {
    return bypassMessageIds;
  }
  const laneActive =
    laneState === 'active' ||
    (await ports
      .tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
        laneId: identity.laneId,
      })
      .catch(() => false));
  if (!laneActive) {
    return bypassMessageIds;
  }

  const records = await ports
    .listOpenCodePromptDeliveryLedgerRecords(input.teamName, identity.laneId)
    .catch(() => null);
  const proofMissingRecords = (records ?? []).filter(
    (record) =>
      record.teamName.trim().toLowerCase() === input.teamName.trim().toLowerCase() &&
      record.memberName.trim().toLowerCase() === identity.canonicalMemberName.trim().toLowerCase() &&
      record.laneId === identity.laneId &&
      record.status === 'failed_terminal' &&
      !record.inboxReadCommittedAt &&
      openCodeTaskRefsOverlap(record.taskRefs, expectedRefs) &&
      isOpenCodeProtocolProofMissingRecord(record)
  );
  if (proofMissingRecords.length === 0) {
    return bypassMessageIds;
  }

  const proofMissingMessageIds = new Set(
    proofMissingRecords.map((record) => record.inboxMessageId.trim()).filter(Boolean)
  );
  for (const message of candidateMessages) {
    const messageId = message.messageId.trim();
    if (proofMissingMessageIds.has(messageId)) {
      bypassMessageIds.add(messageId);
    }
  }

  return bypassMessageIds;
}
