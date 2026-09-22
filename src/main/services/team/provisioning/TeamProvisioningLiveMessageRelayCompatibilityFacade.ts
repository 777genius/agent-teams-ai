import { createLogger } from '@shared/utils/logger';

import { TeamProvisioningDiagnosticsPreflightCompatibilityFacade } from './TeamProvisioningDiagnosticsPreflightCompatibilityFacade';
import {
  type NativeSameTeamFingerprint,
  trimRelayedMessageIdSet,
} from './TeamProvisioningInboxRelayPolicy';
import {
  type TeamProvisioningLeadInboxRelayCompatibilityFacade,
  type TeamProvisioningLeadInboxRelayCompatibilityRun,
} from './TeamProvisioningLeadInboxRelayCompatibilityFacade';
import { type LiveInboxRelayResult } from './TeamProvisioningLiveInboxRelayRouting';
import {
  createTeamProvisioningLiveLeadMessagePortsBoundary,
  createTeamProvisioningLiveLeadMessagePortsDepsFromService,
  type TeamProvisioningLiveLeadMessagePortsBoundary,
  type TeamProvisioningLiveLeadMessagePortsFactoryRun,
  type TeamProvisioningLiveLeadMessageServiceHost,
} from './TeamProvisioningLiveLeadMessagePortsFactory';
import {
  type OpenCodeMemberInboxRelayOptions,
  type OpenCodeMemberInboxRelayResult,
} from './TeamProvisioningOpenCodeMemberInboxRelay';
import {
  LEAD_TEXT_EMIT_THROTTLE_MS,
  LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT,
  type ProvisioningRun,
} from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import { type TeamProvisioningSameTeamNativeDelivery } from './TeamProvisioningSameTeamNativeDelivery';

import type { InboxMessage } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export type TeamProvisioningLiveMessageRelayCompatibilityRun = ProvisioningRun &
  TeamProvisioningLiveLeadMessagePortsFactoryRun &
  TeamProvisioningLeadInboxRelayCompatibilityRun;

export abstract class TeamProvisioningLiveMessageRelayCompatibilityFacade<
  TRun extends TeamProvisioningLiveMessageRelayCompatibilityRun =
    TeamProvisioningLiveMessageRelayCompatibilityRun,
> extends TeamProvisioningDiagnosticsPreflightCompatibilityFacade<TRun> {
  protected readonly liveLeadProcessMessages = new Map<string, InboxMessage[]>();
  protected readonly liveLeadMessagePortsBoundary: TeamProvisioningLiveLeadMessagePortsBoundary<TRun> =
    createTeamProvisioningLiveLeadMessagePortsBoundary<TRun>(
      createTeamProvisioningLiveLeadMessagePortsDepsFromService(
        this as unknown as TeamProvisioningLiveLeadMessageServiceHost<TRun>,
        {
          logger: {
            debug: (message) => logger.debug(message),
            warn: (message) => logger.warn(message),
          },
          nowIso,
          nowMs: () => Date.now(),
          cacheLimit: LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT,
          leadTextEmitThrottleMs: LEAD_TEXT_EMIT_THROTTLE_MS,
        }
      )
    );

  protected abstract readonly leadInboxRelayFacade: TeamProvisioningLeadInboxRelayCompatibilityFacade<TRun>;

  protected rememberRecentCrossTeamLeadDeliveryMessageIds(
    teamName: string,
    messageIds: readonly string[]
  ): void {
    this.leadInboxRelayFacade.rememberRecentCrossTeamLeadDeliveryMessageIds(teamName, messageIds);
  }

  protected get leadInboxRelayInFlight(): Map<string, Promise<number>> {
    return this.leadInboxRelayFacade.leadInboxRelayInFlight;
  }

  protected get relayedLeadInboxMessageIds(): Map<string, Set<string>> {
    return this.leadInboxRelayFacade.relayedLeadInboxMessageIds;
  }

  protected get successfulLeadRecoveryMessageIds(): Map<string, Set<string>> {
    return this.leadInboxRelayFacade.successfulLeadRecoveryMessageIds;
  }

  protected get leadRecoveryMessageIds(): Map<string, Set<string>> {
    return this.leadInboxRelayFacade.leadRecoveryMessageIds;
  }

  protected get memberInboxRelayInFlight(): Map<string, Promise<number>> {
    return this.leadInboxRelayFacade.memberInboxRelayInFlight;
  }

  protected get relayedMemberInboxMessageIds(): Map<string, Set<string>> {
    return this.leadInboxRelayFacade.relayedMemberInboxMessageIds;
  }

  protected get pendingCrossTeamFirstReplies(): Map<string, Map<string, number>> {
    return this.leadInboxRelayFacade.pendingCrossTeamFirstReplies;
  }

  protected get recentCrossTeamLeadDeliveryMessageIds(): Map<string, Map<string, number>> {
    return this.leadInboxRelayFacade.recentCrossTeamLeadDeliveryMessageIds;
  }

  protected get recentSameTeamNativeFingerprints(): Map<string, NativeSameTeamFingerprint[]> {
    return this.leadInboxRelayFacade.recentSameTeamNativeFingerprints;
  }

  protected get sameTeamNativeDelivery(): TeamProvisioningSameTeamNativeDelivery {
    return this.leadInboxRelayFacade.sameTeamNativeDelivery;
  }

  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    this.leadInboxRelayFacade.registerPendingCrossTeamReplyExpectation(
      teamName,
      otherTeam,
      conversationId
    );
  }

  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    this.leadInboxRelayFacade.clearPendingCrossTeamReplyExpectation(
      teamName,
      otherTeam,
      conversationId
    );
  }

  protected getPendingCrossTeamReplyExpectationKeys(teamName: string): Set<string> {
    return this.leadInboxRelayFacade.getPendingCrossTeamReplyExpectationKeys(teamName);
  }

  protected getRunLeadName(run: TRun): string {
    return this.leadInboxRelayFacade.getRunLeadName(run);
  }

  protected handleNativeTeammateUserMessage(run: TRun, msg: Record<string, unknown>): void {
    this.leadInboxRelayFacade.handleNativeTeammateUserMessage(run, msg);
  }

  protected getMemberRelayKey(teamName: string, memberName: string): string {
    return this.leadInboxRelayFacade.getMemberRelayKey(teamName, memberName);
  }

  protected getOpenCodeMemberRelayKey(teamName: string, memberName: string): string {
    return this.leadInboxRelayFacade.getOpenCodeMemberRelayKey(teamName, memberName);
  }

  /**
   * Legacy lead-mediated user DM relay. Native teammates read direct inbox files; this remains
   * for compatibility with older callers and tests that exercise the relay path explicitly.
   */
  async forwardUserDmToTeammate(
    teamName: string,
    teammateName: string,
    userText: string,
    userSummary?: string
  ): Promise<void> {
    await this.leadInboxRelayFacade.forwardUserDmToTeammate(
      teamName,
      teammateName,
      userText,
      userSummary
    );
  }

  async relayMemberInboxMessages(teamName: string, memberName: string): Promise<number> {
    return this.leadInboxRelayFacade.relayMemberInboxMessages(teamName, memberName);
  }

  async relayInboxFileToLiveRecipient(
    teamName: string,
    inboxName: string,
    options: OpenCodeMemberInboxRelayOptions = {}
  ): Promise<LiveInboxRelayResult> {
    return this.leadInboxRelayFacade.relayInboxFileToLiveRecipient(teamName, inboxName, options);
  }

  async relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: OpenCodeMemberInboxRelayOptions = {}
  ): Promise<OpenCodeMemberInboxRelayResult> {
    return this.leadInboxRelayFacade.relayOpenCodeMemberInboxMessages(
      teamName,
      memberName,
      options
    );
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    return this.leadInboxRelayFacade.relayLeadInboxMessages(teamName);
  }

  protected trimRelayedSet(set: Set<string>): Set<string> {
    return trimRelayedMessageIdSet(set);
  }
}
