import { TeamTaskReader } from '../TeamTaskReader';

import {
  type OpenCodeMemberInboxRelayOptions,
  type OpenCodeMemberInboxRelayResult,
  type RelayOpenCodeMemberInboxMessagesPorts,
  relayOpenCodeMemberInboxMessagesWithPorts,
} from './TeamProvisioningOpenCodeMemberInboxRelay';

type OpenCodeMemberInboxRelayPorts = RelayOpenCodeMemberInboxMessagesPorts;

export interface TeamProvisioningOpenCodeMemberInboxRelayHost {
  getOpenCodeMemberRelayKey(teamName: string, memberName: string): string;
  scheduleOpenCodeMemberInboxDeliveryWake: OpenCodeMemberInboxRelayPorts['scheduleOpenCodeMemberInboxDeliveryWake'];
  isOpenCodeRuntimeRecipient: OpenCodeMemberInboxRelayPorts['isOpenCodeRuntimeRecipient'];
  createOpenCodePromptDeliveryLedger: OpenCodeMemberInboxRelayPorts['createOpenCodePromptDeliveryLedger'];
  requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: OpenCodeMemberInboxRelayPorts['requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded'];
  requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: OpenCodeMemberInboxRelayPorts['requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded'];
  isOpenCodeDeliveryResponseReadCommitAllowed: OpenCodeMemberInboxRelayPorts['isOpenCodeDeliveryResponseReadCommitAllowed'];
  markInboxMessagesRead: OpenCodeMemberInboxRelayPorts['markInboxMessagesRead'];
  logOpenCodePromptDeliveryEvent: OpenCodeMemberInboxRelayPorts['logOpenCodePromptDeliveryEvent'];
  markOpenCodePromptLedgerFailedTerminal: OpenCodeMemberInboxRelayPorts['markOpenCodePromptLedgerFailedTerminal'];
  deliverOpenCodeMemberMessage: OpenCodeMemberInboxRelayPorts['deliverOpenCodeMemberMessage'];
}

export type TeamProvisioningOpenCodeMemberInboxRelayServiceHost =
  TeamProvisioningOpenCodeMemberInboxRelayHost;

export interface TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps {
  host: TeamProvisioningOpenCodeMemberInboxRelayHost;
  inFlight: OpenCodeMemberInboxRelayPorts['inFlight'];
  getInboxReader(): {
    getMessagesFor: OpenCodeMemberInboxRelayPorts['readInboxMessages'];
  };
  openCodeRuntimeRecoveryIdentity: {
    resolveOpenCodeMemberDeliveryIdentity: OpenCodeMemberInboxRelayPorts['resolveOpenCodeMemberDeliveryIdentity'];
    resolveCurrentOpenCodeRuntimeRunId: OpenCodeMemberInboxRelayPorts['resolveCurrentOpenCodeRuntimeRunId'];
  };
  getOpenCodeVisibleReplyProofService(): {
    applyDestinationProof: OpenCodeMemberInboxRelayPorts['applyDestinationProof'];
  };
  openCodeInboxAttachmentPayloadBoundary: {
    resolveOpenCodeInboxAttachmentPayloads: OpenCodeMemberInboxRelayPorts['resolveOpenCodeInboxAttachmentPayloads'];
  };
  cleanedStoppedTeamOpenCodeRuntimeLanes: {
    has(teamName: string): boolean;
  };
  readTaskRefInferenceTasks?: OpenCodeMemberInboxRelayPorts['readTaskRefInferenceTasks'];
  logger: {
    warn(message: string): void;
  };
  nowIso: OpenCodeMemberInboxRelayPorts['nowIso'];
  getErrorMessage: OpenCodeMemberInboxRelayPorts['getErrorMessage'];
}

export function createTeamProvisioningOpenCodeMemberInboxRelayHostFromService(
  service: TeamProvisioningOpenCodeMemberInboxRelayServiceHost
): TeamProvisioningOpenCodeMemberInboxRelayHost {
  return {
    getOpenCodeMemberRelayKey: (teamName, memberName) =>
      service.getOpenCodeMemberRelayKey(teamName, memberName),
    scheduleOpenCodeMemberInboxDeliveryWake: (input) =>
      service.scheduleOpenCodeMemberInboxDeliveryWake(input),
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      service.isOpenCodeRuntimeRecipient(teamName, memberName),
    createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
      service.createOpenCodePromptDeliveryLedger(teamName, laneId),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: (input) =>
      service.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input),
    requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: (input) =>
      service.requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded(input),
    isOpenCodeDeliveryResponseReadCommitAllowed: (input) =>
      service.isOpenCodeDeliveryResponseReadCommitAllowed(input),
    markInboxMessagesRead: (teamName, memberName, messages) =>
      service.markInboxMessagesRead(teamName, memberName, messages),
    logOpenCodePromptDeliveryEvent: (event, record, extra) =>
      service.logOpenCodePromptDeliveryEvent(event, record, extra),
    markOpenCodePromptLedgerFailedTerminal: (input) =>
      service.markOpenCodePromptLedgerFailedTerminal(input),
    deliverOpenCodeMemberMessage: (teamName, input) =>
      service.deliverOpenCodeMemberMessage(teamName, input),
  };
}

export interface TeamProvisioningOpenCodeMemberInboxRelayBoundary {
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options?: OpenCodeMemberInboxRelayOptions
  ): Promise<OpenCodeMemberInboxRelayResult>;
}

export function createTeamProvisioningOpenCodeMemberInboxRelayBoundary(
  deps: TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps
): TeamProvisioningOpenCodeMemberInboxRelayBoundary {
  const readTaskRefInferenceTasks =
    deps.readTaskRefInferenceTasks ??
    ((teamName: string) => new TeamTaskReader().getTasks(teamName));

  return {
    relayOpenCodeMemberInboxMessages(teamName, memberName, options = {}) {
      return relayOpenCodeMemberInboxMessagesWithPorts(
        {
          teamName,
          memberName,
          relayKey: deps.host.getOpenCodeMemberRelayKey(teamName, memberName),
          options,
        },
        {
          inFlight: deps.inFlight,
          readInboxMessages: (teamName, memberName) =>
            deps.getInboxReader().getMessagesFor(teamName, memberName),
          scheduleOpenCodeMemberInboxDeliveryWake: (input) =>
            deps.host.scheduleOpenCodeMemberInboxDeliveryWake(input),
          isOpenCodeRuntimeRecipient: (teamName, memberName) =>
            deps.host.isOpenCodeRuntimeRecipient(teamName, memberName),
          resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
            deps.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
              teamName,
              memberName
            ),
          createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
            deps.host.createOpenCodePromptDeliveryLedger(teamName, laneId),
          requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: (input) =>
            deps.host.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input),
          requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: (input) =>
            deps.host.requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded(input),
          applyDestinationProof: (input) =>
            deps.getOpenCodeVisibleReplyProofService().applyDestinationProof(input),
          isOpenCodeDeliveryResponseReadCommitAllowed: (input) =>
            deps.host.isOpenCodeDeliveryResponseReadCommitAllowed(input),
          markInboxMessagesRead: (teamName, memberName, messages) =>
            deps.host.markInboxMessagesRead(teamName, memberName, messages),
          logOpenCodePromptDeliveryEvent: (event, record, extra) =>
            deps.host.logOpenCodePromptDeliveryEvent(event, record, extra),
          readTaskRefInferenceTasks: (teamName) =>
            readTaskRefInferenceTasks(teamName).catch(() => []),
          resolveOpenCodeInboxAttachmentPayloads: (input) =>
            deps.openCodeInboxAttachmentPayloadBoundary.resolveOpenCodeInboxAttachmentPayloads(
              input
            ),
          resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
            deps.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
              teamName,
              laneId
            ),
          markOpenCodePromptLedgerFailedTerminal: (input) =>
            deps.host.markOpenCodePromptLedgerFailedTerminal(input),
          deliverOpenCodeMemberMessage: (teamName, input) =>
            deps.host.deliverOpenCodeMemberMessage(teamName, input),
          suppressRuntimeInactiveWarning: (teamName) =>
            deps.cleanedStoppedTeamOpenCodeRuntimeLanes.has(teamName),
          logWarning: (message) => deps.logger.warn(message),
          nowIso: deps.nowIso,
          getErrorMessage: deps.getErrorMessage,
        }
      );
    },
  };
}
