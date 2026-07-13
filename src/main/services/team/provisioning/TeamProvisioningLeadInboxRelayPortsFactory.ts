import {
  isInboxRelayInFlightTimeoutError,
  waitForInboxRelayInFlight,
} from './TeamProvisioningInboxRelayCandidates';
import {
  type LeadInboxRelayFlowPorts,
  type LeadInboxRelayFlowRun,
  type LeadInboxRelayOptions,
  relayLeadInboxMessagesForTeam,
} from './TeamProvisioningLeadInboxRelayFlow';

export interface TeamProvisioningLeadInboxRelayPortsFactoryLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export type TeamProvisioningLeadInboxRelayFlowRunner<TRun extends LeadInboxRelayFlowRun> = (
  teamName: string,
  ports: LeadInboxRelayFlowPorts<TRun>,
  options?: LeadInboxRelayOptions
) => Promise<number>;

export type TeamProvisioningLeadInboxRelayInFlightWaiter = <T>(input: {
  promise: Promise<T>;
  relayName: string;
  relayKey: string;
  timeoutMs?: number;
}) => Promise<T>;

const DEFAULT_SAME_TEAM_RUN_START_SKEW_MS = 1_000;
const DEFAULT_SAME_TEAM_NATIVE_DELIVERY_GRACE_MS = 15_000;
const DEFAULT_RECENT_CROSS_TEAM_DELIVERY_TTL_MS = 10 * 60 * 1000;

type LeadInboxRelayTimingKeys =
  | 'sameTeamRunStartSkewMs'
  | 'sameTeamNativeDeliveryGraceMs'
  | 'recentCrossTeamDeliveryTtlMs';

export interface TeamProvisioningLeadInboxRelayPortsFactoryDeps<
  TRun extends LeadInboxRelayFlowRun,
> extends Omit<LeadInboxRelayFlowPorts<TRun>, 'logger' | LeadInboxRelayTimingKeys> {
  leadInboxRelayInFlight: Map<string, Promise<number>>;
  logger: TeamProvisioningLeadInboxRelayPortsFactoryLogger;
  getErrorMessage(error: unknown): string;
  relayLeadInboxMessagesForTeam?: TeamProvisioningLeadInboxRelayFlowRunner<TRun>;
  waitForInboxRelayInFlight?: TeamProvisioningLeadInboxRelayInFlightWaiter;
  sameTeamRunStartSkewMs?: number;
  sameTeamNativeDeliveryGraceMs?: number;
  recentCrossTeamDeliveryTtlMs?: number;
}

export interface TeamProvisioningLeadInboxRelayPortsBoundary {
  relayLeadInboxMessages(teamName: string, options?: LeadInboxRelayOptions): Promise<number>;
}

const leadInboxRelayScopes = new WeakMap<Promise<number>, string | null>();

export interface TeamProvisioningLeadInboxRelayServiceHost<TRun extends LeadInboxRelayFlowRun> {
  leadInboxRelayInFlight: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['leadInboxRelayInFlight'];
  runTracking: Pick<
    TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>,
    'getAliveRunId' | 'getProvisioningRunId'
  >;
  runs: {
    get(runId: string): TRun | undefined;
  };
  isCurrentTrackedRun: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['isCurrentTrackedRun'];
  readConfigSnapshot: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['readConfigForObservation'];
  inboxReader: {
    getMessagesFor: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['readLeadInboxMessages'];
  };
  markInboxMessagesRead: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['markInboxMessagesRead'];
  handleTeammatePermissionRequest: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['handleTeammatePermissionRequest'];
  refreshMemberSpawnStatusesFromLeadInbox: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['refreshMemberSpawnStatusesFromLeadInbox'];
  confirmSameTeamNativeMatches: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['confirmSameTeamNativeMatches'];
  scheduleSameTeamPersistRetry: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['scheduleSameTeamPersistRetry'];
  scheduleSameTeamDeferredRetry: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['scheduleSameTeamDeferredRetry'];
  providerRuntime: {
    resolveControlApiBaseUrl: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['resolveControlApiBaseUrl'];
  };
  sendMessageToRun: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['sendMessageToRun'];
  hasAcceptedLeadWorkSyncReport: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['hasAcceptedLeadWorkSyncReport'];
  scheduleLeadProofMissingWorkSyncRecovery: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['scheduleLeadProofMissingWorkSyncRecovery'];
  pushLiveLeadTextMessage: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['pushLiveLeadTextMessage'];
  pushLiveLeadProcessMessage: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['pushLiveLeadProcessMessage'];
  persistSentMessage: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['persistSentMessage'];
  teamChangeEmitter?: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['emitTeamChange'];
  scheduleLeadInboxFollowUpRelay: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['scheduleLeadInboxFollowUpRelay'];
  relayedLeadInboxMessageIds: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['relayedLeadInboxMessageIds'];
  trimRelayedSet: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['trimRelayedSet'];
  pendingCrossTeamFirstReplies: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['pendingCrossTeamFirstReplies'];
  recentCrossTeamLeadDeliveryMessageIds: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['recentCrossTeamLeadDeliveryMessageIds'];
}

export interface TeamProvisioningLeadInboxRelayServiceHostOptions<
  TRun extends LeadInboxRelayFlowRun,
> {
  logger: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['logger'];
  getErrorMessage: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['getErrorMessage'];
  nowIso: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['nowIso'];
  nowMs: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['nowMs'];
  setTimeout: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['setTimeout'];
  clearTimeout: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['clearTimeout'];
  relayLeadInboxMessagesForTeam?: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['relayLeadInboxMessagesForTeam'];
  waitForInboxRelayInFlight?: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>['waitForInboxRelayInFlight'];
}

export function createTeamProvisioningLeadInboxRelayFlowPorts<TRun extends LeadInboxRelayFlowRun>(
  deps: Omit<
    TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>,
    | 'getErrorMessage'
    | 'leadInboxRelayInFlight'
    | 'relayLeadInboxMessagesForTeam'
    | 'waitForInboxRelayInFlight'
  >
): LeadInboxRelayFlowPorts<TRun> {
  return {
    getAliveRunId: (teamName) => deps.getAliveRunId(teamName),
    getProvisioningRunId: (teamName) => deps.getProvisioningRunId(teamName),
    getRun: (runId) => deps.getRun(runId),
    isCurrentTrackedRun: (run) => deps.isCurrentTrackedRun(run),
    readConfigForObservation: (teamName) => deps.readConfigForObservation(teamName),
    readLeadInboxMessages: (teamName, leadName) => deps.readLeadInboxMessages(teamName, leadName),
    markInboxMessagesRead: (teamName, leadName, messages) =>
      deps.markInboxMessagesRead(teamName, leadName, messages),
    handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
      deps.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
    refreshMemberSpawnStatusesFromLeadInbox: (run) =>
      deps.refreshMemberSpawnStatusesFromLeadInbox(run),
    confirmSameTeamNativeMatches: (teamName, leadName, messages) =>
      deps.confirmSameTeamNativeMatches(teamName, leadName, messages),
    scheduleSameTeamPersistRetry: (teamName) => deps.scheduleSameTeamPersistRetry(teamName),
    scheduleSameTeamDeferredRetry: (teamName) => deps.scheduleSameTeamDeferredRetry(teamName),
    resolveControlApiBaseUrl: () => deps.resolveControlApiBaseUrl(),
    sendMessageToRun: (run, message) => deps.sendMessageToRun(run, message),
    hasAcceptedLeadWorkSyncReport: (input) => deps.hasAcceptedLeadWorkSyncReport(input),
    scheduleLeadProofMissingWorkSyncRecovery: (input) =>
      deps.scheduleLeadProofMissingWorkSyncRecovery(input),
    pushLiveLeadTextMessage: (run, text, messageId, timestamp) =>
      deps.pushLiveLeadTextMessage(run, text, messageId, timestamp),
    pushLiveLeadProcessMessage: (teamName, message) =>
      deps.pushLiveLeadProcessMessage(teamName, message),
    persistSentMessage: (teamName, message) => deps.persistSentMessage(teamName, message),
    emitTeamChange: (event) => deps.emitTeamChange(event),
    scheduleLeadInboxFollowUpRelay: (teamName) => deps.scheduleLeadInboxFollowUpRelay(teamName),
    relayedLeadInboxMessageIds: deps.relayedLeadInboxMessageIds,
    trimRelayedSet: (relayedIds) => deps.trimRelayedSet(relayedIds),
    pendingCrossTeamFirstReplies: deps.pendingCrossTeamFirstReplies,
    recentCrossTeamLeadDeliveryMessageIds: deps.recentCrossTeamLeadDeliveryMessageIds,
    sameTeamRunStartSkewMs: deps.sameTeamRunStartSkewMs ?? DEFAULT_SAME_TEAM_RUN_START_SKEW_MS,
    sameTeamNativeDeliveryGraceMs:
      deps.sameTeamNativeDeliveryGraceMs ?? DEFAULT_SAME_TEAM_NATIVE_DELIVERY_GRACE_MS,
    recentCrossTeamDeliveryTtlMs:
      deps.recentCrossTeamDeliveryTtlMs ?? DEFAULT_RECENT_CROSS_TEAM_DELIVERY_TTL_MS,
    logger: deps.logger,
    nowIso: deps.nowIso,
    nowMs: deps.nowMs,
    setTimeout: (callback, ms) => deps.setTimeout(callback, ms),
    clearTimeout: (handle) => deps.clearTimeout(handle),
  };
}

export function createTeamProvisioningLeadInboxRelayPortsDepsFromService<
  TRun extends LeadInboxRelayFlowRun,
>(
  service: TeamProvisioningLeadInboxRelayServiceHost<TRun>,
  options: TeamProvisioningLeadInboxRelayServiceHostOptions<TRun>
): TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun> {
  return {
    leadInboxRelayInFlight: service.leadInboxRelayInFlight,
    getAliveRunId: (teamName) => service.runTracking.getAliveRunId(teamName),
    getProvisioningRunId: (teamName) => service.runTracking.getProvisioningRunId(teamName),
    getRun: (runId) => service.runs.get(runId),
    isCurrentTrackedRun: (run) => service.isCurrentTrackedRun(run),
    readConfigForObservation: (teamName) => service.readConfigSnapshot(teamName),
    readLeadInboxMessages: (teamName, leadName) =>
      service.inboxReader.getMessagesFor(teamName, leadName),
    markInboxMessagesRead: (teamName, leadName, messages) =>
      service.markInboxMessagesRead(teamName, leadName, messages),
    handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
      service.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
    refreshMemberSpawnStatusesFromLeadInbox: (run) =>
      service.refreshMemberSpawnStatusesFromLeadInbox(run),
    confirmSameTeamNativeMatches: (teamName, leadName, messages) =>
      service.confirmSameTeamNativeMatches(teamName, leadName, messages),
    scheduleSameTeamPersistRetry: (teamName) => service.scheduleSameTeamPersistRetry(teamName),
    scheduleSameTeamDeferredRetry: (teamName) => service.scheduleSameTeamDeferredRetry(teamName),
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
    scheduleLeadInboxFollowUpRelay: (teamName) => service.scheduleLeadInboxFollowUpRelay(teamName),
    relayedLeadInboxMessageIds: service.relayedLeadInboxMessageIds,
    trimRelayedSet: (relayedIds) => service.trimRelayedSet(relayedIds),
    pendingCrossTeamFirstReplies: service.pendingCrossTeamFirstReplies,
    recentCrossTeamLeadDeliveryMessageIds: service.recentCrossTeamLeadDeliveryMessageIds,
    logger: options.logger,
    getErrorMessage: options.getErrorMessage,
    nowIso: options.nowIso,
    nowMs: options.nowMs,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    relayLeadInboxMessagesForTeam: options.relayLeadInboxMessagesForTeam,
    waitForInboxRelayInFlight: options.waitForInboxRelayInFlight,
  };
}

export function createTeamProvisioningLeadInboxRelayPortsBoundary<
  TRun extends LeadInboxRelayFlowRun,
>(
  deps: TeamProvisioningLeadInboxRelayPortsFactoryDeps<TRun>
): TeamProvisioningLeadInboxRelayPortsBoundary {
  const runRelay = deps.relayLeadInboxMessagesForTeam ?? relayLeadInboxMessagesForTeam;
  const waitForInFlight = deps.waitForInboxRelayInFlight ?? waitForInboxRelayInFlight;

  return {
    async relayLeadInboxMessages(
      teamName: string,
      options?: LeadInboxRelayOptions
    ): Promise<number> {
      const onlyMessageId = options?.onlyMessageId?.trim() || null;
      const relayKey = teamName;
      const existing = deps.leadInboxRelayInFlight.get(relayKey);
      const canShareExisting =
        existing &&
        (!leadInboxRelayScopes.has(existing) ||
          leadInboxRelayScopes.get(existing) === onlyMessageId);
      if (existing && canShareExisting) {
        try {
          return await waitForInFlight({
            promise: existing,
            relayName: 'lead_inbox_relay',
            relayKey,
          });
        } catch (error) {
          if (!isInboxRelayInFlightTimeoutError(error)) {
            throw error;
          }
          deps.logger.warn(
            `[${teamName}] lead_inbox_relay_timed_out: ${deps.getErrorMessage(error)}`
          );
          return 0;
        } finally {
          if (deps.leadInboxRelayInFlight.get(relayKey) === existing) {
            deps.leadInboxRelayInFlight.delete(relayKey);
          }
        }
      }

      const ports = createTeamProvisioningLeadInboxRelayFlowPorts(deps);
      const runCurrentRelay = (): Promise<number> =>
        options ? runRelay(teamName, ports, options) : runRelay(teamName, ports);
      const work = existing ? existing.then(runCurrentRelay, runCurrentRelay) : runCurrentRelay();

      leadInboxRelayScopes.set(work, onlyMessageId);
      deps.leadInboxRelayInFlight.set(relayKey, work);
      try {
        return await waitForInFlight({
          promise: work,
          relayName: 'lead_inbox_relay',
          relayKey,
        });
      } catch (error) {
        if (!isInboxRelayInFlightTimeoutError(error)) {
          throw error;
        }
        deps.logger.warn(
          `[${teamName}] lead_inbox_relay_timed_out: ${deps.getErrorMessage(error)}`
        );
        return 0;
      } finally {
        if (deps.leadInboxRelayInFlight.get(relayKey) === work) {
          deps.leadInboxRelayInFlight.delete(relayKey);
        }
      }
    },
  };
}
