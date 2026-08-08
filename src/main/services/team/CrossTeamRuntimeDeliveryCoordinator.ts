import {
  CrossTeamOutbox,
  type CrossTeamOutboxMessage,
  CrossTeamRuntimeDeliveryIdempotencyConflictError,
} from './CrossTeamOutbox';

import type { TeamCrossTeamMessagingApi } from './contracts/TeamProvisioningMessagingApis';
import type { CrossTeamMessage, CrossTeamSendResult } from '@shared/types';

type RuntimeDeliveryRelayResult = Awaited<
  ReturnType<TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']>
>;

export type CrossTeamRuntimeDeliveryMessagingPort = Pick<
  TeamCrossTeamMessagingApi,
  'relayInboxFileToLiveRecipient'
>;

export type CrossTeamRuntimeDeliveryOutboxPort = Pick<
  CrossTeamOutbox,
  'appendIfNotRecent' | 'markRuntimeDeliveryAccepted'
>;

type SettledCrossTeamMessage = CrossTeamMessage & {
  toMember: string;
  conversationId: string;
};

export interface CrossTeamRuntimeDeliveryInput {
  fromTeam: string;
  targetMemberName: string;
  outboxMessage: SettledCrossTeamMessage;
  requireRuntimeDelivery: boolean;
  stableDedupeIdentity: boolean;
  timestampWasProvided: boolean;
  callerMessageId?: string;
  legacyToMember?: string;
  appendToInbox(): Promise<void>;
  appendSenderCopy(message: CrossTeamOutboxMessage): void;
}

export class CrossTeamRuntimeDeliveryCoordinator {
  private readonly receiptSettlements = new Map<string, Promise<void>>();

  constructor(
    private readonly messaging: CrossTeamRuntimeDeliveryMessagingPort | null,
    private readonly outbox: CrossTeamRuntimeDeliveryOutboxPort = new CrossTeamOutbox(),
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async coordinate(input: CrossTeamRuntimeDeliveryInput): Promise<CrossTeamSendResult> {
    const duplicate = await this.appendOrSettleDuplicate(input);
    const settledMessage = duplicate ?? input.outboxMessage;
    const targetMemberName = settledMessage.toMember ?? input.targetMemberName;

    if (input.requireRuntimeDelivery) {
      await this.settleRequiredRuntimeDelivery(input.fromTeam, settledMessage, targetMemberName);
    }

    if (!duplicate || input.requireRuntimeDelivery) {
      input.appendSenderCopy(settledMessage);
    }

    return {
      messageId: settledMessage.messageId,
      deliveredToInbox: true,
      ...(duplicate ? { deduplicated: true } : {}),
      toTeam: settledMessage.toTeam,
      toMember: targetMemberName,
    };
  }

  private async appendOrSettleDuplicate(
    input: CrossTeamRuntimeDeliveryInput
  ): Promise<CrossTeamOutboxMessage | null> {
    try {
      const { duplicate } = await this.outbox.appendIfNotRecent(
        input.fromTeam,
        input.outboxMessage,
        () => input.appendToInbox(),
        undefined,
        {
          stableIdentity: input.stableDedupeIdentity,
          callerMessageId: input.callerMessageId,
          ...(input.legacyToMember ? { legacyToMember: input.legacyToMember } : {}),
        }
      );
      return duplicate;
    } catch (error) {
      return this.classifyIdempotencyConflict(error, input);
    }
  }

  private classifyIdempotencyConflict(
    error: unknown,
    input: CrossTeamRuntimeDeliveryInput
  ): CrossTeamOutboxMessage {
    if (
      !input.stableDedupeIdentity ||
      !(error instanceof CrossTeamRuntimeDeliveryIdempotencyConflictError)
    ) {
      throw error;
    }

    if (
      !input.timestampWasProvided &&
      this.isEquivalentRetryIgnoringGeneratedTimestamp(error.existingMessage, input.outboxMessage)
    ) {
      return error.existingMessage;
    }

    this.requireDurableReceiptForConflict(error);
    if (input.callerMessageId === error.existingMessage.messageId) {
      error.code = 'idempotency_conflict';
      error.name = 'CrossTeamRuntimeDeliveryIdempotencyConflictError';
    }
    throw error;
  }

  private requireDurableReceiptForConflict(
    conflict: CrossTeamRuntimeDeliveryIdempotencyConflictError
  ): void {
    if (conflict.runtimeDeliveryReceiptStatus === 'valid') {
      return;
    }

    throw new Error(
      `Cross-team runtime delivery receipt proof is missing or corrupt for idempotency conflict: ` +
        `${conflict.existingMessage.messageId} (${conflict.runtimeDeliveryReceiptStatus})`
    );
  }

  private isEquivalentRetryIgnoringGeneratedTimestamp(
    existing: CrossTeamOutboxMessage,
    retry: CrossTeamMessage
  ): boolean {
    return (
      existing.messageId.trim() === retry.messageId.trim() &&
      existing.fromTeam.trim() === retry.fromTeam.trim() &&
      existing.fromMember.trim() === retry.fromMember.trim() &&
      existing.toTeam.trim() === retry.toTeam.trim() &&
      existing.toMember?.trim() === retry.toMember?.trim() &&
      existing.conversationId?.trim() === retry.conversationId?.trim() &&
      existing.replyToConversationId?.trim() === retry.replyToConversationId?.trim() &&
      existing.text === retry.text &&
      (existing.summary ?? '') === (retry.summary ?? '') &&
      JSON.stringify(existing.taskRefs ?? []) === JSON.stringify(retry.taskRefs ?? []) &&
      existing.chainDepth === retry.chainDepth
    );
  }

  private async settleRequiredRuntimeDelivery(
    fromTeam: string,
    message: CrossTeamOutboxMessage,
    targetMemberName: string
  ): Promise<void> {
    if (message.runtimeDeliveryAcceptedAt) {
      return;
    }

    const settlementKey = [fromTeam, message.toTeam, targetMemberName, message.messageId].join(
      '\0'
    );
    const activeSettlement = this.receiptSettlements.get(settlementKey);
    if (activeSettlement) {
      await activeSettlement;
      return;
    }

    const settlement = this.deliverAndMarkReceipt(fromTeam, message, targetMemberName);
    this.receiptSettlements.set(settlementKey, settlement);
    try {
      await settlement;
    } finally {
      if (this.receiptSettlements.get(settlementKey) === settlement) {
        this.receiptSettlements.delete(settlementKey);
      }
    }
  }

  private async deliverAndMarkReceipt(
    fromTeam: string,
    message: CrossTeamOutboxMessage,
    targetMemberName: string
  ): Promise<void> {
    await this.requireRuntimeDelivery({
      teamName: message.toTeam,
      memberName: targetMemberName,
      messageId: message.messageId,
    });
    await this.outbox.markRuntimeDeliveryAccepted(fromTeam, {
      messageId: message.messageId,
      toTeam: message.toTeam,
      toMember: targetMemberName,
      acceptedAt: this.now(),
    });
  }

  private async requireRuntimeDelivery(input: {
    teamName: string;
    memberName: string;
    messageId: string;
  }): Promise<void> {
    if (!this.messaging) {
      throw new Error('Cross-team runtime delivery guard is not configured');
    }

    const relay = await this.messaging.relayInboxFileToLiveRecipient(
      input.teamName,
      input.memberName,
      { onlyMessageId: input.messageId }
    );
    if (this.hasRuntimeDeliveryProof(relay, input.messageId)) {
      return;
    }

    throw new Error(
      `Cross-team runtime delivery was not confirmed for ${input.teamName}.${input.memberName}: ` +
        this.describeProviderResult(relay)
    );
  }

  private hasRuntimeDeliveryProof(
    relay: RuntimeDeliveryRelayResult,
    expectedMessageId: string
  ): boolean {
    if (relay.kind === 'native_lead') {
      return relay.recentlyDeliveredMessageId === expectedMessageId;
    }

    if (relay.kind === 'native_member_noop') {
      return relay.durablyStoredMessageId === expectedMessageId;
    }

    if (relay.kind !== 'opencode_member') {
      return false;
    }

    if (relay.relayed > 0) {
      return true;
    }

    const delivery = relay.lastDelivery;
    return Boolean(
      delivery?.delivered &&
      delivery.accepted === true &&
      !delivery.acceptanceUnknown &&
      !delivery.queuedBehindMessageId
    );
  }

  private describeProviderResult(relay: RuntimeDeliveryRelayResult): string {
    const diagnostics = relay.diagnostics?.filter(Boolean) ?? [];
    const reason = relay.lastDelivery?.reason;
    return reason || diagnostics[0] || `relay kind ${relay.kind} relayed ${relay.relayed}`;
  }
}
