import type { TeamCrossTeamMessagingApi, TeamMessagingApi } from './TeamProvisioningMessagingApis';

export function bindTeamMessagingApi(source: TeamMessagingApi): TeamMessagingApi {
  return {
    sendMessageToTeam: source.sendMessageToTeam.bind(source),
    relayOpenCodeMemberInboxMessages: source.relayOpenCodeMemberInboxMessages.bind(source),
    relayLeadInboxMessages: source.relayLeadInboxMessages.bind(source),
    getOpenCodeRuntimeDeliveryStatus: source.getOpenCodeRuntimeDeliveryStatus.bind(source),
    resolveRuntimeRecipientProviderId: source.resolveRuntimeRecipientProviderId.bind(source),
    getLiveLeadProcessMessages: source.getLiveLeadProcessMessages.bind(source),
    getCurrentLeadSessionId: source.getCurrentLeadSessionId.bind(source),
    pushLiveLeadProcessMessage: source.pushLiveLeadProcessMessage.bind(source),
  };
}

export function bindTeamCrossTeamMessagingApi(
  source: TeamCrossTeamMessagingApi
): TeamCrossTeamMessagingApi {
  return {
    resolveCrossTeamReplyMetadata: source.resolveCrossTeamReplyMetadata.bind(source),
    registerPendingCrossTeamReplyExpectation:
      source.registerPendingCrossTeamReplyExpectation.bind(source),
    clearPendingCrossTeamReplyExpectation:
      source.clearPendingCrossTeamReplyExpectation.bind(source),
    isTeamAlive: source.isTeamAlive.bind(source),
    relayInboxFileToLiveRecipient: source.relayInboxFileToLiveRecipient.bind(source),
    relayLeadInboxMessages: source.relayLeadInboxMessages.bind(source),
  };
}
