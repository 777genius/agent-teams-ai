import { type ParsedPermissionRequest } from '@shared/utils/inboxNoise';
import { type ParsedTeammateContent } from '@shared/utils/teammateMessageParser';

import {
  clearPendingCrossTeamReplyExpectation as clearPendingCrossTeamReplyExpectationInState,
  type CrossTeamDeliveredLeadBlock,
  type CrossTeamLeadInboxMatch,
  type CrossTeamLeadMemberLike,
  getPendingCrossTeamReplyExpectationKeys as getPendingCrossTeamReplyExpectationKeysFromState,
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
  readAndMatchCrossTeamLeadInboxMessages,
  registerPendingCrossTeamReplyExpectation as registerPendingCrossTeamReplyExpectationInState,
  rememberRecentCrossTeamLeadDeliveryMessageIds as rememberRecentCrossTeamLeadDeliveryMessageIdsHelper,
  resolveCrossTeamLeadName,
} from './TeamProvisioningCrossTeamRelayHelpers';
import { type NativeSameTeamFingerprint } from './TeamProvisioningInboxRelayPolicy';
import {
  type LeadInboxRelayFlowRun,
  type LeadInboxRelayOptions,
} from './TeamProvisioningLeadInboxRelayFlow';
import {
  createTeamProvisioningLeadInboxRelayPortsBoundary,
  type TeamProvisioningLeadInboxRelayPortsBoundary,
} from './TeamProvisioningLeadInboxRelayPortsFactory';
import {
  type LiveInboxRelayResult,
  relayInboxFileToLiveRecipientWithPorts,
} from './TeamProvisioningLiveInboxRelayRouting';
import {
  type MemberInboxRelayFlowRun,
  relayMemberInboxMessagesWithPorts,
} from './TeamProvisioningMemberInboxRelayFlow';
import { handleNativeTeammateUserMessage as handleNativeTeammateUserMessageHelper } from './TeamProvisioningNativeTeammateMessages';
import {
  type OpenCodeMemberInboxRelayOptions,
  type OpenCodeMemberInboxRelayResult,
} from './TeamProvisioningOpenCodeMemberInboxRelay';
import { isOpenCodeRuntimeRecipientFromSources } from './TeamProvisioningRuntimeRecipientResolution';
import {
  createDefaultTeamProvisioningSameTeamNativeDelivery,
  createTeamProvisioningSameTeamNativeDeliveryPorts,
  type TeamProvisioningSameTeamNativeDelivery,
} from './TeamProvisioningSameTeamNativeDelivery';
import {
  forwardUserDmToTeammateWithPorts,
  type TeamProvisioningUserDmRelayRun,
} from './TeamProvisioningUserDmRelay';

import type { InboxMessage, TeamChangeEvent, TeamConfig, TeamMember } from '@shared/types';

export interface TeamProvisioningLeadInboxRelayCompatibilityRunRequest {
  request?: {
    members?: readonly CrossTeamLeadMemberLike[] | null;
  } | null;
}

export type TeamProvisioningLeadInboxRelayCompatibilityRun = LeadInboxRelayFlowRun &
  MemberInboxRelayFlowRun &
  TeamProvisioningUserDmRelayRun &
  TeamProvisioningLeadInboxRelayCompatibilityRunRequest & {
    teamName: string;
    activeCrossTeamReplyHints: {
      toTeam: string;
      conversationId: string;
    }[];
  };

export interface TeamProvisioningLeadInboxRelayCompatibilityLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface TeamProvisioningLeadInboxRelayCompatibilityOptions {
  logger: TeamProvisioningLeadInboxRelayCompatibilityLogger;
  getErrorMessage(error: unknown): string;
  nowIso(): string;
  nowMs(): number;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
}

export interface TeamProvisioningLeadInboxRelayCompatibilityHost<
  TRun extends TeamProvisioningLeadInboxRelayCompatibilityRun,
> {
  getAliveRunId(teamName: string): string | null | undefined;
  getProvisioningRunId(teamName: string): string | null | undefined;
  getRun(runId: string): TRun | undefined;
  isCurrentTrackedRun(run: TRun): boolean;
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<readonly TeamMember[]>;
  readInboxMessages(teamName: string, memberName: string): Promise<InboxMessage[]>;
  markInboxMessagesRead(
    teamName: string,
    memberName: string,
    messages: { messageId: string }[]
  ): Promise<void>;
  handleTeammatePermissionRequest(
    run: TRun,
    permissionRequest: ParsedPermissionRequest,
    timestamp: string
  ): void;
  refreshMemberSpawnStatusesFromLeadInbox(run: TRun): Promise<void>;
  resolveControlApiBaseUrl(): Promise<string | null>;
  sendMessageToRun(run: TRun, message: string): Promise<void>;
  hasAcceptedLeadWorkSyncReport(input: { teamName: string; leadName: string }): Promise<boolean>;
  scheduleLeadProofMissingWorkSyncRecovery(input: {
    teamName: string;
    leadName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<boolean>;
  pushLiveLeadTextMessage(run: TRun, text: string, messageId: string, timestamp: string): void;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
  persistSentMessage(teamName: string, message: InboxMessage): void;
  emitTeamChange(event: TeamChangeEvent): void;
  scheduleLeadInboxFollowUpRelay(teamName: string): void;
  trimRelayedSet(relayedIds: Set<string>): Set<string>;
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  getMemberRelayKey(teamName: string, memberName: string): string;
  getOpenCodeMemberRelayKey(teamName: string, memberName: string): string;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: OpenCodeMemberInboxRelayOptions
  ): Promise<OpenCodeMemberInboxRelayResult>;
  isTeamAlive(teamName: string): boolean;
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: 'online' | 'error',
    error?: string,
    source?: 'heartbeat'
  ): void;
  pendingTimeouts: Map<string, NodeJS.Timeout>;
}

export interface TeamProvisioningLeadInboxRelayCompatibilityServiceHost<
  TRun extends TeamProvisioningLeadInboxRelayCompatibilityRun,
> {
  runTracking: {
    getAliveRunId(teamName: string): string | null | undefined;
    getProvisioningRunId(teamName: string): string | null | undefined;
  };
  runs: {
    get(runId: string): TRun | undefined;
  };
  isCurrentTrackedRun(run: TRun): boolean;
  configFacade: {
    readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  };
  membersMetaStore: {
    getMembers(teamName: string): Promise<readonly TeamMember[]>;
  };
  inboxReader: {
    getMessagesFor(teamName: string, memberName: string): Promise<InboxMessage[]>;
  };
  markInboxMessagesRead: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['markInboxMessagesRead'];
  handleTeammatePermissionRequest: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['handleTeammatePermissionRequest'];
  refreshMemberSpawnStatusesFromLeadInbox: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['refreshMemberSpawnStatusesFromLeadInbox'];
  providerRuntime: {
    resolveControlApiBaseUrl(): Promise<string | null>;
  };
  sendMessageToRun: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['sendMessageToRun'];
  hasAcceptedLeadWorkSyncReport: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['hasAcceptedLeadWorkSyncReport'];
  scheduleLeadProofMissingWorkSyncRecovery: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['scheduleLeadProofMissingWorkSyncRecovery'];
  pushLiveLeadTextMessage: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['pushLiveLeadTextMessage'];
  pushLiveLeadProcessMessage: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['pushLiveLeadProcessMessage'];
  persistSentMessage: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['persistSentMessage'];
  teamChangeEmitter?: ((event: TeamChangeEvent) => void) | null;
  scheduleLeadInboxFollowUpRelay: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['scheduleLeadInboxFollowUpRelay'];
  trimRelayedSet: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['trimRelayedSet'];
  memberWorkSyncProofBoundary: {
    hasAcceptedMemberWorkSyncReport: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['hasAcceptedMemberWorkSyncReport'];
  };
  openCodeMemberSendSerializer: {
    getMemberRelayKey(teamName: string, memberName: string): string;
    getOpenCodeMemberRelayKey(teamName: string, memberName: string): string;
  };
  openCodeMemberInboxRelayBoundary: {
    relayOpenCodeMemberInboxMessages(
      teamName: string,
      memberName: string,
      options: OpenCodeMemberInboxRelayOptions
    ): Promise<OpenCodeMemberInboxRelayResult>;
  };
  isTeamAlive(teamName: string): boolean;
  setMemberSpawnStatus: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['setMemberSpawnStatus'];
  pendingTimeouts: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>['pendingTimeouts'];
}

export function createTeamProvisioningLeadInboxRelayCompatibilityFacadeFromService<
  TRun extends TeamProvisioningLeadInboxRelayCompatibilityRun,
>(
  service: TeamProvisioningLeadInboxRelayCompatibilityServiceHost<TRun>,
  options: TeamProvisioningLeadInboxRelayCompatibilityOptions
): TeamProvisioningLeadInboxRelayCompatibilityFacade<TRun> {
  return new TeamProvisioningLeadInboxRelayCompatibilityFacade<TRun>(
    {
      getAliveRunId: (teamName) => service.runTracking.getAliveRunId(teamName),
      getProvisioningRunId: (teamName) => service.runTracking.getProvisioningRunId(teamName),
      getRun: (runId) => service.runs.get(runId),
      isCurrentTrackedRun: (run) => service.isCurrentTrackedRun(run),
      readConfigSnapshot: (teamName) => service.configFacade.readConfigSnapshot(teamName),
      readMetaMembers: (teamName) => service.membersMetaStore.getMembers(teamName),
      readInboxMessages: (teamName, memberName) =>
        service.inboxReader.getMessagesFor(teamName, memberName),
      markInboxMessagesRead: (teamName, memberName, messages) =>
        service.markInboxMessagesRead(teamName, memberName, messages),
      handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
        service.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        service.refreshMemberSpawnStatusesFromLeadInbox(run),
      resolveControlApiBaseUrl: () => service.providerRuntime.resolveControlApiBaseUrl(),
      sendMessageToRun: (run, message) => service.sendMessageToRun(run, message),
      hasAcceptedLeadWorkSyncReport: (input) => service.hasAcceptedLeadWorkSyncReport(input),
      scheduleLeadProofMissingWorkSyncRecovery: (input) =>
        service.scheduleLeadProofMissingWorkSyncRecovery(input),
      pushLiveLeadTextMessage: (run, text, messageId, timestamp) =>
        service.pushLiveLeadTextMessage(run, text, messageId, timestamp),
      pushLiveLeadProcessMessage: (teamName, message) =>
        service.pushLiveLeadProcessMessage(teamName, message),
      persistSentMessage: (teamName, message) => service.persistSentMessage(teamName, message),
      emitTeamChange: (event) => service.teamChangeEmitter?.(event),
      scheduleLeadInboxFollowUpRelay: (teamName) =>
        service.scheduleLeadInboxFollowUpRelay(teamName),
      trimRelayedSet: (relayedIds) => service.trimRelayedSet(relayedIds),
      hasAcceptedMemberWorkSyncReport: (input) =>
        service.memberWorkSyncProofBoundary.hasAcceptedMemberWorkSyncReport(input),
      getMemberRelayKey: (teamName, memberName) =>
        service.openCodeMemberSendSerializer.getMemberRelayKey(teamName, memberName),
      getOpenCodeMemberRelayKey: (teamName, memberName) =>
        service.openCodeMemberSendSerializer.getOpenCodeMemberRelayKey(teamName, memberName),
      relayOpenCodeMemberInboxMessages: (teamName, memberName, relayOptions) =>
        service.openCodeMemberInboxRelayBoundary.relayOpenCodeMemberInboxMessages(
          teamName,
          memberName,
          relayOptions
        ),
      isTeamAlive: (teamName) => service.isTeamAlive(teamName),
      setMemberSpawnStatus: (run, memberName, status, error, source) =>
        service.setMemberSpawnStatus(run, memberName, status, error, source),
      pendingTimeouts: service.pendingTimeouts,
    },
    options
  );
}

export class TeamProvisioningLeadInboxRelayCompatibilityFacade<
  TRun extends TeamProvisioningLeadInboxRelayCompatibilityRun,
> {
  readonly leadInboxRelayInFlight = new Map<string, Promise<number>>();
  readonly relayedLeadInboxMessageIds = new Map<string, Set<string>>();
  readonly memberInboxRelayInFlight = new Map<string, Promise<number>>();
  readonly relayedMemberInboxMessageIds = new Map<string, Set<string>>();
  readonly pendingCrossTeamFirstReplies = new Map<string, Map<string, number>>();
  readonly recentCrossTeamLeadDeliveryMessageIds = new Map<string, Map<string, number>>();
  readonly recentSameTeamNativeFingerprints = new Map<string, NativeSameTeamFingerprint[]>();

  private readonly leadInboxRelayBoundary: TeamProvisioningLeadInboxRelayPortsBoundary;
  readonly sameTeamNativeDelivery: TeamProvisioningSameTeamNativeDelivery;

  constructor(
    private readonly host: TeamProvisioningLeadInboxRelayCompatibilityHost<TRun>,
    private readonly options: TeamProvisioningLeadInboxRelayCompatibilityOptions
  ) {
    this.leadInboxRelayBoundary = createTeamProvisioningLeadInboxRelayPortsBoundary<TRun>({
      leadInboxRelayInFlight: this.leadInboxRelayInFlight,
      getAliveRunId: (teamName) => this.host.getAliveRunId(teamName),
      getProvisioningRunId: (teamName) => this.host.getProvisioningRunId(teamName),
      getRun: (runId) => this.host.getRun(runId),
      isCurrentTrackedRun: (run) => this.host.isCurrentTrackedRun(run),
      readConfigForObservation: (teamName) => this.host.readConfigSnapshot(teamName),
      readLeadInboxMessages: (teamName, leadName) =>
        this.host.readInboxMessages(teamName, leadName),
      markInboxMessagesRead: (teamName, leadName, messages) =>
        this.host.markInboxMessagesRead(teamName, leadName, messages),
      handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
        this.host.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        this.host.refreshMemberSpawnStatusesFromLeadInbox(run),
      confirmSameTeamNativeMatches: (teamName, leadName, messages) =>
        this.confirmSameTeamNativeMatches(teamName, leadName, messages),
      scheduleSameTeamPersistRetry: (teamName) => this.scheduleSameTeamPersistRetry(teamName),
      scheduleSameTeamDeferredRetry: (teamName) => this.scheduleSameTeamDeferredRetry(teamName),
      resolveControlApiBaseUrl: () => this.host.resolveControlApiBaseUrl(),
      sendMessageToRun: (run, message) => this.host.sendMessageToRun(run, message),
      hasAcceptedLeadWorkSyncReport: (input) => this.host.hasAcceptedLeadWorkSyncReport(input),
      scheduleLeadProofMissingWorkSyncRecovery: (input) =>
        this.host.scheduleLeadProofMissingWorkSyncRecovery(input),
      pushLiveLeadTextMessage: (run, text, messageId, timestamp) =>
        this.host.pushLiveLeadTextMessage(run, text, messageId, timestamp),
      pushLiveLeadProcessMessage: (teamName, message) =>
        this.host.pushLiveLeadProcessMessage(teamName, message),
      persistSentMessage: (teamName, message) => this.host.persistSentMessage(teamName, message),
      emitTeamChange: (event) => this.host.emitTeamChange(event),
      scheduleLeadInboxFollowUpRelay: (teamName) =>
        this.host.scheduleLeadInboxFollowUpRelay(teamName),
      relayedLeadInboxMessageIds: this.relayedLeadInboxMessageIds,
      trimRelayedSet: (relayedIds) => this.host.trimRelayedSet(relayedIds),
      pendingCrossTeamFirstReplies: this.pendingCrossTeamFirstReplies,
      recentCrossTeamLeadDeliveryMessageIds: this.recentCrossTeamLeadDeliveryMessageIds,
      logger: this.options.logger,
      getErrorMessage: this.options.getErrorMessage,
      nowIso: this.options.nowIso,
      nowMs: this.options.nowMs,
      setTimeout: this.options.setTimeout,
      clearTimeout: this.options.clearTimeout,
    });
    this.sameTeamNativeDelivery = createDefaultTeamProvisioningSameTeamNativeDelivery(
      createTeamProvisioningSameTeamNativeDeliveryPorts({
        inboxReader: {
          getMessagesFor: (teamName, memberName) =>
            this.host.readInboxMessages(teamName, memberName),
        },
        relayedLeadInboxMessageIds: this.relayedLeadInboxMessageIds,
        pendingTimeouts: this.host.pendingTimeouts,
        markInboxMessagesRead: (teamName, leadName, messages) =>
          this.host.markInboxMessagesRead(teamName, leadName, messages),
        relayLeadInboxMessages: (teamName) => this.relayLeadInboxMessages(teamName),
        trimRelayedSet: (set) => this.host.trimRelayedSet(set),
        warn: (message) => this.options.logger.warn(message),
        nowMs: this.options.nowMs,
        setTimeout: this.options.setTimeout,
      }),
      this.recentSameTeamNativeFingerprints
    );
  }

  rememberRecentCrossTeamLeadDeliveryMessageIds(
    teamName: string,
    messageIds: readonly string[]
  ): void {
    rememberRecentCrossTeamLeadDeliveryMessageIdsHelper(
      this.recentCrossTeamLeadDeliveryMessageIds,
      teamName,
      messageIds,
      this.options.nowMs()
    );
  }

  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    registerPendingCrossTeamReplyExpectationInState(
      this.pendingCrossTeamFirstReplies,
      teamName,
      otherTeam,
      conversationId,
      this.options.nowMs()
    );
  }

  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    clearPendingCrossTeamReplyExpectationInState(
      this.pendingCrossTeamFirstReplies,
      teamName,
      otherTeam,
      conversationId
    );
  }

  getPendingCrossTeamReplyExpectationKeys(teamName: string): Set<string> {
    return getPendingCrossTeamReplyExpectationKeysFromState(
      this.pendingCrossTeamFirstReplies,
      teamName,
      this.options.nowMs()
    );
  }

  getRunLeadName(run: TRun): string {
    return resolveCrossTeamLeadName(run.request?.members);
  }

  async matchCrossTeamLeadInboxMessages(
    teamName: string,
    leadName: string,
    deliveredBlocks: CrossTeamDeliveredLeadBlock[]
  ): Promise<CrossTeamLeadInboxMatch[]> {
    return readAndMatchCrossTeamLeadInboxMessages({
      inboxReader: {
        getMessagesFor: (teamName, memberName) => this.host.readInboxMessages(teamName, memberName),
      },
      teamName,
      leadName,
      deliveredBlocks,
    });
  }

  handleNativeTeammateUserMessage(run: TRun, msg: Record<string, unknown>): void {
    handleNativeTeammateUserMessageHelper(run, msg, {
      recentCrossTeamLeadDeliveryMessageIds: this.recentCrossTeamLeadDeliveryMessageIds,
      nowMs: this.options.nowMs,
      nowIso: this.options.nowIso,
      getRunLeadName: (run) => this.getRunLeadName(run),
      handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
        this.host.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
      matchCrossTeamLeadInboxMessages: (teamName, leadName, deliveredBlocks) =>
        this.matchCrossTeamLeadInboxMessages(teamName, leadName, deliveredBlocks),
      markInboxMessagesRead: (teamName, leadName, messages) =>
        this.host.markInboxMessagesRead(teamName, leadName, messages),
      setMemberSpawnStatus: (run, memberName, status, error, source) =>
        this.host.setMemberSpawnStatus(run, memberName, status, error, source),
      rememberSameTeamNativeFingerprints: (teamName, blocks) =>
        this.rememberSameTeamNativeFingerprints(teamName, blocks),
      reconcileSameTeamNativeDeliveries: (teamName, leadName) =>
        this.reconcileSameTeamNativeDeliveries(teamName, leadName),
    });
  }

  rememberSameTeamNativeFingerprints(teamName: string, blocks: ParsedTeammateContent[]): void {
    this.sameTeamNativeDelivery.rememberSameTeamNativeFingerprints(teamName, blocks);
  }

  async confirmSameTeamNativeMatches(
    teamName: string,
    leadName: string,
    messages: InboxMessage[]
  ): Promise<{ nativeMatchedMessageIds: Set<string>; persisted: boolean }> {
    return this.sameTeamNativeDelivery.confirmSameTeamNativeMatches(teamName, leadName, messages);
  }

  async reconcileSameTeamNativeDeliveries(teamName: string, leadName: string): Promise<void> {
    await this.sameTeamNativeDelivery.reconcileSameTeamNativeDeliveries(teamName, leadName);
  }

  scheduleSameTeamDeferredRetry(teamName: string): void {
    this.sameTeamNativeDelivery.scheduleSameTeamDeferredRetry(teamName);
  }

  scheduleSameTeamPersistRetry(teamName: string): void {
    this.sameTeamNativeDelivery.scheduleSameTeamPersistRetry(teamName);
  }

  getMemberRelayKey(teamName: string, memberName: string): string {
    return this.host.getMemberRelayKey(teamName, memberName);
  }

  getOpenCodeMemberRelayKey(teamName: string, memberName: string): string {
    return this.host.getOpenCodeMemberRelayKey(teamName, memberName);
  }

  async forwardUserDmToTeammate(
    teamName: string,
    teammateName: string,
    userText: string,
    userSummary?: string
  ): Promise<void> {
    await forwardUserDmToTeammateWithPorts(
      { teamName, teammateName, userText, userSummary },
      {
        getAliveRunId: (teamName) => this.host.getAliveRunId(teamName),
        getRun: (runId) => this.host.getRun(runId),
        sendMessageToRun: (run, message) => this.host.sendMessageToRun(run, message),
        nowIso: this.options.nowIso,
      }
    );
  }

  async relayMemberInboxMessages(teamName: string, memberName: string): Promise<number> {
    if (isCrossTeamPseudoRecipientName(memberName) || isCrossTeamToolRecipientName(memberName)) {
      return 0;
    }
    const relayKey = this.getMemberRelayKey(teamName, memberName);
    return relayMemberInboxMessagesWithPorts(
      { teamName, memberName, relayKey },
      {
        inFlight: this.memberInboxRelayInFlight,
        getAliveRunId: (teamName) => this.host.getAliveRunId(teamName),
        getRun: (runId) => this.host.getRun(runId),
        isCurrentTrackedRun: (run) => this.host.isCurrentTrackedRun(run),
        readInboxMessages: (teamName, memberName) =>
          this.host.readInboxMessages(teamName, memberName),
        markInboxMessagesRead: (teamName, memberName, messages) =>
          this.host.markInboxMessagesRead(teamName, memberName, messages),
        sendMessageToRun: (run, message) => this.host.sendMessageToRun(run, message),
        hasAcceptedMemberWorkSyncReport: (input) =>
          this.host.hasAcceptedMemberWorkSyncReport(input),
        relayedMemberInboxMessageIds: this.relayedMemberInboxMessageIds,
        trimRelayedSet: (relayedIds) => this.host.trimRelayedSet(relayedIds),
        logger: this.options.logger,
        nowIso: this.options.nowIso,
        getErrorMessage: this.options.getErrorMessage,
      }
    );
  }

  async relayInboxFileToLiveRecipient(
    teamName: string,
    inboxName: string,
    options: OpenCodeMemberInboxRelayOptions = {}
  ): Promise<LiveInboxRelayResult> {
    return relayInboxFileToLiveRecipientWithPorts(
      { teamName, inboxName, options },
      {
        readConfigSnapshot: (teamName) => this.host.readConfigSnapshot(teamName),
        readMetaMembers: (teamName) => this.host.readMetaMembers(teamName),
        isOpenCodeRuntimeRecipientFromSources: ({ memberName, config, metaMembers }) =>
          isOpenCodeRuntimeRecipientFromSources({ memberName, config, metaMembers }),
        relayOpenCodeMemberInboxMessages: (teamName, memberName, relayOptions) =>
          this.relayOpenCodeMemberInboxMessages(teamName, memberName, relayOptions),
        relayLeadInboxMessages: (teamName, leadOptions) =>
          this.relayLeadInboxMessages(teamName, leadOptions),
        isTeamAlive: (teamName) => this.host.isTeamAlive(teamName),
      }
    );
  }

  async relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: OpenCodeMemberInboxRelayOptions = {}
  ): Promise<OpenCodeMemberInboxRelayResult> {
    return this.host.relayOpenCodeMemberInboxMessages(teamName, memberName, options);
  }

  async relayLeadInboxMessages(teamName: string, options?: LeadInboxRelayOptions): Promise<number> {
    return this.leadInboxRelayBoundary.relayLeadInboxMessages(teamName, options);
  }
}
