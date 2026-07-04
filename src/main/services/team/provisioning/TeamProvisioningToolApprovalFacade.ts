import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { getAppIconPath } from '@main/utils/appIcon';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';

import { openCodeRuntimeApprovalProvider } from '../approvals/OpenCodeRuntimeApprovalProvider';
import {
  RuntimeToolApprovalCoordinator,
  type RuntimeToolApprovalEntry,
} from '../approvals/RuntimeToolApprovalCoordinator';

import {
  type TeamProvisioningToolApprovalNotification,
  type TeamProvisioningToolApprovalNotificationConstructor,
  type TeamProvisioningToolApprovalNotificationRunLike,
  TeamProvisioningToolApprovalNotifications,
} from './TeamProvisioningToolApprovalNotifications';
import {
  createTeamProvisioningToolApprovalPortsBoundary,
  type TeamProvisioningToolApprovalPortsBoundary,
  type TeamProvisioningToolApprovalPortsFactoryDeps,
  type TeamProvisioningToolApprovalPortsFactoryRun,
} from './TeamProvisioningToolApprovalPortsFactory';
import {
  type TeamProvisioningToolApprovalTimeoutRun,
  TeamProvisioningToolApprovalTimeouts,
} from './TeamProvisioningToolApprovalTimeouts';

import type { OpenCodeRuntimeToolApprovalSyncInput } from './TeamProvisioningRuntimeToolApprovalAnswer';
import type { ToolApprovalEvent, ToolApprovalRequest, ToolApprovalSettings } from '@shared/types';
import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';
import type { BrowserWindow } from 'electron';

export type TeamProvisioningToolApprovalFacadeRun = TeamProvisioningToolApprovalPortsFactoryRun &
  TeamProvisioningToolApprovalTimeoutRun &
  TeamProvisioningToolApprovalNotificationRunLike;

type TeamProvisioningToolApprovalBoundaryDeps<
  TRun extends TeamProvisioningToolApprovalFacadeRun,
> = TeamProvisioningToolApprovalPortsFactoryDeps<TRun>;

export interface TeamProvisioningToolApprovalSyncInput
  extends OpenCodeRuntimeToolApprovalSyncInput {
  memberNames?: readonly string[];
}

export interface TeamProvisioningToolApprovalFacadeDeps<
  TRun extends TeamProvisioningToolApprovalFacadeRun,
> {
  logger: TeamProvisioningToolApprovalBoundaryDeps<TRun>['logger'];
  pendingTimeouts: Map<string, NodeJS.Timeout>;
  getRuns(): Iterable<TRun>;
  getTrackedRunId: TeamProvisioningToolApprovalBoundaryDeps<TRun>['getTrackedRunId'];
  getRun: TeamProvisioningToolApprovalBoundaryDeps<TRun>['getRun'];
  getOpenCodeRuntimeAdapter: TeamProvisioningToolApprovalBoundaryDeps<TRun>['getOpenCodeRuntimeAdapter'];
  readLaunchState: TeamProvisioningToolApprovalBoundaryDeps<TRun>['readLaunchState'];
  persistOpenCodeRuntimeAdapterLaunchResult: TeamProvisioningToolApprovalBoundaryDeps<TRun>['persistOpenCodeRuntimeAdapterLaunchResult'];
  deleteRuntimeAdapterRunByTeam: TeamProvisioningToolApprovalBoundaryDeps<TRun>['deleteRuntimeAdapterRunByTeam'];
  setRuntimeAdapterRunByTeam: TeamProvisioningToolApprovalBoundaryDeps<TRun>['setRuntimeAdapterRunByTeam'];
  setAliveRunId: TeamProvisioningToolApprovalBoundaryDeps<TRun>['setAliveRunId'];
  guardCommittedOpenCodeSecondaryLaneEvidence: TeamProvisioningToolApprovalBoundaryDeps<TRun>['guardCommittedOpenCodeSecondaryLaneEvidence'];
  publishMixedSecondaryLaneStatusChange: TeamProvisioningToolApprovalBoundaryDeps<TRun>['publishMixedSecondaryLaneStatusChange'];
  emitTeamChange: TeamProvisioningToolApprovalBoundaryDeps<TRun>['emitTeamChange'];
  readConfigForStrictDecision: TeamProvisioningToolApprovalBoundaryDeps<TRun>['readConfigForStrictDecision'];
  addPermissionRulesToSettings: TeamProvisioningToolApprovalBoundaryDeps<TRun>['addPermissionRulesToSettings'];
  persistInboxMessage: TeamProvisioningToolApprovalBoundaryDeps<TRun>['persistInboxMessage'];
  nowIso: TeamProvisioningToolApprovalBoundaryDeps<TRun>['nowIso'];
  nowMs: TeamProvisioningToolApprovalBoundaryDeps<TRun>['nowMs'];
  joinPath: TeamProvisioningToolApprovalBoundaryDeps<TRun>['joinPath'];
  teammateOperationalToolNames: TeamProvisioningToolApprovalBoundaryDeps<TRun>['teammateOperationalToolNames'];
}

export class TeamProvisioningToolApprovalFacade<
  TRun extends TeamProvisioningToolApprovalFacadeRun,
> {
  private readonly runtimeToolApprovalCoordinator: RuntimeToolApprovalCoordinator;
  private readonly toolApprovalPortsBoundary: TeamProvisioningToolApprovalPortsBoundary<TRun>;
  private readonly toolApprovalTimeouts: TeamProvisioningToolApprovalTimeouts<TRun>;
  private readonly toolApprovalSettingsByTeam = new Map<string, ToolApprovalSettings>();
  private readonly inFlightResponses = new Set<string>();
  private toolApprovalEventEmitter: ((event: ToolApprovalEvent) => void) | null = null;
  private mainWindowRef: BrowserWindow | null = null;
  private readonly activeApprovalNotifications = new Map<
    string,
    TeamProvisioningToolApprovalNotification
  >();
  private readonly toolApprovalOsNotifications: TeamProvisioningToolApprovalNotifications<TRun>;

  constructor(private readonly deps: TeamProvisioningToolApprovalFacadeDeps<TRun>) {
    this.runtimeToolApprovalCoordinator = new RuntimeToolApprovalCoordinator({
      getSettings: (teamName) => this.getToolApprovalSettings(teamName),
      answerApproval: ({ entry, allow, message }) =>
        this.answerRuntimeToolApproval(entry, allow, message),
      emitApprovalEvent: (event) => this.emitToolApprovalEvent(event),
      showApprovalNotification: (approval) =>
        this.maybeShowToolApprovalOsNotification(undefined, approval),
      dismissApprovalNotification: (requestId) => this.dismissApprovalNotification(requestId),
      logWarning: (message) => this.deps.logger.warn(message),
    });

    this.toolApprovalPortsBoundary =
      createTeamProvisioningToolApprovalPortsBoundary<TRun>({
        logger: this.deps.logger,
        getToolApprovalSettings: (teamName) => this.getToolApprovalSettings(teamName),
        emitToolApprovalEvent: (event) => this.emitToolApprovalEvent(event),
        startApprovalTimeout: (run, requestId) => this.startApprovalTimeout(run, requestId),
        clearApprovalTimeout: (requestId) => this.clearApprovalTimeout(requestId),
        tryClaimResponse: (requestId) => this.tryClaimResponse(requestId),
        maybeShowToolApprovalOsNotification: (run, approval) =>
          this.maybeShowToolApprovalOsNotification(run, approval),
        dismissApprovalNotification: (requestId) => this.dismissApprovalNotification(requestId),
        getTrackedRunId: (teamName) => this.deps.getTrackedRunId(teamName),
        getRun: (runId) => this.deps.getRun(runId),
        inFlightResponses: this.inFlightResponses,
        runtimeToolApprovalCoordinator: this.runtimeToolApprovalCoordinator,
        getOpenCodeRuntimeAdapter: () => this.deps.getOpenCodeRuntimeAdapter(),
        readLaunchState: (teamName) => this.deps.readLaunchState(teamName),
        persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
          this.deps.persistOpenCodeRuntimeAdapterLaunchResult(result, input),
        deleteRuntimeAdapterRunByTeam: (teamName) =>
          this.deps.deleteRuntimeAdapterRunByTeam(teamName),
        setRuntimeAdapterRunByTeam: (teamName, runtimeRun) =>
          this.deps.setRuntimeAdapterRunByTeam(teamName, runtimeRun),
        setAliveRunId: (teamName, runId) => this.deps.setAliveRunId(teamName, runId),
        guardCommittedOpenCodeSecondaryLaneEvidence: (input) =>
          this.deps.guardCommittedOpenCodeSecondaryLaneEvidence(input),
        publishMixedSecondaryLaneStatusChange: (run, lane) =>
          this.deps.publishMixedSecondaryLaneStatusChange(run, lane),
        syncOpenCodeRuntimeToolApprovals: (input) =>
          this.syncOpenCodeRuntimeToolApprovals(input),
        emitTeamChange: (event) => this.deps.emitTeamChange(event),
        readConfigForStrictDecision: (teamName) =>
          this.deps.readConfigForStrictDecision(teamName),
        addPermissionRulesToSettings: (settingsPath, toolNames, behavior) =>
          this.deps.addPermissionRulesToSettings(settingsPath, toolNames, behavior),
        persistInboxMessage: (teamName, recipient, message) =>
          this.deps.persistInboxMessage(teamName, recipient, message),
        nowIso: this.deps.nowIso,
        nowMs: this.deps.nowMs,
        joinPath: (...parts) => this.deps.joinPath(...parts),
        teammateOperationalToolNames: this.deps.teammateOperationalToolNames,
      });

    this.toolApprovalTimeouts = new TeamProvisioningToolApprovalTimeouts<TRun>(
      {
        pendingTimeouts: this.deps.pendingTimeouts,
        inFlightResponses: this.inFlightResponses,
      },
      {
        getSettings: (teamName) => this.getToolApprovalSettings(teamName),
        autoAllowControlRequest: (run, requestId) =>
          this.autoAllowControlRequest(run, requestId),
        autoDenyControlRequest: (run, requestId) => this.autoDenyControlRequest(run, requestId),
        respondToTeammatePermission: (run, approval, allow, message) =>
          this.toolApprovalPortsBoundary.respondToTeammatePermission({
            run,
            agentId: approval.source,
            requestId: approval.requestId,
            allow,
            message,
            permissionSuggestions: approval.permissionSuggestions,
            toolName: approval.toolName,
            toolInput: approval.toolInput,
          }),
        dismissApprovalNotification: (requestId) => this.dismissApprovalNotification(requestId),
        emitToolApprovalEvent: (event) => this.emitToolApprovalEvent(event),
        logInfo: (message) => this.deps.logger.info(message),
      }
    );

    this.toolApprovalOsNotifications = new TeamProvisioningToolApprovalNotifications<TRun>({
      getMainWindow: () => this.mainWindowRef,
      getNotificationSettings: () => ConfigManager.getInstance().getConfig().notifications,
      getNotificationConstructor: () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Notification: ElectronNotification } = require('electron') as Partial<
          typeof import('electron')
        >;
        return (ElectronNotification ??
          null) as TeamProvisioningToolApprovalNotificationConstructor | null;
      },
      getAppIconPath,
      platform: process.platform,
      activeApprovalNotifications: this.activeApprovalNotifications,
      respondToToolApproval: (teamName, runId, requestId, allow, message) =>
        this.respondToToolApproval(teamName, runId, requestId, allow, message),
      logger: {
        info: (message) => this.deps.logger.info(message),
        error: (message) => this.deps.logger.error(message),
      },
      nowMs: () => Date.now(),
    });
  }

  get inFlightResponsesForCleanup(): Set<string> {
    return this.inFlightResponses;
  }

  setToolApprovalEventEmitter(emitter: (event: ToolApprovalEvent) => void): void {
    this.toolApprovalEventEmitter = emitter;
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindowRef = win;
  }

  getToolApprovalSettings(teamName: string): ToolApprovalSettings {
    return this.toolApprovalSettingsByTeam.get(teamName) ?? DEFAULT_TOOL_APPROVAL_SETTINGS;
  }

  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void {
    this.toolApprovalSettingsByTeam.set(teamName, settings);
    this.reEvaluatePendingApprovals();
  }

  emitToolApprovalEvent(event: ToolApprovalEvent): void {
    this.toolApprovalEventEmitter?.(event);
  }

  handleControlRequest(run: TRun, msg: Record<string, unknown>): void {
    this.toolApprovalPortsBoundary.handleControlRequest(run, msg);
  }

  handleTeammatePermissionRequest(
    run: TRun,
    perm: ParsedPermissionRequest,
    messageTimestamp: string
  ): void {
    this.toolApprovalPortsBoundary.handleTeammatePermissionRequest(run, perm, messageTimestamp);
  }

  syncOpenCodeRuntimeToolApprovals(input: TeamProvisioningToolApprovalSyncInput): void {
    const entries = openCodeRuntimeApprovalProvider.collectPendingApprovals(input);
    this.runtimeToolApprovalCoordinator.sync(
      {
        teamName: input.teamName,
        runId: input.runId,
        laneId: input.laneId,
        memberNames: input.memberNames,
        providerId: 'opencode',
      },
      entries
    );
  }

  clearOpenCodeRuntimeToolApprovals(
    teamName: string,
    options: { runId?: string; laneId?: string; emitDismiss?: boolean } = {}
  ): void {
    this.runtimeToolApprovalCoordinator.clear(teamName, {
      ...options,
      providerId: 'opencode',
    });
  }

  maybeShowToolApprovalOsNotification(
    run: TRun | undefined,
    approval: ToolApprovalRequest
  ): void {
    this.toolApprovalOsNotifications.maybeShow(run, approval);
  }

  dismissApprovalNotification(requestId: string): void {
    const notification = this.activeApprovalNotifications.get(requestId);
    if (notification) {
      notification.close();
      this.activeApprovalNotifications.delete(requestId);
    }
  }

  autoAllowControlRequest(run: TRun, requestId: string): void {
    this.toolApprovalPortsBoundary.autoAllowControlRequest(run, requestId);
  }

  tryClaimResponse(requestId: string): boolean {
    return this.toolApprovalTimeouts.tryClaimResponse(requestId);
  }

  startApprovalTimeout(run: TRun, requestId: string): void {
    this.toolApprovalTimeouts.start(run, requestId);
  }

  clearApprovalTimeout(requestId: string): void {
    this.toolApprovalTimeouts.clear(requestId);
  }

  autoDenyControlRequest(run: TRun, requestId: string): void {
    this.toolApprovalPortsBoundary.autoDenyControlRequest(run, requestId);
  }

  reEvaluatePendingApprovals(): void {
    this.toolApprovalTimeouts.reEvaluate(this.deps.getRuns());
    this.runtimeToolApprovalCoordinator.reEvaluate();
  }

  async answerRuntimeToolApproval(
    entry: RuntimeToolApprovalEntry,
    allow: boolean,
    message?: string
  ): Promise<void> {
    await this.toolApprovalPortsBoundary.answerRuntimeToolApproval({ entry, allow, message });
  }

  async respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void> {
    await this.toolApprovalPortsBoundary.respondToToolApproval({
      teamName,
      runId,
      requestId,
      allow,
      message,
    });
  }
}
