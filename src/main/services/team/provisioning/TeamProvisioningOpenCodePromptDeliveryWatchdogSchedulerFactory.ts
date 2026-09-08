import { OPENCODE_STALE_PENDING_TERMINAL_REASON } from '../opencode/delivery/OpenCodePromptDeliveryStalePendingPolicy';
import {
  OpenCodePromptDeliveryWatchdogScheduler,
  type OpenCodePromptDeliveryWatchdogSchedulerDependencies,
} from '../opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';

import type { OpenCodeMemberInboxRelayResult } from './TeamProvisioningOpenCodeMemberInboxRelay';

export interface TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost {
  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: { onlyMessageId?: string; source: 'watchdog' }
  ): Promise<OpenCodeMemberInboxRelayResult>;
  inboxReader: {
    getMessagesFor(
      teamName: string,
      memberName: string
    ): ReturnType<OpenCodePromptDeliveryWatchdogSchedulerDependencies['getInboxMessages']>;
  };
  openCodeRuntimeRecoveryIdentity: {
    resolveOpenCodeMemberDeliveryIdentity(
      teamName: string,
      memberName: string
    ): ReturnType<OpenCodePromptDeliveryWatchdogSchedulerDependencies['resolveIdentity']>;
    isOpenCodeRuntimeLaneIndexActive(
      teamName: string,
      laneId: string
    ): ReturnType<OpenCodePromptDeliveryWatchdogSchedulerDependencies['isLaneActive']>;
  };
}

export interface TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHostOptions {
  logger: {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
    diagnostic(message: string): void;
  };
  getErrorMessage(error: unknown): string;
}

export function createOpenCodePromptDeliveryWatchdogSchedulerDepsFromService(
  service: TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost,
  options: TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHostOptions
): OpenCodePromptDeliveryWatchdogSchedulerDependencies {
  return {
    canDeliverToTeamRuntime: (teamName) => service.canDeliverToOpenCodeRuntimeForTeam(teamName),
    recoverBeforeDelivery: (input) =>
      service.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input),
    relay: async (input) => {
      const result = await service.relayOpenCodeMemberInboxMessages(
        input.teamName,
        input.memberName,
        {
          onlyMessageId: input.messageId,
          source: 'watchdog',
        }
      );
      // Terminal ledger writes do not emit an inbox event. Wake queued rows once,
      // while preserving the failed row as unread for explicit manual recovery.
      if (
        result.lastDelivery?.ledgerStatus === 'failed_terminal' &&
        result.lastDelivery.reason === OPENCODE_STALE_PENDING_TERMINAL_REASON &&
        service.canDeliverToOpenCodeRuntimeForTeam(input.teamName)
      ) {
        await service.relayOpenCodeMemberInboxMessages(input.teamName, input.memberName, {
          source: 'watchdog',
        });
      }
      // The wake's own account travels back to the scheduler. Discarding it is
      // what made a wake that was refused on every attempt silent: the only
      // reader of a relay result was the inbox file-change path, so a lane that
      // received no new inbox row explained itself nowhere. It is the targeted
      // relay's result, not the re-relay's: the re-relay is about the rows
      // queued behind this one, and this wake is about this row.
      return result;
    },
    getInboxMessages: (input) =>
      service.inboxReader.getMessagesFor(input.teamName, input.memberName),
    resolveIdentity: (input) =>
      service.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
        input.teamName,
        input.memberName
      ),
    isLaneActive: (input) =>
      service.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive(
        input.teamName,
        input.laneId
      ),
    isRecordNotFoundError: (error) =>
      options.getErrorMessage(error).startsWith('OpenCode prompt delivery record not found:'),
    info: (message) => options.logger.info(message),
    warn: (message) => options.logger.warn(message),
    debug: (message) => options.logger.debug(message),
    diagnostic: (message) => options.logger.diagnostic(message),
    getErrorMessage: options.getErrorMessage,
  };
}

export function createOpenCodePromptDeliveryWatchdogSchedulerFromService(
  service: TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost,
  options: TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHostOptions
): OpenCodePromptDeliveryWatchdogScheduler {
  return new OpenCodePromptDeliveryWatchdogScheduler(
    createOpenCodePromptDeliveryWatchdogSchedulerDepsFromService(service, options)
  );
}
