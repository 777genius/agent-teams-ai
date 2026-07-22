import { getTeamsBasePath as getDefaultTeamsBasePath } from '@main/utils/pathDecoder';

import { type OpenCodeSecondaryRuntimeRunIdentity } from './TeamProvisioningOpenCodeMemberIdentity';
import {
  createTeamProvisioningOpenCodeMemberIdentityBoundary,
  type TeamProvisioningOpenCodeMemberIdentityBoundary,
} from './TeamProvisioningOpenCodeMemberIdentityBoundaryFactory';
import {
  type OpenCodeRuntimeConfiguredMemberLaneRecoveryInput,
  type OpenCodeRuntimeConfiguredMemberLaneRecoveryVerificationInput,
  type OpenCodeRuntimeLaneBeforeDeliveryRecoveryInput,
  type OpenCodeRuntimeLaneCommittedSessionRecoveryInput,
  TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade,
  type TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeDeps,
  type TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHost,
} from './TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade';
import {
  createOpenCodeRuntimeRecoveryIdentityHelpers,
  type OpenCodeMemberDeliveryIdentityResolution,
  type OpenCodeRuntimeRecoveryIdentityHelpers,
} from './TeamProvisioningOpenCodeRuntimeRecoveryIdentity';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { TeamProvisioningOpenCodeStoppedLaneCleanupBoundary } from './TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';
import type { TeamProviderId } from '@shared/types';

export type TeamProvisioningOpenCodeRuntimeRecoveryFacadeHost = Omit<
  TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHost,
  | 'readOpenCodeMemberDirectory'
  | 'resolveOpenCodeMemberIdentityFromDirectory'
  | 'openCodeRuntimeRecoveryIdentity'
> & {
  getCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): string | null;
  getSecondaryRuntimeRuns(teamName: string): readonly OpenCodeSecondaryRuntimeRunIdentity[];
  getRuntimeAdapterProviderId(teamName: string): TeamProviderId | null;
};

export interface TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost extends Omit<
  TeamProvisioningOpenCodeRuntimeRecoveryFacadeHost,
  | 'cleanupStoppedTeamOpenCodeRuntimeLanesInBackground'
  | 'readConfigForObservation'
  | 'getRuntimeAdapterProviderId'
> {
  openCodeStoppedLaneCleanup: Pick<
    TeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
    'cleanupStoppedTeamOpenCodeRuntimeLanesInBackground'
  >;
  configFacade: {
    readConfigForObservation: TeamProvisioningOpenCodeRuntimeRecoveryFacadeHost['readConfigForObservation'];
  };
  runtimeAdapterRunByTeam: {
    get(teamName: string): { providerId: TeamProviderId } | undefined;
  };
}

export type TeamProvisioningOpenCodeRuntimeRecoveryFacadeDeps =
  TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeDeps;

export class TeamProvisioningOpenCodeRuntimeRecoveryFacade {
  readonly openCodeRuntimeRecoveryIdentity: OpenCodeRuntimeRecoveryIdentityHelpers;

  private readonly memberIdentityBoundary: TeamProvisioningOpenCodeMemberIdentityBoundary;
  private readonly laneRecoveryFacade: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade;

  constructor(
    private readonly host: TeamProvisioningOpenCodeRuntimeRecoveryFacadeHost,
    deps: TeamProvisioningOpenCodeRuntimeRecoveryFacadeDeps = {}
  ) {
    const getTeamsBasePath = deps.getTeamsBasePath ?? getDefaultTeamsBasePath;
    this.memberIdentityBoundary = createTeamProvisioningOpenCodeMemberIdentityBoundary({
      getSecondaryRuntimeRuns: (teamName) => host.getSecondaryRuntimeRuns(teamName),
      getRuntimeAdapterProviderId: (teamName) => host.getRuntimeAdapterProviderId(teamName),
    });
    this.openCodeRuntimeRecoveryIdentity = createOpenCodeRuntimeRecoveryIdentityHelpers({
      getTeamsBasePath,
      getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        host.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
      readOpenCodeMemberDirectory: (teamName) => this.readOpenCodeMemberDirectory(teamName),
      resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
        this.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
    });
    this.laneRecoveryFacade = new TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade(
      {
        ...host,
        readOpenCodeMemberDirectory: (teamName) => this.readOpenCodeMemberDirectory(teamName),
        resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
          this.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
        openCodeRuntimeRecoveryIdentity: this.openCodeRuntimeRecoveryIdentity,
      },
      deps
    );
  }

  async readOpenCodeMemberDirectory(teamName: string): Promise<OpenCodeMemberDirectory> {
    const [config, teamMeta, metaMembers] = await Promise.all([
      this.host.readConfigForObservation(teamName).catch(() => null),
      this.host.teamMetaStore.getMeta(teamName).catch(() => null),
      this.host.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    return { config, teamMeta, metaMembers };
  }

  resolveOpenCodeMemberIdentityFromDirectory(
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ): OpenCodeMemberIdentityResolution {
    return this.memberIdentityBoundary.resolveOpenCodeMemberIdentityFromDirectory(
      teamName,
      memberName,
      directory
    );
  }

  async resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberDeliveryIdentityResolution> {
    return await this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
      teamName,
      memberName
    );
  }

  async tryRecoverOpenCodeRuntimeLaneBeforeDelivery(
    input: OpenCodeRuntimeLaneBeforeDeliveryRecoveryInput
  ): Promise<boolean> {
    return await this.laneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input);
  }

  async tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
    input: OpenCodeRuntimeLaneCommittedSessionRecoveryInput
  ): Promise<boolean> {
    return await this.laneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
      input
    );
  }

  async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
    input: OpenCodeRuntimeConfiguredMemberLaneRecoveryInput
  ): Promise<boolean> {
    return await this.laneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
      input
    );
  }

  async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(
    input: OpenCodeRuntimeConfiguredMemberLaneRecoveryVerificationInput
  ): Promise<boolean> {
    return await this.laneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(
      input
    );
  }

  async tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
    teamName: string,
    options: { allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean } = {}
  ): Promise<string[]> {
    return await this.laneRecoveryFacade.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
      teamName,
      options
    );
  }
}

export function createTeamProvisioningOpenCodeRuntimeRecoveryFacadeHostFromService(
  service: TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost
): TeamProvisioningOpenCodeRuntimeRecoveryFacadeHost {
  return {
    runTracking: {
      canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
        service.runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
      canAttemptCommittedOpenCodeSessionRecovery: (teamName) =>
        service.runTracking.canAttemptCommittedOpenCodeSessionRecovery(teamName),
    },
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
      service.openCodeStoppedLaneCleanup.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(
        teamName
      ),
    launchStateStore: {
      read: (teamName) => service.launchStateStore.read(teamName),
    },
    openCodeRuntimeRecoveryBoundary: {
      tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: (input) =>
        service.openCodeRuntimeRecoveryBoundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(
          input
        ),
      tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: (input) =>
        service.openCodeRuntimeRecoveryBoundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(
          input
        ),
    },
    readConfigForObservation: (teamName) => service.configFacade.readConfigForObservation(teamName),
    teamMetaStore: {
      getMeta: (teamName) => service.teamMetaStore.getMeta(teamName),
    },
    membersMetaStore: {
      getMembers: (teamName) => service.membersMetaStore.getMembers(teamName),
    },
    readPersistedTeamProjectPath: (teamName) => service.readPersistedTeamProjectPath(teamName),
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      service.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
    getSecondaryRuntimeRuns: (teamName) => service.getSecondaryRuntimeRuns(teamName),
    getRuntimeAdapterProviderId: (teamName) =>
      service.runtimeAdapterRunByTeam.get(teamName)?.providerId ?? null,
  };
}

export function createTeamProvisioningOpenCodeRuntimeRecoveryFacadeFromService(
  service: TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost,
  deps: TeamProvisioningOpenCodeRuntimeRecoveryFacadeDeps = {}
): TeamProvisioningOpenCodeRuntimeRecoveryFacade {
  return new TeamProvisioningOpenCodeRuntimeRecoveryFacade(
    createTeamProvisioningOpenCodeRuntimeRecoveryFacadeHostFromService(service),
    deps
  );
}
