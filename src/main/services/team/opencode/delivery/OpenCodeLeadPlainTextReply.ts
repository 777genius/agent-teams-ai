import {
  classifyOpenCodeDeliveryReplyContract,
  isOpenCodeLeadDestinationProof,
} from './OpenCodeDeliveryReplyContract';
import {
  buildPlainTextVisibleReplyMessageId,
  buildPlainTextVisibleReplySummary,
} from './OpenCodeGroupVisibleReply';
import {
  assertOpenCodePromptDeliveryNotCancelled,
  OpenCodePromptDeliveryCancelledError,
} from './OpenCodePromptDeliveryCancellationGuard';
import {
  canMaterializeOpenCodePlainTextReply,
  hasOpenCodeObservedMessageSendToolCall,
} from './OpenCodePromptDeliveryReadCommitPolicy';
import { isOpenCodeVisibleReplySemanticallySufficient } from './OpenCodePromptDeliveryWatchdog';
import { openCodeTaskRefsIncludeAll } from './OpenCodeRuntimeDeliveryProofMatching';

import type { OpenCodePromptDeliveryLedgerRecord, OpenCodePromptDeliveryLedgerStore } from './OpenCodePromptDeliveryLedger';
import type { OpenCodeVisibleReplyProof } from './OpenCodePromptDeliveryWatchdog';
import type { OpenCodeVisibleReplyProofServiceDependencies } from './OpenCodeVisibleReplyProofService';

type OpenCodeLeadPlainTextReplyPorts = Pick<
  OpenCodeVisibleReplyProofServiceDependencies,
  'getConfiguredLeadName' | 'isConfiguredPeerRecipient' | 'readExactAssistantText' | 'inboxWriter' |
  'emitRuntimeDeliveryReplyAdvisoryRefresh' | 'warn' | 'getErrorMessage'
> & {
  nowIso: () => string;
  findByRelayOfMessageId: (input: {
    teamName: string;
    replyRecipient: string;
    from: string;
    relayOfMessageId: string;
    expectedMessageId: string;
  }) => Promise<OpenCodeVisibleReplyProof | null>;
  ensureVisibleReplyTaskRefs: (input: {
    checkpoint: () => Promise<void>;
    teamName: string;
    memberName: string;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof;
  }) => Promise<{ visibleReply: OpenCodeVisibleReplyProof; diagnostics: string[] }>;
};

/** Do not treat a legacy user fallback as proof that the requested lead received this turn. */
export async function isMisaddressedLeadPlainTextProof(
  record: OpenCodePromptDeliveryLedgerRecord,
  teamName: string,
  proof: OpenCodeVisibleReplyProof,
  getConfiguredLeadName: (team: string) => Promise<string | null>,
  isConfiguredPeerRecipient?: (team: string, recipient: string) => Promise<boolean>
): Promise<boolean> {
  if (record.groupChatId || record.responseState !== 'responded_plain_text' ||
    record.replyRecipient.trim().toLowerCase() === 'user') return false;
  const recipient = record.replyRecipient.trim();
  if (await isConfiguredPeerRecipient?.(teamName, recipient)) return false;
  const lead = await getConfiguredLeadName(teamName);
  const isLead = classifyOpenCodeDeliveryReplyContract(recipient) === 'lead_reply' ||
    Boolean(lead && recipient.toLowerCase() === lead.trim().toLowerCase());
  if (!isLead) return false;
  const expected = lead?.trim().toLowerCase();
  return !expected || proof.inboxName.trim().toLowerCase() !== expected ||
    proof.message.to?.trim().toLowerCase() !== expected ||
    proof.message.from.trim().toLowerCase() !== record.memberName.trim().toLowerCase() ||
    proof.message.relayOfMessageId !== record.inboxMessageId ||
    proof.message.source !== 'runtime_delivery';
}

/** A single exact assistant turn can qualify an idempotent reply in the lead's inbox. */
export async function materializeOpenCodeLeadPlainTextReply(input: {
    checkpoint?: () => void | Promise<void>;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ports: OpenCodeLeadPlainTextReplyPorts;
  }): Promise<{ ledgerRecord: OpenCodePromptDeliveryLedgerRecord; visibleReply: OpenCodeVisibleReplyProof | null }> {
    const record = input.ledgerRecord;
    const recipient = record.replyRecipient.trim();
    if (await input.ports.isConfiguredPeerRecipient?.(input.teamName, recipient)) {
      return { ledgerRecord: record, visibleReply: input.visibleReply ?? null };
    }
    const configuredLead = await input.ports.getConfiguredLeadName(input.teamName);
    const isLead = classifyOpenCodeDeliveryReplyContract(recipient) === 'lead_reply' ||
      Boolean(configuredLead?.trim() &&
        recipient.toLowerCase() === configuredLead.trim().toLowerCase());
    // This service also receives optional teammate reports: preserve their
    // original destination proof, but never leak a wrong-inbox lead receipt.
    if (!isLead) return { ledgerRecord: record, visibleReply: input.visibleReply ?? null };
    const destination = configuredLead?.trim();
    if (!destination) return { ledgerRecord: record, visibleReply: null };
    const verifiedLeadProof = input.visibleReply ?? null;
    if (isOpenCodeLeadDestinationProof(record, destination, verifiedLeadProof)) {
      return { ledgerRecord: record, visibleReply: verifiedLeadProof };
    }
    // A legacy/task-ref receipt may have been committed to the user inbox and
    // relabelled the ledger "responded_visible_message". Recover only when the
    // observed assistant/session/run identity is still bound to that request.
    const misplacedReceipt =
      record.responseState === 'responded_visible_message' &&
      record.visibleReplyInbox?.trim().toLowerCase() !== destination.toLowerCase() &&
      Boolean(record.visibleReplyInbox?.trim() && record.visibleReplyMessageId?.trim() &&
        record.runtimeSessionId?.trim() && record.observedAssistantMessageId?.trim() &&
        record.runId?.trim() && record.laneId?.trim());
    if (!canMaterializeOpenCodePlainTextReply(record) && !misplacedReceipt) {
      return { ledgerRecord: record, visibleReply: null };
    }
    const messageId = buildPlainTextVisibleReplyMessageId(record);
    const validProof = (proof: OpenCodeVisibleReplyProof | null): proof is OpenCodeVisibleReplyProof =>
      Boolean(proof &&
        proof.inboxName.toLowerCase() === destination.toLowerCase() &&
        proof.message.to?.trim().toLowerCase() === destination.toLowerCase() &&
        proof.message.from.trim().toLowerCase() === input.memberName.trim().toLowerCase() &&
        proof.message.relayOfMessageId === record.inboxMessageId &&
        proof.message.source === 'runtime_delivery' &&
        proof.message.messageId === messageId &&
        !/^already handled\s*:/i.test(proof.message.text.trim()) &&
        isOpenCodeVisibleReplySemanticallySufficient({
          actionMode: record.actionMode, taskRefs: record.taskRefs,
          text: proof.message.text, summary: proof.message.summary,
        }).sufficient);

    // Do not invent a new reply while a lead-bound tool receipt is unresolved.
    if (record.visibleReplyMessageId &&
      record.visibleReplyInbox?.trim().toLowerCase() === destination.toLowerCase()) {
      return { ledgerRecord: record, visibleReply: null };
    }

    try {
      const existing = await input.ports.findByRelayOfMessageId({
        teamName: input.teamName,
        replyRecipient: destination,
        from: input.memberName,
        relayOfMessageId: record.inboxMessageId,
        expectedMessageId: messageId,
      });
      if (validProof(existing)) {
        const enriched = await input.ports.ensureVisibleReplyTaskRefs({
          checkpoint: () => assertOpenCodePromptDeliveryNotCancelled(input.ledger, record, input.checkpoint),
          teamName: input.teamName, memberName: input.memberName, ledgerRecord: record, visibleReply: existing,
        });
        await assertOpenCodePromptDeliveryNotCancelled(input.ledger, record, input.checkpoint);
        const ledgerRecord = await input.ledger.applyDestinationProof({
          id: record.id,
          visibleReplyInbox: destination,
          visibleReplyMessageId: messageId,
          visibleReplyCorrelation: 'plain_assistant_text',
          semanticallySufficient: openCodeTaskRefsIncludeAll(enriched.visibleReply.message.taskRefs, record.taskRefs),
          diagnostics: enriched.diagnostics,
          observedAt: input.ports.nowIso(),
        });
        await assertOpenCodePromptDeliveryNotCancelled(input.ledger, ledgerRecord, input.checkpoint);
        input.ports.emitRuntimeDeliveryReplyAdvisoryRefresh(input.teamName, enriched.visibleReply.message);
        return { ledgerRecord, visibleReply: enriched.visibleReply };
      }

      const sessionId = record.runtimeSessionId?.trim();
      const assistantMessageId = record.observedAssistantMessageId?.trim();
      const runId = record.runId?.trim();
      if (!sessionId || !assistantMessageId || !runId || !record.laneId?.trim()) {
        return { ledgerRecord: record, visibleReply: null };
      }
      const text = await input.ports.readExactAssistantText?.({
        teamName: input.teamName, memberName: input.memberName, laneId: record.laneId,
        runId, sessionId, assistantMessageId,
        expectedReplyRecipient: destination,
        expectedRelayOfMessageId: record.inboxMessageId,
        ...(hasOpenCodeObservedMessageSendToolCall(record)
          ? {
              requireFailedMessageSendProof: true,
              runtimePromptMessageId: record.lastRuntimePromptMessageId ??
                record.runtimePromptMessageId ?? undefined,
            }
          : {}),
      });
      if (!text?.trim() || /^already handled\s*:/i.test(text.trim()) ||
        !isOpenCodeVisibleReplySemanticallySufficient({
          actionMode: record.actionMode, taskRefs: record.taskRefs, text,
        }).sufficient) {
        return { ledgerRecord: record, visibleReply: null };
      }
      const timestamp = record.respondedAt ?? record.lastObservedAt ?? record.updatedAt ?? input.ports.nowIso();
      await assertOpenCodePromptDeliveryNotCancelled(input.ledger, record, input.checkpoint);
      const written = await input.ports.inboxWriter.sendMessage(input.teamName, {
        member: destination, from: input.memberName, to: destination, text,
        summary: buildPlainTextVisibleReplySummary(text), timestamp, messageId,
        relayOfMessageId: record.inboxMessageId, source: 'runtime_delivery', taskRefs: record.taskRefs,
      }, {
        shouldStillWrite: async () => {
          try {
            await assertOpenCodePromptDeliveryNotCancelled(input.ledger, record, input.checkpoint);
            return true;
          } catch (error) {
            if (error instanceof OpenCodePromptDeliveryCancelledError) return false;
            throw error;
          }
        },
      });
      if (!written.deliveredToInbox || written.messageId !== messageId) {
        throw new Error('OpenCode lead plain-text reply was not persisted');
      }
      // The writer deduplicates some normalized runtime payloads. Only the
      // actual committed inbox row (not a synthetic echo of the request) can
      // prove the exact assistant response survived without alteration.
      const persistedReply = await input.ports.findByRelayOfMessageId({
        teamName: input.teamName,
        replyRecipient: destination,
        from: input.memberName,
        relayOfMessageId: record.inboxMessageId,
        expectedMessageId: messageId,
      });
      if (!validProof(persistedReply) || persistedReply.message.text !== text) {
        throw new Error('OpenCode lead reply differs from the persisted inbox row');
      }
      const visibleReply = persistedReply;
      await assertOpenCodePromptDeliveryNotCancelled(input.ledger, record, input.checkpoint);
      const ledgerRecord = await input.ledger.applyDestinationProof({
        id: record.id, visibleReplyInbox: destination, visibleReplyMessageId: messageId,
        visibleReplyCorrelation: 'plain_assistant_text',
        semanticallySufficient: openCodeTaskRefsIncludeAll(visibleReply.message.taskRefs, record.taskRefs),
        diagnostics: [
          written.deduplicated
            ? 'opencode_lead_plain_text_reply_materialized_deduplicated'
            : 'opencode_lead_plain_text_reply_materialized',
        ],
        observedAt: input.ports.nowIso(),
      });
      await assertOpenCodePromptDeliveryNotCancelled(input.ledger, ledgerRecord, input.checkpoint);
      input.ports.emitRuntimeDeliveryReplyAdvisoryRefresh(input.teamName, visibleReply.message);
      return { ledgerRecord, visibleReply };
    } catch (error) {
      if (error instanceof OpenCodePromptDeliveryCancelledError) throw error;
      input.ports.warn(
        `[${input.teamName}] Failed to deliver OpenCode plain-text lead reply for ${input.memberName}/${record.inboxMessageId}: ${input.ports.getErrorMessage(error)}`
      );
      return { ledgerRecord: record, visibleReply: null };
    }
  }
