import {
  canMaterializeOpenCodePlainTextReply,
  hasOpenCodeObservedMessageSendToolCall,
  isOpenCodeDirectUserPromptDelivery,
} from './OpenCodePromptDeliveryReadCommitPolicy';
import {
  isOpenCodeVisibleReplyReadCommitAllowed,
  isOpenCodeVisibleReplySemanticallySufficient,
  type OpenCodeVisibleReplyProof,
} from './OpenCodePromptDeliveryWatchdog';
import {
  getOpenCodeVisibleReplyInboxCandidates,
  isOpenCodeRecoveredVisibleReplyCandidate,
  normalizeOpenCodeTaskRefsForComparison,
  openCodeTaskRefsIncludeAll,
} from './OpenCodeRuntimeDeliveryProofMatching';

import type { TeamInboxReader } from '../../TeamInboxReader';
import type { TeamInboxWriter } from '../../TeamInboxWriter';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { InboxMessage, TeamCreateRequest } from '@shared/types/team';

type OpenCodeVisibleReplyCorrelation = NonNullable<
  OpenCodePromptDeliveryLedgerRecord['visibleReplyCorrelation']
>;

interface OpenCodeRecoveredVisibleReplyProof {
  visibleReply: OpenCodeVisibleReplyProof;
  visibleReplyCorrelation: OpenCodeVisibleReplyCorrelation;
  diagnostics: string[];
}

export interface OpenCodeVisibleReplyProofServiceDependencies {
  inboxReader: Pick<TeamInboxReader, 'getMessagesFor'>;
  inboxWriter: Pick<
    TeamInboxWriter,
    'correlateRuntimeDeliveryReply' | 'mergeRuntimeDeliveryTaskRefs' | 'sendMessage'
  >;
  getConfiguredLeadName: (teamName: string) => Promise<string | null>;
  emitRuntimeDeliveryReplyAdvisoryRefresh: (teamName: string, message: InboxMessage) => void;
  warn: (message: string) => void;
  getErrorMessage: (error: unknown) => string;
  nowIso?: () => string;
}

export interface OpenCodeVisibleReplyProofServiceHost {
  inboxReader: OpenCodeVisibleReplyProofServiceDependencies['inboxReader'];
  inboxWriter: OpenCodeVisibleReplyProofServiceDependencies['inboxWriter'];
  configFacade: {
    readConfigForObservation(teamName: string): Promise<{
      members?: TeamCreateRequest['members'];
    } | null>;
  };
  emitRuntimeDeliveryReplyAdvisoryRefresh: OpenCodeVisibleReplyProofServiceDependencies['emitRuntimeDeliveryReplyAdvisoryRefresh'];
}

export interface OpenCodeVisibleReplyProofServiceHostOptions
  extends
    Pick<OpenCodeVisibleReplyProofServiceDependencies, 'warn' | 'getErrorMessage'>,
    Partial<Pick<OpenCodeVisibleReplyProofServiceDependencies, 'nowIso'>> {}

export function createOpenCodeVisibleReplyProofServiceFromHost(
  service: OpenCodeVisibleReplyProofServiceHost,
  options: OpenCodeVisibleReplyProofServiceHostOptions
): OpenCodeVisibleReplyProofService {
  return new OpenCodeVisibleReplyProofService({
    inboxReader: service.inboxReader,
    inboxWriter: service.inboxWriter,
    getConfiguredLeadName: async (teamName) =>
      service.configFacade
        .readConfigForObservation(teamName)
        .then(
          (config) => config?.members?.find((member) => isLeadMember(member))?.name?.trim() || null
        )
        .catch(() => null),
    emitRuntimeDeliveryReplyAdvisoryRefresh: (teamName, message) =>
      service.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message),
    warn: options.warn,
    getErrorMessage: options.getErrorMessage,
    nowIso: options.nowIso,
  });
}

export class OpenCodeVisibleReplyProofService {
  private readonly nowIso: () => string;

  constructor(private readonly deps: OpenCodeVisibleReplyProofServiceDependencies) {
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  async findByRelayOfMessageId(input: {
    teamName: string;
    replyRecipient?: string | null;
    from: string;
    relayOfMessageId: string;
    expectedMessageId?: string | null;
    allowUserFallbackForLeadRecipient?: boolean;
  }): Promise<OpenCodeVisibleReplyProof | null> {
    const relayOfMessageId = input.relayOfMessageId.trim();
    if (!relayOfMessageId) {
      return null;
    }
    const expectedMessageId = input.expectedMessageId?.trim() || null;
    const candidates = await this.getInboxCandidates({
      teamName: input.teamName,
      replyRecipient: input.replyRecipient,
      includeUserFallbackForLeadRecipient: Boolean(
        expectedMessageId || input.allowUserFallbackForLeadRecipient
      ),
    });
    const explicitRecipient = input.replyRecipient?.trim() || 'user';
    const expectedFrom = input.from.trim().toLowerCase();
    for (const inboxName of candidates) {
      const messages = await this.deps.inboxReader
        .getMessagesFor(input.teamName, inboxName)
        .catch(() => []);
      const isUserFallbackForNonUserRecipient =
        inboxName.trim().toLowerCase() === 'user' &&
        explicitRecipient.trim().toLowerCase() !== 'user';
      const matches = messages.filter(
        (message): message is InboxMessage & { messageId: string } => {
          const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
          const messageRelayOf =
            typeof message.relayOfMessageId === 'string' ? message.relayOfMessageId.trim() : '';
          return (
            messageId.length > 0 &&
            (!expectedMessageId || messageId === expectedMessageId) &&
            messageRelayOf === relayOfMessageId &&
            message.from.trim().toLowerCase() === expectedFrom
          );
        }
      );
      const runtimeDeliveryMatches = matches.filter(
        (message) => message.source === 'runtime_delivery'
      );
      const match =
        isUserFallbackForNonUserRecipient && !expectedMessageId
          ? runtimeDeliveryMatches.length === 1
            ? runtimeDeliveryMatches[0]
            : matches.length === 1
              ? matches[0]
              : null
          : (runtimeDeliveryMatches[0] ?? matches[0] ?? null);
      if (match) {
        const matchMessageId = typeof match.messageId === 'string' ? match.messageId.trim() : '';
        if (!matchMessageId) {
          continue;
        }
        return {
          inboxName,
          message: { ...match, messageId: matchMessageId },
          missingRuntimeDeliverySource: match.source !== 'runtime_delivery',
        };
      }
    }
    return null;
  }

  private async correlateRecoveredVisibleReply(input: {
    teamName: string;
    inboxName: string;
    memberName: string;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof;
    diagnostic: string;
  }): Promise<OpenCodeRecoveredVisibleReplyProof> {
    const expectedRelayOfMessageId = input.ledgerRecord.inboxMessageId.trim();
    const currentRelayOfMessageId =
      typeof input.visibleReply.message.relayOfMessageId === 'string'
        ? input.visibleReply.message.relayOfMessageId.trim()
        : '';
    if (currentRelayOfMessageId === expectedRelayOfMessageId) {
      return {
        visibleReply: input.visibleReply,
        visibleReplyCorrelation: 'relayOfMessageId',
        diagnostics: [input.diagnostic],
      };
    }

    try {
      const correlated = await this.deps.inboxWriter.correlateRuntimeDeliveryReply(input.teamName, {
        inboxName: input.inboxName,
        messageId: input.visibleReply.message.messageId,
        relayOfMessageId: expectedRelayOfMessageId,
        from: input.memberName,
        taskRefs: input.ledgerRecord.taskRefs,
      });
      if (correlated.message) {
        const visibleReply = {
          ...input.visibleReply,
          message: correlated.message,
        };
        if (correlated.updated) {
          this.deps.emitRuntimeDeliveryReplyAdvisoryRefresh(input.teamName, visibleReply.message);
        }
        return {
          visibleReply,
          visibleReplyCorrelation: 'relayOfMessageId',
          diagnostics: [
            input.diagnostic,
            correlated.updated
              ? 'opencode_visible_reply_relayOfMessageId_repaired'
              : 'opencode_visible_reply_relayOfMessageId_already_correlated',
          ],
        };
      }
      return {
        visibleReply: input.visibleReply,
        visibleReplyCorrelation: 'direct_child_message_send',
        diagnostics: [input.diagnostic, 'opencode_visible_reply_relayOfMessageId_repair_not_found'],
      };
    } catch (error) {
      this.deps.warn(
        `[${input.teamName}] Failed to repair OpenCode visible reply relayOfMessageId for ${input.memberName}/${expectedRelayOfMessageId}: ${this.deps.getErrorMessage(error)}`
      );
      return {
        visibleReply: input.visibleReply,
        visibleReplyCorrelation: 'direct_child_message_send',
        diagnostics: [input.diagnostic, 'opencode_visible_reply_relayOfMessageId_repair_failed'],
      };
    }
  }

  private async findByObservedMessageId(input: {
    teamName: string;
    replyRecipient?: string | null;
    from: string;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodeRecoveredVisibleReplyProof | null> {
    const expectedMessageId = input.ledgerRecord.visibleReplyMessageId?.trim();
    if (!expectedMessageId) {
      return null;
    }
    const candidates = await this.getInboxCandidates({
      teamName: input.teamName,
      replyRecipient: input.replyRecipient,
      includeUserFallbackForLeadRecipient: true,
    });
    for (const inboxName of candidates) {
      const messages = await this.deps.inboxReader
        .getMessagesFor(input.teamName, inboxName)
        .catch(() => []);
      const match = messages.find((message): message is InboxMessage & { messageId: string } => {
        const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
        return (
          messageId === expectedMessageId &&
          isOpenCodeRecoveredVisibleReplyCandidate({
            message: { ...message, messageId },
            ledgerRecord: input.ledgerRecord,
            from: input.from,
            requireTaskRefs: false,
          })
        );
      });
      if (!match) {
        continue;
      }
      return await this.correlateRecoveredVisibleReply({
        teamName: input.teamName,
        inboxName,
        memberName: input.from,
        ledgerRecord: input.ledgerRecord,
        visibleReply: {
          inboxName,
          message: { ...match, messageId: expectedMessageId },
          missingRuntimeDeliverySource: match.source !== 'runtime_delivery',
        },
        diagnostic: 'opencode_visible_reply_recovered_by_observed_message_id',
      });
    }
    return null;
  }

  private async findByTaskRefs(input: {
    teamName: string;
    replyRecipient?: string | null;
    from: string;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodeRecoveredVisibleReplyProof | null> {
    if (normalizeOpenCodeTaskRefsForComparison(input.ledgerRecord.taskRefs).length === 0) {
      return null;
    }
    const candidates = await this.getInboxCandidates({
      teamName: input.teamName,
      replyRecipient: input.replyRecipient,
      includeUserFallbackForLeadRecipient: true,
    });
    const matches: OpenCodeVisibleReplyProof[] = [];
    for (const inboxName of candidates) {
      const messages = await this.deps.inboxReader
        .getMessagesFor(input.teamName, inboxName)
        .catch(() => []);
      for (const message of messages) {
        const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
        if (!messageId) {
          continue;
        }
        const candidate = { ...message, messageId };
        if (
          isOpenCodeRecoveredVisibleReplyCandidate({
            message: candidate,
            ledgerRecord: input.ledgerRecord,
            from: input.from,
            requireTaskRefs: true,
          })
        ) {
          matches.push({
            inboxName,
            message: candidate,
            missingRuntimeDeliverySource: candidate.source !== 'runtime_delivery',
          });
        }
      }
    }
    const match = matches.sort((left, right) => {
      const leftMs = Date.parse(left.message.timestamp);
      const rightMs = Date.parse(right.message.timestamp);
      const leftValid = Number.isFinite(leftMs);
      const rightValid = Number.isFinite(rightMs);
      if (leftValid && rightValid && leftMs !== rightMs) {
        return leftMs - rightMs;
      }
      if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      return left.message.messageId.localeCompare(right.message.messageId);
    })[0];
    if (!match) {
      return null;
    }
    return await this.correlateRecoveredVisibleReply({
      teamName: input.teamName,
      inboxName: match.inboxName,
      memberName: input.from,
      ledgerRecord: input.ledgerRecord,
      visibleReply: match,
      diagnostic: 'opencode_visible_reply_recovered_by_task_refs',
    });
  }

  private async getInboxCandidates(input: {
    teamName: string;
    replyRecipient?: string | null;
    includeUserFallbackForLeadRecipient?: boolean;
  }): Promise<string[]> {
    const configuredLeadName = await this.deps.getConfiguredLeadName(input.teamName);
    return getOpenCodeVisibleReplyInboxCandidates({
      replyRecipient: input.replyRecipient,
      configuredLeadName,
      includeUserFallbackForLeadRecipient: input.includeUserFallbackForLeadRecipient,
    });
  }

  private async ensureVisibleReplyTaskRefs(input: {
    teamName: string;
    memberName: string;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof;
  }): Promise<{ visibleReply: OpenCodeVisibleReplyProof; diagnostics: string[] }> {
    const taskRefs = normalizeOpenCodeTaskRefsForComparison(input.ledgerRecord.taskRefs);
    if (taskRefs.length === 0) {
      return { visibleReply: input.visibleReply, diagnostics: [] };
    }
    if (openCodeTaskRefsIncludeAll(input.visibleReply.message.taskRefs, taskRefs)) {
      return { visibleReply: input.visibleReply, diagnostics: [] };
    }

    const messageId = input.visibleReply.message.messageId.trim();
    const relayOfMessageId =
      typeof input.visibleReply.message.relayOfMessageId === 'string'
        ? input.visibleReply.message.relayOfMessageId.trim()
        : '';
    if (!messageId || relayOfMessageId !== input.ledgerRecord.inboxMessageId.trim()) {
      return {
        visibleReply: input.visibleReply,
        diagnostics: ['visible_reply_missing_task_refs'],
      };
    }

    try {
      const merged = await this.deps.inboxWriter.mergeRuntimeDeliveryTaskRefs(input.teamName, {
        inboxName: input.visibleReply.inboxName,
        messageId,
        relayOfMessageId,
        from: input.memberName,
        taskRefs,
      });
      if (merged.message && openCodeTaskRefsIncludeAll(merged.message.taskRefs, taskRefs)) {
        const visibleReply = {
          ...input.visibleReply,
          message: merged.message,
        };
        if (merged.updated) {
          this.deps.emitRuntimeDeliveryReplyAdvisoryRefresh(input.teamName, visibleReply.message);
        }
        return {
          visibleReply,
          diagnostics: merged.updated
            ? ['opencode_runtime_delivery_task_refs_inherited_from_relay']
            : [],
        };
      }
      return {
        visibleReply: input.visibleReply,
        diagnostics: merged.found
          ? ['visible_reply_missing_task_refs_after_merge']
          : ['visible_reply_missing_task_refs'],
      };
    } catch (error) {
      this.deps.warn(
        `[${input.teamName}] Failed to merge OpenCode runtime delivery taskRefs for ${input.memberName}/${input.ledgerRecord.inboxMessageId}: ${this.deps.getErrorMessage(error)}`
      );
      return {
        visibleReply: input.visibleReply,
        diagnostics: ['visible_reply_task_refs_merge_failed'],
      };
    }
  }

  async applyDestinationProof(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    replyRecipient?: string | null;
    memberName: string;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }> {
    let visibleReply = await this.findByRelayOfMessageId({
      teamName: input.teamName,
      replyRecipient: input.replyRecipient ?? input.ledgerRecord.replyRecipient,
      from: input.memberName,
      relayOfMessageId: input.ledgerRecord.inboxMessageId,
      expectedMessageId:
        input.ledgerRecord.visibleReplyCorrelation === 'relayOfMessageId'
          ? input.ledgerRecord.visibleReplyMessageId
          : null,
      allowUserFallbackForLeadRecipient:
        input.ledgerRecord.visibleReplyCorrelation === 'relayOfMessageId',
    });
    let visibleReplyCorrelation: OpenCodeVisibleReplyCorrelation = 'relayOfMessageId';
    let recoveryDiagnostics: string[] = [];
    if (!visibleReply) {
      const recoveredByMessageId = await this.findByObservedMessageId({
        teamName: input.teamName,
        replyRecipient: input.replyRecipient ?? input.ledgerRecord.replyRecipient,
        from: input.memberName,
        ledgerRecord: input.ledgerRecord,
      });
      if (recoveredByMessageId) {
        visibleReply = recoveredByMessageId.visibleReply;
        visibleReplyCorrelation = recoveredByMessageId.visibleReplyCorrelation;
        recoveryDiagnostics = recoveredByMessageId.diagnostics;
      }
    }
    if (!visibleReply) {
      const recoveredByTaskRefs = await this.findByTaskRefs({
        teamName: input.teamName,
        replyRecipient: input.replyRecipient ?? input.ledgerRecord.replyRecipient,
        from: input.memberName,
        ledgerRecord: input.ledgerRecord,
      });
      if (recoveredByTaskRefs) {
        visibleReply = recoveredByTaskRefs.visibleReply;
        visibleReplyCorrelation = recoveredByTaskRefs.visibleReplyCorrelation;
        recoveryDiagnostics = recoveredByTaskRefs.diagnostics;
      }
    }
    if (!visibleReply) {
      return { ledgerRecord: input.ledgerRecord, visibleReply: null };
    }
    const enriched = await this.ensureVisibleReplyTaskRefs({
      teamName: input.teamName,
      memberName: input.memberName,
      ledgerRecord: input.ledgerRecord,
      visibleReply,
    });
    const visibleReplyForProof = enriched.visibleReply;
    const taskRefsSatisfied = openCodeTaskRefsIncludeAll(
      visibleReplyForProof.message.taskRefs,
      input.ledgerRecord.taskRefs
    );
    const semantic =
      isOpenCodeVisibleReplyReadCommitAllowed({
        actionMode: input.ledgerRecord.actionMode,
        taskRefs: input.ledgerRecord.taskRefs,
        visibleReply: visibleReplyForProof,
      }) && taskRefsSatisfied;
    const previousTerminalSuccess =
      input.ledgerRecord.status === 'responded' &&
      Boolean(input.ledgerRecord.inboxReadCommittedAt || input.ledgerRecord.visibleReplyMessageId);
    const shouldEmitRecoveryAdvisoryRefresh =
      semantic &&
      (!previousTerminalSuccess ||
        input.ledgerRecord.status === 'failed_terminal' ||
        Boolean(input.ledgerRecord.failedAt) ||
        Boolean(input.ledgerRecord.lastReason?.trim()));
    const ledgerRecord = await input.ledger.applyDestinationProof({
      id: input.ledgerRecord.id,
      visibleReplyInbox: visibleReplyForProof.inboxName,
      visibleReplyMessageId: visibleReplyForProof.message.messageId,
      visibleReplyCorrelation,
      semanticallySufficient: semantic,
      diagnostics: [
        ...recoveryDiagnostics,
        ...(visibleReplyForProof.missingRuntimeDeliverySource
          ? ['visible_reply_missing_runtime_delivery_source']
          : []),
        ...enriched.diagnostics,
      ],
      observedAt: this.nowIso(),
    });
    if (shouldEmitRecoveryAdvisoryRefresh) {
      this.deps.emitRuntimeDeliveryReplyAdvisoryRefresh(
        input.teamName,
        visibleReplyForProof.message
      );
    }
    return { ledgerRecord, visibleReply: visibleReplyForProof };
  }

  buildPlainTextVisibleReplyMessageId(record: OpenCodePromptDeliveryLedgerRecord): string {
    const safeId = record.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
    return `opencode-plain-reply-${safeId}`;
  }

  buildPlainTextVisibleReplySummary(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > 120 ? `${normalized.slice(0, 117).trimEnd()}...` : normalized;
  }

  async materializePlainTextReplyIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    visibleReply?: OpenCodeVisibleReplyProof | null;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }> {
    if (input.visibleReply) {
      return { ledgerRecord: input.ledgerRecord, visibleReply: input.visibleReply };
    }
    const materializedFromMessageSendToolError =
      input.ledgerRecord.responseState === 'tool_error' &&
      hasOpenCodeObservedMessageSendToolCall(input.ledgerRecord);
    if (
      !canMaterializeOpenCodePlainTextReply(input.ledgerRecord) ||
      !isOpenCodeDirectUserPromptDelivery(input.ledgerRecord) ||
      input.ledgerRecord.visibleReplyMessageId ||
      input.ledgerRecord.visibleReplyInbox
    ) {
      return { ledgerRecord: input.ledgerRecord, visibleReply: null };
    }

    const text = input.ledgerRecord.observedAssistantPreview?.trim();
    if (!text) {
      return { ledgerRecord: input.ledgerRecord, visibleReply: null };
    }
    const semantic = isOpenCodeVisibleReplySemanticallySufficient({
      actionMode: input.ledgerRecord.actionMode,
      taskRefs: input.ledgerRecord.taskRefs,
      text,
    });
    if (!semantic.sufficient) {
      return { ledgerRecord: input.ledgerRecord, visibleReply: null };
    }

    const messageId = this.buildPlainTextVisibleReplyMessageId(input.ledgerRecord);
    const existing = await this.findByRelayOfMessageId({
      teamName: input.teamName,
      replyRecipient: 'user',
      from: input.memberName,
      relayOfMessageId: input.ledgerRecord.inboxMessageId,
      expectedMessageId: messageId,
    });

    if (existing) {
      const enriched = await this.ensureVisibleReplyTaskRefs({
        teamName: input.teamName,
        memberName: input.memberName,
        ledgerRecord: input.ledgerRecord,
        visibleReply: existing,
      });
      const existingForProof = enriched.visibleReply;
      const ledgerRecord = await input.ledger.applyDestinationProof({
        id: input.ledgerRecord.id,
        visibleReplyInbox: existingForProof.inboxName,
        visibleReplyMessageId: existingForProof.message.messageId,
        visibleReplyCorrelation: 'plain_assistant_text',
        semanticallySufficient: openCodeTaskRefsIncludeAll(
          existingForProof.message.taskRefs,
          input.ledgerRecord.taskRefs
        ),
        diagnostics: [
          ...(materializedFromMessageSendToolError
            ? ['opencode_message_send_tool_error_plain_text_reply_materialized']
            : []),
          ...(existingForProof.missingRuntimeDeliverySource
            ? ['plain_text_visible_reply_missing_runtime_delivery_source']
            : []),
          ...enriched.diagnostics,
        ],
        observedAt: this.nowIso(),
      });
      this.deps.emitRuntimeDeliveryReplyAdvisoryRefresh(input.teamName, existingForProof.message);
      return { ledgerRecord, visibleReply: existingForProof };
    }

    const timestamp =
      input.ledgerRecord.respondedAt ??
      input.ledgerRecord.lastObservedAt ??
      input.ledgerRecord.updatedAt ??
      this.nowIso();
    try {
      const written = await this.deps.inboxWriter.sendMessage(input.teamName, {
        member: 'user',
        from: input.memberName,
        to: 'user',
        text,
        summary: this.buildPlainTextVisibleReplySummary(text),
        timestamp,
        messageId,
        relayOfMessageId: input.ledgerRecord.inboxMessageId,
        source: 'runtime_delivery',
        taskRefs: input.ledgerRecord.taskRefs,
      });
      const visibleReply: OpenCodeVisibleReplyProof = {
        inboxName: 'user',
        message: {
          from: input.memberName,
          to: 'user',
          text,
          timestamp,
          read: false,
          summary: this.buildPlainTextVisibleReplySummary(text),
          messageId: written.messageId,
          relayOfMessageId: input.ledgerRecord.inboxMessageId,
          source: 'runtime_delivery',
          taskRefs: input.ledgerRecord.taskRefs,
        },
      };
      const ledgerRecord = await input.ledger.applyDestinationProof({
        id: input.ledgerRecord.id,
        visibleReplyInbox: 'user',
        visibleReplyMessageId: written.messageId,
        visibleReplyCorrelation: 'plain_assistant_text',
        semanticallySufficient: true,
        diagnostics: [
          ...(materializedFromMessageSendToolError
            ? ['opencode_message_send_tool_error_plain_text_reply_materialized']
            : []),
          written.deduplicated
            ? 'opencode_plain_text_reply_materialized_deduplicated'
            : 'opencode_plain_text_reply_materialized_to_user_inbox',
        ],
        observedAt: this.nowIso(),
      });
      this.deps.emitRuntimeDeliveryReplyAdvisoryRefresh(input.teamName, visibleReply.message);
      return { ledgerRecord, visibleReply };
    } catch (error) {
      this.deps.warn(
        `[${input.teamName}] Failed to materialize OpenCode plain-text reply for ${input.memberName}/${input.ledgerRecord.inboxMessageId}: ${this.deps.getErrorMessage(error)}`
      );
      return { ledgerRecord: input.ledgerRecord, visibleReply: null };
    }
  }
}
