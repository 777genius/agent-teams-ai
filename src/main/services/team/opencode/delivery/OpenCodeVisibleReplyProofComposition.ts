import { isLeadMember } from '@shared/utils/leadDetection';

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

export function createOpenCodeVisibleReplyProofServiceFromHost(
  service: OpenCodeVisibleReplyProofServiceHost,
  options: OpenCodeVisibleReplyProofServiceHostOptions
): OpenCodeVisibleReplyProofService {
  return new OpenCodeVisibleReplyProofService({
    inboxReader: service.inboxReader,
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
