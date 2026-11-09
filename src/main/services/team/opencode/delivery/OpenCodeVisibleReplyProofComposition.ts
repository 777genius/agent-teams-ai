import { isLeadMember } from '@shared/utils/leadDetection';
import { ClaudeBinaryResolver } from '../../ClaudeBinaryResolver';
import { ClaudeMultimodelBridgeService } from '../../../runtime/ClaudeMultimodelBridgeService';

import { OpenCodeVisibleReplyProofService } from './OpenCodeVisibleReplyProofService';

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

/** Exact read-only proof; never substitute the latest assistant or a clipped preview. */
export function readOpenCodeExactAssistantText(
  transcript: Awaited<ReturnType<ClaudeMultimodelBridgeService['getOpenCodeTranscript']>>,
  sessionId: string,
  assistantMessageId: string
): string | null {
  if (transcript?.sessionId !== sessionId) return null;
  const matches = (transcript.logProjection?.messages ?? []).filter(
    (message) => message.uuid === assistantMessageId &&
      message.type === 'assistant' && !message.isMeta &&
      message.sessionId === sessionId
  );
  if (matches.length !== 1) return null;
  const assistant = matches[0];
  // An actual message_send tool call may still write the recipient inbox.
  if (assistant.toolCalls.some((call) =>
    /(?:^|[_-])(message_send|group_chat_send)$/.test(call.name.toLowerCase())
  )) return null;
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
      return readOpenCodeExactAssistantText(transcript, input.sessionId, input.assistantMessageId);
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
