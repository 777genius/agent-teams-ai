import {
  isInboxRelayInFlightTimeoutError,
  waitForInboxRelayInFlight,
} from './TeamProvisioningInboxRelayCandidates';
import {
  type LeadInboxRelayFlowPorts,
  type LeadInboxRelayFlowRun,
  relayLeadInboxMessagesForTeam,
} from './TeamProvisioningLeadInboxRelayFlow';

export interface TeamProvisioningLeadInboxRelayPortsFactoryLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export type TeamProvisioningLeadInboxRelayFlowRunner<
  TRun extends LeadInboxRelayFlowRun,
> = (teamName: string, ports: LeadInboxRelayFlowPorts<TRun>) => Promise<number>;

export type TeamProvisioningLeadInboxRelayInFlightWaiter = <T>(input: {
  promise: Promise<T>;
  relayName: string;
  relayKey: string;
  timeoutMs?: number;
}) => Promise<T>;

export interface TeamProvisioningLeadInboxRelayPortsFactoryDeps<
  TRun extends LeadInboxRelayFlowRun,
> extends Omit<LeadInboxRelayFlowPorts<TRun>, 'logger'> {
  leadInboxRelayInFlight: Map<string, Promise<number>>;
  logger: TeamProvisioningLeadInboxRelayPortsFactoryLogger;
  getErrorMessage(error: unknown): string;
  relayLeadInboxMessagesForTeam?: TeamProvisioningLeadInboxRelayFlowRunner<TRun>;
  waitForInboxRelayInFlight?: TeamProvisioningLeadInboxRelayInFlightWaiter;
}

export interface TeamProvisioningLeadInboxRelayPortsBoundary {
  relayLeadInboxMessages(teamName: string): Promise<number>;
}

export function createTeamProvisioningLeadInboxRelayFlowPorts<
  TRun extends LeadInboxRelayFlowRun,
>(
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
    sameTeamRunStartSkewMs: deps.sameTeamRunStartSkewMs,
    sameTeamNativeDeliveryGraceMs: deps.sameTeamNativeDeliveryGraceMs,
    recentCrossTeamDeliveryTtlMs: deps.recentCrossTeamDeliveryTtlMs,
    logger: deps.logger,
    nowIso: deps.nowIso,
    nowMs: deps.nowMs,
    setTimeout: (callback, ms) => deps.setTimeout(callback, ms),
    clearTimeout: (handle) => deps.clearTimeout(handle),
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
    async relayLeadInboxMessages(teamName: string): Promise<number> {
      const existing = deps.leadInboxRelayInFlight.get(teamName);
      if (existing) {
        try {
          return await waitForInFlight({
            promise: existing,
            relayName: 'lead_inbox_relay',
            relayKey: teamName,
          });
        } catch (error) {
          if (!isInboxRelayInFlightTimeoutError(error)) {
            throw error;
          }
          deps.logger.warn(`[${teamName}] lead_inbox_relay_timed_out: ${deps.getErrorMessage(error)}`);
          return 0;
        } finally {
          if (deps.leadInboxRelayInFlight.get(teamName) === existing) {
            deps.leadInboxRelayInFlight.delete(teamName);
          }
        }
      }

      const work = runRelay(teamName, createTeamProvisioningLeadInboxRelayFlowPorts(deps));

      deps.leadInboxRelayInFlight.set(teamName, work);
      try {
        return await waitForInFlight({
          promise: work,
          relayName: 'lead_inbox_relay',
          relayKey: teamName,
        });
      } catch (error) {
        if (!isInboxRelayInFlightTimeoutError(error)) {
          throw error;
        }
        deps.logger.warn(`[${teamName}] lead_inbox_relay_timed_out: ${deps.getErrorMessage(error)}`);
        return 0;
      } finally {
        if (deps.leadInboxRelayInFlight.get(teamName) === work) {
          deps.leadInboxRelayInFlight.delete(teamName);
        }
      }
    },
  };
}
