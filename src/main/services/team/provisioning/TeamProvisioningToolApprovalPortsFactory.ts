import { shouldAutoAllow } from '@main/utils/toolApprovalRules';

import {
  buildOpenCodeRuntimePermissionAnswerInput,
  buildOpenCodeRuntimePermissionLaunchInput,
} from '../approvals/OpenCodeRuntimeApprovalProvider';

import {
  autoAllowLeadControlRequest,
  autoDenyLeadControlRequest,
  createDefaultLeadToolApprovalPorts,
  handleLeadControlRequest,
  type TeamProvisioningLeadToolApprovalLogger,
  type TeamProvisioningLeadToolApprovalPorts,
  type TeamProvisioningLeadToolApprovalResponsePorts,
  type TeamProvisioningLeadToolApprovalRun,
} from './TeamProvisioningLeadToolApproval';
import {
  type OpenCodeRuntimePermissionAnswerRun,
  type OpenCodeRuntimeToolApprovalAnswerPorts,
} from './TeamProvisioningRuntimeToolApprovalAnswer';
import {
  handleTeammatePermissionRequest,
  type TeamProvisioningTeammatePermissionRequestLogger,
  type TeamProvisioningTeammatePermissionRequestPorts,
  type TeamProvisioningTeammatePermissionRequestRun,
} from './TeamProvisioningTeammatePermissionRequest';
import {
  respondToTeammatePermission,
  type RespondToTeammatePermissionInput,
  type TeamProvisioningTeammatePermissionResponseLogger,
  type TeamProvisioningTeammatePermissionResponsePorts,
} from './TeamProvisioningTeammatePermissionResponse';
import {
  buildLeadToolApprovalDecisionPayload,
  buildTeammateToolApprovalRequest,
  buildToolApprovalAutoResolvedEvent,
} from './TeamProvisioningToolApprovalFlow';
import {
  answerRuntimeToolApprovalResponse,
  respondToToolApprovalResponse,
  type TeamProvisioningRuntimeToolApprovalAnswerInput,
  type TeamProvisioningToolApprovalResponseInput,
  type TeamProvisioningToolApprovalResponsePorts,
  type TeamProvisioningToolApprovalResponseRun,
} from './TeamProvisioningToolApprovalResponse';

import type {
  ToolApprovalAutoResolved,
  ToolApprovalEvent,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';
import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';

export type TeamProvisioningToolApprovalPortsFactoryRun = TeamProvisioningLeadToolApprovalRun &
  TeamProvisioningTeammatePermissionRequestRun &
  TeamProvisioningToolApprovalResponseRun &
  OpenCodeRuntimePermissionAnswerRun;

export interface TeamProvisioningToolApprovalPortsFactoryDeps<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
> {
  logger: TeamProvisioningLeadToolApprovalLogger &
    TeamProvisioningTeammatePermissionRequestLogger &
    TeamProvisioningTeammatePermissionResponseLogger;
  getToolApprovalSettings(teamName: string): ToolApprovalSettings;
  emitToolApprovalEvent(event: ToolApprovalEvent | ToolApprovalAutoResolved): void;
  startApprovalTimeout(run: TRun, requestId: string): void;
  clearApprovalTimeout(requestId: string): void;
  tryClaimResponse(requestId: string): boolean;
  maybeShowToolApprovalOsNotification(run: TRun, approval: ToolApprovalRequest): void;
  dismissApprovalNotification(requestId: string): void;
  getTrackedRunId: TeamProvisioningLeadToolApprovalResponsePorts<TRun>['getTrackedRunId'];
  getRun: TeamProvisioningLeadToolApprovalResponsePorts<TRun>['getRun'];
  inFlightResponses: TeamProvisioningLeadToolApprovalResponsePorts<TRun>['inFlightResponses'];
  runtimeToolApprovalCoordinator: TeamProvisioningToolApprovalResponsePorts<TRun>['runtimeToolApprovalCoordinator'];
  getOpenCodeRuntimeAdapter: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['getOpenCodeRuntimeAdapter'];
  readLaunchState: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['readLaunchState'];
  persistOpenCodeRuntimeAdapterLaunchResult: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['persistOpenCodeRuntimeAdapterLaunchResult'];
  deleteRuntimeAdapterRunByTeam: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['deleteRuntimeAdapterRunByTeam'];
  setRuntimeAdapterRunByTeam: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['setRuntimeAdapterRunByTeam'];
  setAliveRunId: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['setAliveRunId'];
  guardCommittedOpenCodeSecondaryLaneEvidence: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['guardCommittedOpenCodeSecondaryLaneEvidence'];
  publishMixedSecondaryLaneStatusChange: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['publishMixedSecondaryLaneStatusChange'];
  syncOpenCodeRuntimeToolApprovals: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['syncOpenCodeRuntimeToolApprovals'];
  emitTeamChange: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>['emitTeamChange'] &
    TeamProvisioningTeammatePermissionResponsePorts['emitTeamChange'];
  readConfigForStrictDecision: TeamProvisioningTeammatePermissionResponsePorts['readConfigForStrictDecision'];
  addPermissionRulesToSettings: TeamProvisioningTeammatePermissionResponsePorts['addPermissionRulesToSettings'];
  persistInboxMessage: TeamProvisioningTeammatePermissionResponsePorts['persistInboxMessage'];
  nowIso: TeamProvisioningTeammatePermissionResponsePorts['nowIso'];
  nowMs: TeamProvisioningTeammatePermissionResponsePorts['nowMs'];
  joinPath: TeamProvisioningTeammatePermissionResponsePorts['joinPath'];
  teammateOperationalToolNames: TeamProvisioningTeammatePermissionResponsePorts['teammateOperationalToolNames'];
}

export interface TeamProvisioningToolApprovalPortsBoundary<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
> {
  handleControlRequest(run: TRun, msg: Record<string, unknown>): void;
  handleTeammatePermissionRequest(
    run: TRun,
    perm: ParsedPermissionRequest,
    messageTimestamp: string
  ): void;
  autoAllowControlRequest(run: TRun, requestId: string): void;
  autoDenyControlRequest(run: TRun, requestId: string): void;
  respondToTeammatePermission(input: RespondToTeammatePermissionInput): Promise<void>;
  answerRuntimeToolApproval(input: TeamProvisioningRuntimeToolApprovalAnswerInput): Promise<void>;
  respondToToolApproval(input: TeamProvisioningToolApprovalResponseInput): Promise<void>;
}

export function createTeamProvisioningLeadToolApprovalPortsFromDeps<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
>(
  deps: TeamProvisioningToolApprovalPortsFactoryDeps<TRun>
): TeamProvisioningLeadToolApprovalPorts<TRun> {
  return createDefaultLeadToolApprovalPorts<TRun>({
    logger: deps.logger,
    getSettings: (teamName) => deps.getToolApprovalSettings(teamName),
    emitToolApprovalEvent: (event) => deps.emitToolApprovalEvent(event),
    startApprovalTimeout: (run, requestId) => deps.startApprovalTimeout(run, requestId),
    maybeShowToolApprovalOsNotification: (run, approval) =>
      deps.maybeShowToolApprovalOsNotification(run, approval),
  });
}

export function createTeamProvisioningLeadToolApprovalResponsePortsFromDeps<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
>(
  deps: TeamProvisioningToolApprovalPortsFactoryDeps<TRun>
): TeamProvisioningLeadToolApprovalResponsePorts<TRun> {
  return {
    logger: deps.logger,
    getTrackedRunId: (teamName) => deps.getTrackedRunId(teamName),
    getRun: (runId) => deps.getRun(runId),
    clearApprovalTimeout: (requestId) => deps.clearApprovalTimeout(requestId),
    tryClaimResponse: (requestId) => deps.tryClaimResponse(requestId),
    inFlightResponses: deps.inFlightResponses,
    startApprovalTimeout: (run, requestId) => deps.startApprovalTimeout(run, requestId),
    dismissApprovalNotification: (requestId) => deps.dismissApprovalNotification(requestId),
    buildLeadToolApprovalDecisionPayload,
  };
}

export function createOpenCodeRuntimeToolApprovalAnswerPortsFromDeps<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
>(
  deps: TeamProvisioningToolApprovalPortsFactoryDeps<TRun>
): OpenCodeRuntimeToolApprovalAnswerPorts<TRun> {
  return {
    getOpenCodeRuntimeAdapter: () => deps.getOpenCodeRuntimeAdapter(),
    readLaunchState: (teamName) => deps.readLaunchState(teamName),
    buildOpenCodeRuntimePermissionAnswerInput,
    buildOpenCodeRuntimePermissionLaunchInput,
    persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
      deps.persistOpenCodeRuntimeAdapterLaunchResult(result, input),
    deleteRuntimeAdapterRunByTeam: (teamName) => deps.deleteRuntimeAdapterRunByTeam(teamName),
    setRuntimeAdapterRunByTeam: (teamName, runtimeRun) =>
      deps.setRuntimeAdapterRunByTeam(teamName, runtimeRun),
    setAliveRunId: (teamName, runId) => deps.setAliveRunId(teamName, runId),
    getTrackedRunId: (teamName) => deps.getTrackedRunId(teamName),
    getRun: (runId) => deps.getRun(runId),
    guardCommittedOpenCodeSecondaryLaneEvidence: (input) =>
      deps.guardCommittedOpenCodeSecondaryLaneEvidence(input),
    publishMixedSecondaryLaneStatusChange: (run, lane) =>
      deps.publishMixedSecondaryLaneStatusChange(run, lane),
    syncOpenCodeRuntimeToolApprovals: (input) => deps.syncOpenCodeRuntimeToolApprovals(input),
    emitTeamChange: (event) => deps.emitTeamChange(event),
  };
}

export function createTeamProvisioningTeammatePermissionResponsePortsFromDeps<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
>(
  deps: TeamProvisioningToolApprovalPortsFactoryDeps<TRun>
): TeamProvisioningTeammatePermissionResponsePorts {
  return {
    readConfigForStrictDecision: (teamName) => deps.readConfigForStrictDecision(teamName),
    addPermissionRulesToSettings: (settingsPath, toolNames, behavior) =>
      deps.addPermissionRulesToSettings(settingsPath, toolNames, behavior),
    persistInboxMessage: (teamName, recipient, message) =>
      deps.persistInboxMessage(teamName, recipient, message),
    emitTeamChange: (event) => deps.emitTeamChange(event),
    logger: deps.logger,
    nowIso: deps.nowIso,
    nowMs: deps.nowMs,
    joinPath: (...parts) => deps.joinPath(...parts),
    teammateOperationalToolNames: deps.teammateOperationalToolNames,
  };
}

export function createTeamProvisioningTeammatePermissionRequestPortsFromDeps<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
>(
  deps: TeamProvisioningToolApprovalPortsFactoryDeps<TRun>
): TeamProvisioningTeammatePermissionRequestPorts<TRun> {
  return {
    logger: deps.logger,
    getSettings: (teamName) => deps.getToolApprovalSettings(teamName),
    shouldAutoAllow,
    buildTeammateToolApprovalRequest,
    respondToTeammatePermission: (input) =>
      respondToTeammatePermission(
        input,
        createTeamProvisioningTeammatePermissionResponsePortsFromDeps(deps)
      ),
    buildToolApprovalAutoResolvedEvent,
    emitToolApprovalEvent: (event) => deps.emitToolApprovalEvent(event),
    startApprovalTimeout: (run, requestId) => deps.startApprovalTimeout(run, requestId),
    maybeShowToolApprovalOsNotification: (run, approval) =>
      deps.maybeShowToolApprovalOsNotification(run, approval),
  };
}

export function createTeamProvisioningToolApprovalResponsePortsFromDeps<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
>(
  deps: TeamProvisioningToolApprovalPortsFactoryDeps<TRun>
): TeamProvisioningToolApprovalResponsePorts<TRun> {
  return {
    runtimeToolApprovalCoordinator: deps.runtimeToolApprovalCoordinator,
    leadToolApprovalResponsePorts:
      createTeamProvisioningLeadToolApprovalResponsePortsFromDeps(deps),
    teammatePermissionResponsePorts:
      createTeamProvisioningTeammatePermissionResponsePortsFromDeps(deps),
  };
}

export function createTeamProvisioningToolApprovalPortsBoundary<
  TRun extends TeamProvisioningToolApprovalPortsFactoryRun,
>(
  deps: TeamProvisioningToolApprovalPortsFactoryDeps<TRun>
): TeamProvisioningToolApprovalPortsBoundary<TRun> {
  return {
    handleControlRequest: (run, msg) =>
      handleLeadControlRequest(run, msg, createTeamProvisioningLeadToolApprovalPortsFromDeps(deps)),
    handleTeammatePermissionRequest: (run, perm, messageTimestamp) =>
      handleTeammatePermissionRequest(
        run,
        perm,
        messageTimestamp,
        createTeamProvisioningTeammatePermissionRequestPortsFromDeps(deps)
      ),
    autoAllowControlRequest: (run, requestId) =>
      autoAllowLeadControlRequest(
        run,
        requestId,
        createTeamProvisioningLeadToolApprovalPortsFromDeps(deps)
      ),
    autoDenyControlRequest: (run, requestId) =>
      autoDenyLeadControlRequest(
        run,
        requestId,
        createTeamProvisioningLeadToolApprovalPortsFromDeps(deps)
      ),
    respondToTeammatePermission: (input) =>
      respondToTeammatePermission(
        input,
        createTeamProvisioningTeammatePermissionResponsePortsFromDeps(deps)
      ),
    answerRuntimeToolApproval: (input) =>
      answerRuntimeToolApprovalResponse(
        input,
        createOpenCodeRuntimeToolApprovalAnswerPortsFromDeps(deps)
      ),
    respondToToolApproval: (input) =>
      respondToToolApprovalResponse(
        input,
        createTeamProvisioningToolApprovalResponsePortsFromDeps(deps)
      ),
  };
}
