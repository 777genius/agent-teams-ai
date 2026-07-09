import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import {
  type OpenCodeMemberInboxDelivery,
  type OpenCodeMemberMessageDeliveryInput,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';

import { type OpenCodeAttachmentPayloadStore } from './TeamProvisioningOpenCodeAttachmentPayloads';
import {
  createTeamProvisioningOpenCodeInboxAttachmentPayloadBoundary,
  type TeamProvisioningOpenCodeInboxAttachmentPayloadBoundary,
} from './TeamProvisioningOpenCodeInboxAttachmentPayloadBoundaryFactory';
import { type OpenCodeMemberInboxRelayResult } from './TeamProvisioningOpenCodeMemberInboxRelay';
import {
  createTeamProvisioningOpenCodeMemberInboxRelayBoundary,
  createTeamProvisioningOpenCodeMemberInboxRelayHostFromService,
  type TeamProvisioningOpenCodeMemberInboxRelayBoundary,
  type TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps,
  type TeamProvisioningOpenCodeMemberInboxRelayHost,
  type TeamProvisioningOpenCodeMemberInboxRelayServiceHost,
} from './TeamProvisioningOpenCodeMemberInboxRelayBoundaryFactory';
import {
  createOpenCodeMemberMessageDeliveryServiceFromHost,
  createTeamProvisioningOpenCodeMemberMessageDeliveryHostFromService,
  deliverOpenCodeMemberMessage as deliverOpenCodeMemberMessageHelper,
  type TeamProvisioningOpenCodeMemberMessageDeliveryHost,
  type TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost,
} from './TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';
import { OpenCodeMemberSendSerializer } from './TeamProvisioningOpenCodeMemberSendSerialization';
import { TeamProvisioningOpenCodePromptDeliveryCompatibilityFacade } from './TeamProvisioningOpenCodePromptDeliveryCompatibilityFacade';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import {
  createTeamProvisioningSendMessageToRunBoundary,
  type TeamProvisioningSendMessageToRunBoundary,
  type TeamProvisioningSendMessageToRunRun,
} from './TeamProvisioningSendMessageToRunBoundaryFactory';

import type { OpenCodeTeamRuntimeMessageResult } from '../runtime';

const logger = createLogger('Service:TeamProvisioning');

type OpenCodeMemberMessageDeliveryCompatibilityRuntimeIdentity =
  TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['openCodeRuntimeRecoveryIdentity'];

export interface TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceDeps<
  TRun extends TeamProvisioningSendMessageToRunRun,
> {
  createDeliveryHost(): TeamProvisioningOpenCodeMemberMessageDeliveryHost;
  inboxRelayHost: TeamProvisioningOpenCodeMemberInboxRelayHost;
  getInboxReader(): ReturnType<
    TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['getInboxReader']
  >;
  getAttachmentStore(): OpenCodeAttachmentPayloadStore;
  getOpenCodeRuntimeRecoveryIdentity(): OpenCodeMemberMessageDeliveryCompatibilityRuntimeIdentity;
  getOpenCodeVisibleReplyProofService(): ReturnType<
    TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['getOpenCodeVisibleReplyProofService']
  >;
  getCleanedStoppedTeamOpenCodeRuntimeLanes(): TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['cleanedStoppedTeamOpenCodeRuntimeLanes'];
  isCurrentTrackedRun(run: TRun): boolean;
  setLeadActivity(run: TRun, state: 'active'): void;
  logger: TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['logger'];
  nowIso: TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['nowIso'];
  getErrorMessage: TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['getErrorMessage'];
}

export interface TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceHost<
  TRun extends TeamProvisioningSendMessageToRunRun,
>
  extends
    TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost,
    Omit<
      TeamProvisioningOpenCodeMemberInboxRelayServiceHost,
      'isOpenCodeDeliveryResponseReadCommitAllowed'
    > {
  inboxReader: ReturnType<TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['getInboxReader']>;
  attachmentStore: OpenCodeAttachmentPayloadStore;
  openCodeRuntimeRecoveryIdentity: OpenCodeMemberMessageDeliveryCompatibilityRuntimeIdentity;
  openCodeVisibleReplyProofService: TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost['openCodeVisibleReplyProofService'];
  cleanedStoppedTeamOpenCodeRuntimeLanes: TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps['cleanedStoppedTeamOpenCodeRuntimeLanes'];
  isCurrentTrackedRun(run: TRun): boolean;
  setLeadActivity(run: TRun, state: 'active'): void;
}

export class TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService<
  TRun extends TeamProvisioningSendMessageToRunRun,
> {
  readonly sendMessageToRunBoundary: TeamProvisioningSendMessageToRunBoundary<TRun>;
  readonly openCodeMemberInboxRelayInFlight = new Map<
    string,
    Promise<OpenCodeMemberInboxRelayResult>
  >();
  readonly openCodeMemberSendInFlightByLane = new Map<
    string,
    Promise<OpenCodeTeamRuntimeMessageResult>
  >();
  readonly openCodeMemberSendSerializer: OpenCodeMemberSendSerializer;
  readonly openCodeInboxAttachmentPayloadBoundary: TeamProvisioningOpenCodeInboxAttachmentPayloadBoundary;

  private openCodeMemberInboxRelayBoundaryValue: TeamProvisioningOpenCodeMemberInboxRelayBoundary | null =
    null;

  constructor(
    private readonly deps: TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceDeps<TRun>
  ) {
    this.sendMessageToRunBoundary = createTeamProvisioningSendMessageToRunBoundary<TRun>({
      isCurrentTrackedRun: (run) => this.deps.isCurrentTrackedRun(run),
      setLeadActivity: (run, state) => this.deps.setLeadActivity(run, state),
    });
    this.openCodeMemberSendSerializer = new OpenCodeMemberSendSerializer({
      inFlightByLane: this.openCodeMemberSendInFlightByLane,
    });
    this.openCodeInboxAttachmentPayloadBoundary =
      createTeamProvisioningOpenCodeInboxAttachmentPayloadBoundary({
        getAttachmentStore: () => this.deps.getAttachmentStore(),
      });
  }

  get openCodeMemberInboxRelayBoundary(): TeamProvisioningOpenCodeMemberInboxRelayBoundary {
    if (!this.openCodeMemberInboxRelayBoundaryValue) {
      this.openCodeMemberInboxRelayBoundaryValue =
        createTeamProvisioningOpenCodeMemberInboxRelayBoundary({
          host: this.deps.inboxRelayHost,
          inFlight: this.openCodeMemberInboxRelayInFlight,
          getInboxReader: () => this.deps.getInboxReader(),
          openCodeRuntimeRecoveryIdentity: {
            resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
              this.deps
                .getOpenCodeRuntimeRecoveryIdentity()
                .resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
            resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
              this.deps
                .getOpenCodeRuntimeRecoveryIdentity()
                .resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
          },
          getOpenCodeVisibleReplyProofService: () =>
            this.deps.getOpenCodeVisibleReplyProofService(),
          openCodeInboxAttachmentPayloadBoundary: this.openCodeInboxAttachmentPayloadBoundary,
          cleanedStoppedTeamOpenCodeRuntimeLanes: {
            has: (teamName) => this.deps.getCleanedStoppedTeamOpenCodeRuntimeLanes().has(teamName),
          },
          logger: this.deps.logger,
          nowIso: this.deps.nowIso,
          getErrorMessage: this.deps.getErrorMessage,
        });
    }
    return this.openCodeMemberInboxRelayBoundaryValue;
  }

  async deliverOpenCodeMemberMessage(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery> {
    return await deliverOpenCodeMemberMessageHelper(
      createOpenCodeMemberMessageDeliveryServiceFromHost(this.deps.createDeliveryHost()),
      teamName,
      input
    );
  }

  async sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult> {
    return this.openCodeMemberSendSerializer.sendSerialized(input);
  }
}

export function createTeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceFromService<
  TRun extends TeamProvisioningSendMessageToRunRun,
>(
  service: TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceHost<TRun>,
  options: Pick<
    TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceDeps<TRun>,
    'logger' | 'nowIso' | 'getErrorMessage'
  >
): TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService<TRun> {
  return new TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService<TRun>({
    createDeliveryHost: () =>
      createTeamProvisioningOpenCodeMemberMessageDeliveryHostFromService(service),
    inboxRelayHost: createTeamProvisioningOpenCodeMemberInboxRelayHostFromService(
      service as unknown as TeamProvisioningOpenCodeMemberInboxRelayServiceHost
    ),
    getInboxReader: () => service.inboxReader,
    getAttachmentStore: () => service.attachmentStore,
    getOpenCodeRuntimeRecoveryIdentity: () => service.openCodeRuntimeRecoveryIdentity,
    getOpenCodeVisibleReplyProofService: () => service.openCodeVisibleReplyProofService,
    getCleanedStoppedTeamOpenCodeRuntimeLanes: () => service.cleanedStoppedTeamOpenCodeRuntimeLanes,
    isCurrentTrackedRun: (run) => service.isCurrentTrackedRun(run),
    setLeadActivity: (run, state) => service.setLeadActivity(run, state),
    ...options,
  });
}

export abstract class TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningOpenCodePromptDeliveryCompatibilityFacade<TRun> {
  private readonly openCodeMemberMessageDeliveryCompatibility =
    createTeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceFromService(
      this as unknown as TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceHost<TRun>,
      {
        logger,
        nowIso,
        getErrorMessage,
      }
    );

  protected get sendMessageToRunBoundary(): TeamProvisioningSendMessageToRunBoundary<TRun> {
    return this.openCodeMemberMessageDeliveryCompatibility.sendMessageToRunBoundary;
  }

  protected get openCodeMemberInboxRelayInFlight(): Map<
    string,
    Promise<OpenCodeMemberInboxRelayResult>
  > {
    return this.openCodeMemberMessageDeliveryCompatibility.openCodeMemberInboxRelayInFlight;
  }

  protected get openCodeMemberSendInFlightByLane(): Map<
    string,
    Promise<OpenCodeTeamRuntimeMessageResult>
  > {
    return this.openCodeMemberMessageDeliveryCompatibility.openCodeMemberSendInFlightByLane;
  }

  protected get openCodeMemberSendSerializer(): OpenCodeMemberSendSerializer {
    return this.openCodeMemberMessageDeliveryCompatibility.openCodeMemberSendSerializer;
  }

  protected get openCodeInboxAttachmentPayloadBoundary(): TeamProvisioningOpenCodeInboxAttachmentPayloadBoundary {
    return this.openCodeMemberMessageDeliveryCompatibility.openCodeInboxAttachmentPayloadBoundary;
  }

  protected get openCodeMemberInboxRelayBoundary(): TeamProvisioningOpenCodeMemberInboxRelayBoundary {
    return this.openCodeMemberMessageDeliveryCompatibility.openCodeMemberInboxRelayBoundary;
  }

  async deliverOpenCodeMemberMessage(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery> {
    return await this.openCodeMemberMessageDeliveryCompatibility.deliverOpenCodeMemberMessage(
      teamName,
      input
    );
  }

  protected async sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult> {
    return await this.openCodeMemberMessageDeliveryCompatibility.sendOpenCodeMemberMessageToRuntimeSerialized(
      input
    );
  }
}
