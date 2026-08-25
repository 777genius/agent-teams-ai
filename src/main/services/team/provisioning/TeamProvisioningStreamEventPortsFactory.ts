import { killProcessTree } from '@main/utils/childProcess';

import { boundProgressAssistantParts } from '../progressPayload';

import {
  type LeadContextUsageRunLike,
  updateLeadContextUsageFromUsageForRun,
} from './TeamProvisioningLeadContextUsage';
import {
  hasApiError,
  isAuthFailureWarning,
  isQuotaRetryMessage,
  normalizeApiRetryErrorMessage,
  toMarkdownCodeSafe,
} from './TeamProvisioningOutputErrorPolicy';
import {
  appendProvisioningTrace,
  boundRunProvisioningOutputParts,
  buildProvisioningLiveOutput,
  type TeamProvisioningTraceRun,
} from './TeamProvisioningProgressBuffers';
import { extractCliLogsFromRun, type RetainedLogsRunLike } from './TeamProvisioningRetainedLogs';

import type {
  TeamProvisioningStreamEventPorts,
  TeamProvisioningStreamRun,
} from './TeamProvisioningStreamEvents';
import type { ChildProcess } from 'child_process';

function killTeamProcess(child: ChildProcess | null | undefined): void {
  killProcessTree(child, 'SIGKILL');
}

export type TeamProvisioningStreamEventPortsFactoryRun = TeamProvisioningStreamRun &
  TeamProvisioningTraceRun &
  RetainedLogsRunLike &
  LeadContextUsageRunLike;

interface RuntimeFailureObservation {
  phase: 'sdk_retrying' | 'terminal';
  detail: string;
  observedAt: string;
  statusCode?: number;
  retryAfterMs?: number;
  causedByRecoveryMessageId?: string;
}

export type TeamProvisioningRuntimeFailureAwareStreamEventPorts<
  TRun extends TeamProvisioningStreamEventPortsFactoryRun,
> = TeamProvisioningStreamEventPorts<TRun> & {
  observeRuntimeFailure(run: TRun, failure: RuntimeFailureObservation): void;
};

export interface TeamProvisioningStreamEventPortCallbacks<
  TRun extends TeamProvisioningStreamEventPortsFactoryRun,
> {
  updateProgress: TeamProvisioningStreamEventPorts<TRun>['updateProgress'];
  resetLiveLeadTextBuffer: TeamProvisioningStreamEventPorts<TRun>['resetLiveLeadTextBuffer'];
  handleTeammatePermissionRequest: TeamProvisioningStreamEventPorts<TRun>['handleTeammatePermissionRequest'];
  finishRuntimeToolActivity: TeamProvisioningStreamEventPorts<TRun>['finishRuntimeToolActivity'];
  handleNativeTeammateUserMessage: TeamProvisioningStreamEventPorts<TRun>['handleNativeTeammateUserMessage'];
  handleAuthFailureInOutput: TeamProvisioningStreamEventPorts<TRun>['handleAuthFailureInOutput'];
  failProvisioningWithApiError: TeamProvisioningStreamEventPorts<TRun>['failProvisioningWithApiError'];
  appendProvisioningAssistantText: TeamProvisioningStreamEventPorts<TRun>['appendProvisioningAssistantText'];
  pushLiveLeadTextMessage: TeamProvisioningStreamEventPorts<TRun>['pushLiveLeadTextMessage'];
  startRuntimeToolActivity: TeamProvisioningStreamEventPorts<TRun>['startRuntimeToolActivity'];
  getRunLeadName: TeamProvisioningStreamEventPorts<TRun>['getRunLeadName'];
  captureTeamSpawnEvents: TeamProvisioningStreamEventPorts<TRun>['captureTeamSpawnEvents'];
  captureSendMessages: TeamProvisioningStreamEventPorts<TRun>['captureSendMessages'];
  emitLeadContextUsage: TeamProvisioningStreamEventPorts<TRun>['emitLeadContextUsage'];
  resetRuntimeToolActivity: TeamProvisioningStreamEventPorts<TRun>['resetRuntimeToolActivity'];
  setLeadActivity: TeamProvisioningStreamEventPorts<TRun>['setLeadActivity'];
  emitTeamChange: TeamProvisioningStreamEventPorts<TRun>['emitTeamChange'];
  pushLiveLeadProcessMessage: TeamProvisioningStreamEventPorts<TRun>['pushLiveLeadProcessMessage'];
  injectPostCompactReminder: TeamProvisioningStreamEventPorts<TRun>['injectPostCompactReminder'];
  injectGeminiPostLaunchHydration: TeamProvisioningStreamEventPorts<TRun>['injectGeminiPostLaunchHydration'];
  completeProvisioningFromSuccessfulResult: TeamProvisioningStreamEventPorts<TRun>['completeProvisioningFromSuccessfulResult'];
  handleControlRequest: TeamProvisioningStreamEventPorts<TRun>['handleControlRequest'];
  handleProvisioningTurnComplete: TeamProvisioningStreamEventPorts<TRun>['handleProvisioningTurnComplete'];
  cleanupRun: TeamProvisioningStreamEventPorts<TRun>['cleanupRun'];
  emitApiErrorWarning: TeamProvisioningStreamEventPorts<TRun>['emitApiErrorWarning'];
  setMemberSpawnStatus: TeamProvisioningStreamEventPorts<TRun>['setMemberSpawnStatus'];
  appendMemberBootstrapDiagnostic: TeamProvisioningStreamEventPorts<TRun>['appendMemberBootstrapDiagnostic'];
  reevaluateMemberLaunchStatus: TeamProvisioningStreamEventPorts<TRun>['reevaluateMemberLaunchStatus'];
  invalidateRuntimeSnapshotCaches: TeamProvisioningStreamEventPorts<TRun>['invalidateRuntimeSnapshotCaches'];
  markUnconfirmedBootstrapMembersFailed: TeamProvisioningStreamEventPorts<TRun>['markUnconfirmedBootstrapMembersFailed'];
  stopPersistentTeamMembers: TeamProvisioningStreamEventPorts<TRun>['stopPersistentTeamMembers'];
  persistLaunchStateSnapshot: TeamProvisioningStreamEventPorts<TRun>['persistLaunchStateSnapshot'];
  observeRuntimeFailure: TeamProvisioningRuntimeFailureAwareStreamEventPorts<TRun>['observeRuntimeFailure'];
}

export type TeamProvisioningStreamEventOutputRecoveryAdapter<
  TRun extends TeamProvisioningStreamEventPortsFactoryRun,
> = Pick<
  TeamProvisioningStreamEventPorts<TRun>,
  'handleAuthFailureInOutput' | 'failProvisioningWithApiError' | 'emitApiErrorWarning'
>;

type StreamEventServicePortKey =
  | 'resetLiveLeadTextBuffer'
  | 'handleTeammatePermissionRequest'
  | 'finishRuntimeToolActivity'
  | 'handleNativeTeammateUserMessage'
  | 'appendProvisioningAssistantText'
  | 'pushLiveLeadTextMessage'
  | 'startRuntimeToolActivity'
  | 'getRunLeadName'
  | 'captureTeamSpawnEvents'
  | 'captureSendMessages'
  | 'emitLeadContextUsage'
  | 'resetRuntimeToolActivity'
  | 'setLeadActivity'
  | 'pushLiveLeadProcessMessage'
  | 'injectPostCompactReminder'
  | 'injectGeminiPostLaunchHydration'
  | 'completeProvisioningFromSuccessfulResult'
  | 'handleControlRequest'
  | 'handleProvisioningTurnComplete'
  | 'cleanupRun'
  | 'setMemberSpawnStatus'
  | 'appendMemberBootstrapDiagnostic'
  | 'reevaluateMemberLaunchStatus'
  | 'invalidateRuntimeSnapshotCaches'
  | 'markUnconfirmedBootstrapMembersFailed'
  | 'persistLaunchStateSnapshot';

export type TeamProvisioningStreamEventServiceAdapter<
  TRun extends TeamProvisioningStreamEventPortsFactoryRun,
> = Pick<TeamProvisioningStreamEventPorts<TRun>, StreamEventServicePortKey> &
  Pick<TeamProvisioningRuntimeFailureAwareStreamEventPorts<TRun>, 'observeRuntimeFailure'>;

export type TeamProvisioningStreamEventPersistentRuntimeCleanupAdapter<
  TRun extends TeamProvisioningStreamEventPortsFactoryRun,
> = Pick<TeamProvisioningStreamEventPorts<TRun>, 'stopPersistentTeamMembers'>;

export interface TeamProvisioningStreamEventPortsBoundaryDeps<
  TRun extends TeamProvisioningStreamEventPortsFactoryRun,
> {
  service: TeamProvisioningStreamEventServiceAdapter<TRun>;
  persistentRuntimeCleanup: TeamProvisioningStreamEventPersistentRuntimeCleanupAdapter<TRun>;
  outputRecovery: TeamProvisioningStreamEventOutputRecoveryAdapter<TRun>;
  updateProgress: TeamProvisioningStreamEventPorts<TRun>['updateProgress'];
  emitTeamChange?: TeamProvisioningStreamEventPorts<TRun>['emitTeamChange'];
}

export function createTeamProvisioningStreamEventPortsBoundary<
  TRun extends TeamProvisioningStreamEventPortsFactoryRun,
>(
  deps: TeamProvisioningStreamEventPortsBoundaryDeps<TRun>
): TeamProvisioningRuntimeFailureAwareStreamEventPorts<TRun> {
  return createTeamProvisioningStreamEventPorts({
    updateProgress: (run, state, message, extras) =>
      deps.updateProgress(run, state, message, extras),
    resetLiveLeadTextBuffer: (run) => deps.service.resetLiveLeadTextBuffer(run),
    handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
      deps.service.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
    finishRuntimeToolActivity: (run, toolUseId, resultContent, isError) =>
      deps.service.finishRuntimeToolActivity(run, toolUseId, resultContent, isError),
    handleNativeTeammateUserMessage: (run, msg) =>
      deps.service.handleNativeTeammateUserMessage(run, msg),
    handleAuthFailureInOutput: (run, text, source) =>
      deps.outputRecovery.handleAuthFailureInOutput(run, text, source),
    failProvisioningWithApiError: (run, text) =>
      deps.outputRecovery.failProvisioningWithApiError(run, text),
    appendProvisioningAssistantText: (run, msg, text) =>
      deps.service.appendProvisioningAssistantText(run, msg, text),
    pushLiveLeadTextMessage: (run, text, messageId, timestamp, options) =>
      deps.service.pushLiveLeadTextMessage(run, text, messageId, timestamp, options),
    startRuntimeToolActivity: (run, memberName, block) =>
      deps.service.startRuntimeToolActivity(run, memberName, block),
    getRunLeadName: (run) => deps.service.getRunLeadName(run),
    captureTeamSpawnEvents: (run, content) => deps.service.captureTeamSpawnEvents(run, content),
    captureSendMessages: (run, content) => deps.service.captureSendMessages(run, content),
    emitLeadContextUsage: (run) => deps.service.emitLeadContextUsage(run),
    resetRuntimeToolActivity: (run, memberName) =>
      deps.service.resetRuntimeToolActivity(run, memberName),
    setLeadActivity: (run, state) => deps.service.setLeadActivity(run, state),
    emitTeamChange: (event) => deps.emitTeamChange?.(event),
    pushLiveLeadProcessMessage: (teamName, message) =>
      deps.service.pushLiveLeadProcessMessage(teamName, message),
    injectPostCompactReminder: (run) => deps.service.injectPostCompactReminder(run),
    injectGeminiPostLaunchHydration: (run) => deps.service.injectGeminiPostLaunchHydration(run),
    completeProvisioningFromSuccessfulResult: (run) =>
      deps.service.completeProvisioningFromSuccessfulResult(run),
    handleControlRequest: (run, msg) => deps.service.handleControlRequest(run, msg),
    handleProvisioningTurnComplete: (run) => deps.service.handleProvisioningTurnComplete(run),
    cleanupRun: (run) => deps.service.cleanupRun(run),
    emitApiErrorWarning: (run, text) => deps.outputRecovery.emitApiErrorWarning(run, text),
    setMemberSpawnStatus: (run, memberName, status, error) =>
      deps.service.setMemberSpawnStatus(run, memberName, status, error),
    appendMemberBootstrapDiagnostic: (run, memberName, detail) =>
      deps.service.appendMemberBootstrapDiagnostic(run, memberName, detail),
    reevaluateMemberLaunchStatus: (run, memberName) =>
      deps.service.reevaluateMemberLaunchStatus(run, memberName),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      deps.service.invalidateRuntimeSnapshotCaches(teamName),
    markUnconfirmedBootstrapMembersFailed: (run, reason, options) =>
      deps.service.markUnconfirmedBootstrapMembersFailed(run, reason, options),
    stopPersistentTeamMembers: (teamName) =>
      deps.persistentRuntimeCleanup.stopPersistentTeamMembers(teamName),
    persistLaunchStateSnapshot: (run, phase) => deps.service.persistLaunchStateSnapshot(run, phase),
    observeRuntimeFailure: (run, failure) => deps.service.observeRuntimeFailure(run, failure),
  });
}

export function createTeamProvisioningStreamEventPorts<
  TRun extends TeamProvisioningStreamEventPortsFactoryRun,
>(
  callbacks: TeamProvisioningStreamEventPortCallbacks<TRun>
): TeamProvisioningRuntimeFailureAwareStreamEventPorts<TRun> {
  return {
    updateProgress: callbacks.updateProgress,
    extractCliLogsFromRun,
    buildProvisioningLiveOutput,
    boundRunProvisioningOutputParts,
    boundProgressAssistantParts,
    appendProvisioningTrace,
    resetLiveLeadTextBuffer: callbacks.resetLiveLeadTextBuffer,
    handleTeammatePermissionRequest: callbacks.handleTeammatePermissionRequest,
    finishRuntimeToolActivity: callbacks.finishRuntimeToolActivity,
    handleNativeTeammateUserMessage: callbacks.handleNativeTeammateUserMessage,
    handleAuthFailureInOutput: callbacks.handleAuthFailureInOutput,
    hasApiError,
    isAuthFailureWarning,
    failProvisioningWithApiError: callbacks.failProvisioningWithApiError,
    appendProvisioningAssistantText: callbacks.appendProvisioningAssistantText,
    pushLiveLeadTextMessage: callbacks.pushLiveLeadTextMessage,
    startRuntimeToolActivity: callbacks.startRuntimeToolActivity,
    getRunLeadName: callbacks.getRunLeadName,
    captureTeamSpawnEvents: callbacks.captureTeamSpawnEvents,
    captureSendMessages: callbacks.captureSendMessages,
    updateLeadContextUsageFromUsage: updateLeadContextUsageFromUsageForRun,
    emitLeadContextUsage: callbacks.emitLeadContextUsage,
    resetRuntimeToolActivity: callbacks.resetRuntimeToolActivity,
    setLeadActivity: callbacks.setLeadActivity,
    emitTeamChange: callbacks.emitTeamChange,
    pushLiveLeadProcessMessage: callbacks.pushLiveLeadProcessMessage,
    injectPostCompactReminder: callbacks.injectPostCompactReminder,
    injectGeminiPostLaunchHydration: callbacks.injectGeminiPostLaunchHydration,
    completeProvisioningFromSuccessfulResult: callbacks.completeProvisioningFromSuccessfulResult,
    handleControlRequest: callbacks.handleControlRequest,
    handleProvisioningTurnComplete: callbacks.handleProvisioningTurnComplete,
    cleanupRun: callbacks.cleanupRun,
    killTeamProcess,
    normalizeApiRetryErrorMessage,
    isQuotaRetryMessage,
    toMarkdownCodeSafe,
    emitApiErrorWarning: callbacks.emitApiErrorWarning,
    setMemberSpawnStatus: callbacks.setMemberSpawnStatus,
    appendMemberBootstrapDiagnostic: callbacks.appendMemberBootstrapDiagnostic,
    reevaluateMemberLaunchStatus: callbacks.reevaluateMemberLaunchStatus,
    invalidateRuntimeSnapshotCaches: callbacks.invalidateRuntimeSnapshotCaches,
    markUnconfirmedBootstrapMembersFailed: callbacks.markUnconfirmedBootstrapMembersFailed,
    stopPersistentTeamMembers: callbacks.stopPersistentTeamMembers,
    persistLaunchStateSnapshot: callbacks.persistLaunchStateSnapshot,
    observeRuntimeFailure: callbacks.observeRuntimeFailure,
  };
}
