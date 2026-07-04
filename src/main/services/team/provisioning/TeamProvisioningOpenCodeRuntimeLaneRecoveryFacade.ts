import { getTeamsBasePath as getDefaultTeamsBasePath } from '@main/utils/pathDecoder';

import {
  createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost,
  type TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost,
} from './TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactory';
import {
  type OpenCodeRuntimeLaneRecoveryPorts,
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery as tryRecoverOpenCodeRuntimeLaneBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive as tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActiveHelper,
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery as tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery as tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog as tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdogHelper,
} from './TeamProvisioningOpenCodeRuntimeRecoveryFlow';

export type TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHost =
  TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost;

export type OpenCodeRuntimeLaneBeforeDeliveryRecoveryInput = Parameters<
  typeof tryRecoverOpenCodeRuntimeLaneBeforeDeliveryHelper
>[0];
export type OpenCodeRuntimeLaneCommittedSessionRecoveryInput = Parameters<
  typeof tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDeliveryHelper
>[0];
export type OpenCodeRuntimeConfiguredMemberLaneRecoveryInput = Parameters<
  typeof tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDeliveryHelper
>[0];
export type OpenCodeRuntimeConfiguredMemberLaneRecoveryVerificationInput = Parameters<
  typeof tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActiveHelper
>[0];

export interface TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers {
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery: typeof tryRecoverOpenCodeRuntimeLaneBeforeDeliveryHelper;
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: typeof tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDeliveryHelper;
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: typeof tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDeliveryHelper;
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: typeof tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActiveHelper;
  tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog: typeof tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdogHelper;
}

const defaultHelpers: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers = {
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery: tryRecoverOpenCodeRuntimeLaneBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery:
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery:
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive:
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActiveHelper,
  tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog:
    tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdogHelper,
};

export interface TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeDeps {
  getTeamsBasePath?: () => string;
  logger?: OpenCodeRuntimeLaneRecoveryPorts['logger'];
  helpers?: Partial<TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers>;
}

export class TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade {
  private readonly helpers: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers;

  constructor(
    private readonly host: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHost,
    private readonly deps: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeDeps = {}
  ) {
    this.helpers = {
      ...defaultHelpers,
      ...deps.helpers,
    };
  }

  async tryRecoverOpenCodeRuntimeLaneBeforeDelivery(
    input: OpenCodeRuntimeLaneBeforeDeliveryRecoveryInput
  ): Promise<boolean> {
    return await this.helpers.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(
      input,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
    );
  }

  async tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
    input: OpenCodeRuntimeLaneCommittedSessionRecoveryInput
  ): Promise<boolean> {
    return await this.helpers.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
      input,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
    );
  }

  async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
    input: OpenCodeRuntimeConfiguredMemberLaneRecoveryInput
  ): Promise<boolean> {
    return await this.helpers.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
      input,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
    );
  }

  async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(
    input: OpenCodeRuntimeConfiguredMemberLaneRecoveryVerificationInput
  ): Promise<boolean> {
    return await this.helpers.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(
      input,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
    );
  }

  async tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
    teamName: string,
    options: { allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean } = {}
  ): Promise<string[]> {
    return await this.helpers.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
      teamName,
      options,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
    );
  }

  private createOpenCodeRuntimeLaneRecoveryPorts(): OpenCodeRuntimeLaneRecoveryPorts {
    return createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost(this.host, {
      teamsBasePath: (this.deps.getTeamsBasePath ?? getDefaultTeamsBasePath)(),
      logger: this.deps.logger,
    });
  }
}
