import { isLeadMember } from '@shared/utils/leadDetection';
import { ClaudeBinaryResolver } from '../../ClaudeBinaryResolver';
import { ClaudeMultimodelBridgeService } from '../../../runtime/ClaudeMultimodelBridgeService';

import { OpenCodeVisibleReplyProofService } from './OpenCodeVisibleReplyProofService';

import type { OpenCodeRuntimeTranscriptLogMessage } from '../../../runtime/ClaudeMultimodelBridgeService';
import type { OpenCodeGroupReplySender } from './OpenCodeGroupVisibleReply';
import type { OpenCodeVisibleReplyProofServiceDependencies } from './OpenCodeVisibleReplyProofService';
import type { TeamCreateRequest } from '@shared/types/team';

export interface OpenCodeVisibleReplyProofServiceHost {
  sendGroupChatReply?: OpenCodeGroupReplySender;
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
    Partial<
      Pick<
        OpenCodeVisibleReplyProofServiceDependencies,
        'nowIso' | 'sendGroupChatReply' | 'hasAcknowledgedInbound'
      >
    > {}

function isOpenCodeMessageSendTool(name: string): boolean {
  return /(?:^|[_-])(message_send|group_chat_send)$/.test(name.toLowerCase());
}

/**
 * Ledger tool history may include older turns. For the exact accepted
 * prompt, require every message_send to have a correlated error result.
 * No send in that prompt is also safe; an unproven send is never safe.
 */
function hasNoPotentiallySuccessfulOpenCodeSends(
  messages: readonly OpenCodeRuntimeTranscriptLogMessage[],
  sessionId: string,
  promptMessageId: string,
  assistantMessageId: string
): boolean {
  const promptPositions = messages.flatMap((message, i) =>
    message.uuid === promptMessageId && message.sessionId === sessionId &&
    message.type === 'user' && !message.isMeta ? [i] : []
  );
  const answerPositions = messages.flatMap((message, i) =>
    message.uuid === assistantMessageId && message.sessionId === sessionId &&
    message.type === 'assistant' && !message.isMeta ? [i] : []
  );
  if (promptPositions.length !== 1 || answerPositions.length !== 1 ||
    promptPositions[0] >= answerPositions[0]) return false;
  // An intervening real user prompt closes the turn. Include sends made
  // AFTER the selected assistant text as well: they may still have succeeded.
  const nextPrompt = messages.findIndex((message, i) =>
    i > promptPositions[0] && message.sessionId === sessionId &&
    message.type === 'user' && !message.isMeta
  );
  const turnEnd = nextPrompt < 0 ? messages.length : nextPrompt;
  if (answerPositions[0] >= turnEnd) return false;

  const sends = messages.slice(promptPositions[0] + 1, turnEnd)
    .filter(message => message.type === 'assistant' && !message.isMeta &&
      message.sessionId === sessionId)
    .flatMap(message => message.toolCalls
      .filter(call => isOpenCodeMessageSendTool(call.name))
      .map(call => ({ assistantId: message.uuid, callId: call.id.trim() })));
  // A stale ledger tool name must not block a newer text-only assistant turn.
  if (sends.length === 0) return true;
  return sends.every(send => {
    if (!send.callId) return false;
    const results = messages.flatMap(message =>
      message.sessionId === sessionId &&
      message.sourceToolAssistantUUID === send.assistantId
        ? message.toolResults.filter(result => result.toolUseId === send.callId)
        : []
    );
    return results.length === 1 && results[0].isError === true;
  });
}

/** Exact read-only proof; never substitute the latest assistant or a clipped preview. */
export function readOpenCodeExactAssistantText(
  transcript: Awaited<ReturnType<ClaudeMultimodelBridgeService['getOpenCodeTranscript']>>,
  sessionId: string,
  assistantMessageId: string,
  options?: { requireFailedMessageSendProof?: boolean; runtimePromptMessageId?: string }
): string | null {
  if (transcript?.sessionId !== sessionId) return null;
  const matches = (transcript.logProjection?.messages ?? []).filter(
    (message) => message.uuid === assistantMessageId &&
      message.type === 'assistant' && !message.isMeta &&
      message.sessionId === sessionId
  );
  if (matches.length !== 1) return null;
  const assistant = matches[0];
  const messages = transcript.logProjection?.messages ?? [];
  const hasSendInAnswer = assistant.toolCalls.some(call => isOpenCodeMessageSendTool(call.name));
  if (options?.requireFailedMessageSendProof) {
    const promptId = options.runtimePromptMessageId?.trim();
    if (!promptId || !hasNoPotentiallySuccessfulOpenCodeSends(
      messages, sessionId, promptId, assistantMessageId
    )) return null;
  } else if (hasSendInAnswer) {
    // A send without independently confirmed failure may have written the inbox.
    return null;
  }
  const content = assistant.content;
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
  return text.trim() ? text : null;
}

export function createOpenCodeVisibleReplyProofServiceFromHost(
  service: OpenCodeVisibleReplyProofServiceHost,
  options: OpenCodeVisibleReplyProofServiceHostOptions
): OpenCodeVisibleReplyProofService {
  const runtimeBridge = new ClaudeMultimodelBridgeService();
  return new OpenCodeVisibleReplyProofService({
    inboxReader: service.inboxReader,
    readExactAssistantText: async (input) => {
      const binaryPath = await ClaudeBinaryResolver.resolve();
      if (!binaryPath) return null;
      const transcript = await runtimeBridge.getOpenCodeTranscript(binaryPath, {
        teamId: input.teamName,
        memberName: input.memberName,
        laneId: input.laneId,
        runId: input.runId,
        sessionId: input.sessionId,
        limit: 500,
      });
      return readOpenCodeExactAssistantText(transcript, input.sessionId, input.assistantMessageId, {
        requireFailedMessageSendProof: input.requireFailedMessageSendProof,
        runtimePromptMessageId: input.runtimePromptMessageId,
      });
    },
    sendGroupChatReply: options.sendGroupChatReply ?? service.sendGroupChatReply,
    hasAcknowledgedInbound: options.hasAcknowledgedInbound,
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
