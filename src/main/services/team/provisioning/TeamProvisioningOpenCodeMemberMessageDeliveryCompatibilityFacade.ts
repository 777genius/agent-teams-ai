import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { isOpenCodeLeadRecipient } from '../opencode/delivery/OpenCodeLeadTurnActivity';
import {
  type OpenCodeLeadTurnActivityNotification,
  type OpenCodeMemberInboxDelivery,
  type OpenCodeMemberMessageDeliveryInput,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryPorts';

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

type OpenCodeMemberMessageDeliveryHostRun = NonNullable<
  ReturnType<TeamProvisioningOpenCodeMemberMessageDeliveryHost['runs']['get']>
>;

/** A lead turn reported 'active' without a settle signal falls back to 'idle' after this long. */
export const OPENCODE_LEAD_ACTIVE_FALLBACK_MS = 4 * 60_000;

export interface TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceDeps<
  TRun extends TeamProvisioningSendMessageToRunRun,
> {
  readLeadActivityDirectory: TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost['openCodeRuntimeRecoveryFacade']['readOpenCodeMemberDirectory'];
  createDeliveryHost(): TeamProvisioningOpenCodeMemberMessageDeliveryHost;
  /** Tracked run that owns the OpenCode primary lane for a team, if any. */
  resolveLeadActivityRun(teamName: string): TRun | null;
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
  setLeadActivity(run: TRun, state: OpenCodeLeadTurnActivityNotification['state']): void;
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
  runs: { get(runId: string): (TRun & OpenCodeMemberMessageDeliveryHostRun) | undefined };
  isCurrentTrackedRun(run: TRun): boolean;
  setLeadActivity(run: TRun, state: OpenCodeLeadTurnActivityNotification['state']): void;
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

  private readonly openCodeLeadActiveFallbackTimers = new Map<string, NodeJS.Timeout>();

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

  protected createOpenCodeMemberMessageDeliveryService(): ReturnType<
    typeof createOpenCodeMemberMessageDeliveryServiceFromHost
  > {
    return createOpenCodeMemberMessageDeliveryServiceFromHost({
      ...this.deps.createDeliveryHost(),
      notifyOpenCodeLeadTurnActivity: (input) => {
        void this.notifyOpenCodeLeadTurnActivity(input);
      },
    });
  }

  private readonly leadActivityPending = new Map<string, Promise<void>>();

  /**
   * Mirrors `sendMessageToRun` -> `setLeadActivity(run, 'active')` for the
   * OpenCode primary lane, whose lead has no stdin stream. No-op when the team
   * has no deliverable tracked run.
   */
  notifyOpenCodeLeadTurnActivity(input: OpenCodeLeadTurnActivityNotification): Promise<void> {
    const key = input.teamName;
    const pending = (this.leadActivityPending.get(key) ?? Promise.resolve()).then(() =>
      this.applyOpenCodeLeadTurnActivity(input)
    );
    this.leadActivityPending.set(key, pending);
    void pending.finally(() => {
      if (this.leadActivityPending.get(key) === pending) this.leadActivityPending.delete(key);
    });
    return pending;
  }

  private async applyOpenCodeLeadTurnActivity(
    input: OpenCodeLeadTurnActivityNotification
  ): Promise<void> {
    if (input.laneId !== 'primary' || !input.runId) return;
    try {
      const directory = await this.deps.readLeadActivityDirectory(input.teamName);
      if (!isOpenCodeLeadRecipient(input.memberName, directory)) return;
      const run = this.deps.resolveLeadActivityRun(input.teamName);
      if (
        !run ||
        run.runId !== input.runId ||
        run.processKilled ||
        run.cancelRequested ||
        !this.deps.isCurrentTrackedRun(run)
      )
        return;
      this.deps.setLeadActivity(run, input.state);
      this.armOpenCodeLeadActiveFallback(input.teamName, input.runId, input.state);
    } catch (error) {
      this.deps.logger.warn(
        `OpenCode lead activity notification failed: ${this.deps.getErrorMessage(error)}`
      );
    }
  }

  /**
   * The OpenCode lead has no stdin stream, so 'idle' can only arrive from a
   * prompt-delivery settle. A runtime that keeps its session marked busy after a
   * plain-text turn end never produces that settle, and the lead card would stay
   * "processing" forever. A lead turn realistically finishes within minutes, so
   * fall back to 'idle' when no newer signal arrives within the bound.
   *
   * Armed only past the guards above, so a notification that was dropped (wrong
   * lane, not the lead recipient, a run that was replaced or stopped) neither
   * arms a fallback nor disarms the one the live turn is relying on. Every
   * accepted notification cancels the pending fallback first, so an 'idle' that
   * does arrive disarms it (no late write over a newer real state), and repeated
   * 'active' reports restart one timer rather than accumulating several. The
   * fallback re-checks the same run identity when it fires, so a run that was
   * replaced or stopped meanwhile is never written to.
   */
  private armOpenCodeLeadActiveFallback(
    teamName: string,
    runId: string,
    state: OpenCodeLeadTurnActivityNotification['state']
  ): void {
    const existing = this.openCodeLeadActiveFallbackTimers.get(teamName);
    if (existing) {
      clearTimeout(existing);
      this.openCodeLeadActiveFallbackTimers.delete(teamName);
    }
    if (state !== 'active') return;
    const timer = setTimeout(() => {
      this.openCodeLeadActiveFallbackTimers.delete(teamName);
      const fallbackRun = this.deps.resolveLeadActivityRun(teamName);
      if (
        !fallbackRun ||
        fallbackRun.runId !== runId ||
        fallbackRun.processKilled ||
        fallbackRun.cancelRequested ||
        !this.deps.isCurrentTrackedRun(fallbackRun)
      )
        return;
      this.deps.setLeadActivity(fallbackRun, 'idle');
    }, OPENCODE_LEAD_ACTIVE_FALLBACK_MS);
    timer.unref?.();
    this.openCodeLeadActiveFallbackTimers.set(teamName, timer);
  }

  async deliverOpenCodeMemberMessage(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery> {
    return await deliverOpenCodeMemberMessageHelper(
      this.createOpenCodeMemberMessageDeliveryService(),
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
    readLeadActivityDirectory: (teamName) =>
      service.openCodeRuntimeRecoveryFacade.readOpenCodeMemberDirectory(teamName),
    createDeliveryHost: () =>
      createTeamProvisioningOpenCodeMemberMessageDeliveryHostFromService(service),
    resolveLeadActivityRun: (teamName) => {
      const runId = service.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName);
      return (runId ? service.runs.get(runId) : undefined) ?? null;
    },
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

  protected createOpenCodeMemberMessageDeliveryService(): ReturnType<
    typeof createOpenCodeMemberMessageDeliveryServiceFromHost
  > {
    return (
      this.openCodeMemberMessageDeliveryCompatibility as unknown as {
        createOpenCodeMemberMessageDeliveryService(): ReturnType<
          typeof createOpenCodeMemberMessageDeliveryServiceFromHost
        >;
      }
    ).createOpenCodeMemberMessageDeliveryService();
  }

  protected notifyOpenCodeLeadTurnActivity(input: OpenCodeLeadTurnActivityNotification): void {
    void this.openCodeMemberMessageDeliveryCompatibility.notifyOpenCodeLeadTurnActivity(input);
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
