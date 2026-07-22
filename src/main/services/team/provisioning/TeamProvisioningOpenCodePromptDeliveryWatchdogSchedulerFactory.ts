import {
  OpenCodePromptDeliveryWatchdogScheduler,
  type OpenCodePromptDeliveryWatchdogSchedulerDependencies,
} from '../opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';

export interface TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost {
  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: { onlyMessageId: string; source: 'watchdog' }
  ): Promise<unknown>;
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
      await service.relayOpenCodeMemberInboxMessages(input.teamName, input.memberName, {
        onlyMessageId: input.messageId,
        source: 'watchdog',
      });
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
