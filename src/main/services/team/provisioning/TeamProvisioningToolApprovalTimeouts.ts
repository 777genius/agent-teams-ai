import { shouldAutoAllow } from '@main/utils/toolApprovalRules';

import {
  buildToolApprovalAutoResolvedEvent,
  resolveToolApprovalTimeoutAutoResolution,
} from './TeamProvisioningToolApprovalFlow';

import type {
  ToolApprovalAutoResolved,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';

type SynchronousCallResult<T> = { success: true; value: T } | { success: false; error: unknown };

function captureSynchronousCall<T>(call: () => T): SynchronousCallResult<T> {
  try {
    return { success: true, value: call() };
  } catch (error) {
    return { success: false, error };
  }
}

export interface TeamProvisioningToolApprovalTimeoutRun {
  runId: string;
  teamName: string;
  pendingApprovals: Map<string, ToolApprovalRequest>;
}

export interface TeamProvisioningToolApprovalTimeoutMaps {
  pendingTimeouts: Map<string, NodeJS.Timeout>;
  inFlightResponses: Set<string>;
}

export interface TeamProvisioningToolApprovalTimeoutPorts<
  TRun extends TeamProvisioningToolApprovalTimeoutRun,
> {
  getSettings(teamName: string): ToolApprovalSettings;
  autoAllowControlRequest(run: TRun, requestId: string): void;
  autoDenyControlRequest(run: TRun, requestId: string): void;
  respondToTeammatePermission(
    run: TRun,
    approval: ToolApprovalRequest,
    allow: boolean,
    message?: string
  ): Promise<void>;
  dismissApprovalNotification(requestId: string): void;
  emitToolApprovalEvent(event: ToolApprovalAutoResolved): void;
  logInfo(message: string): void;
}

export class TeamProvisioningToolApprovalTimeouts<
  TRun extends TeamProvisioningToolApprovalTimeoutRun,
> {
  constructor(
    private readonly maps: TeamProvisioningToolApprovalTimeoutMaps,
    private readonly ports: TeamProvisioningToolApprovalTimeoutPorts<TRun>
  ) {}

  tryClaimResponse(requestId: string): boolean {
    if (this.maps.inFlightResponses.has(requestId)) return false;
    this.maps.inFlightResponses.add(requestId);
    return true;
  }

  start(run: TRun, requestId: string): void {
    const { timeoutAction, timeoutSeconds } = this.ports.getSettings(run.teamName);
    if (timeoutAction === 'wait') return;

    const timeoutMs = timeoutSeconds * 1000;
    const timer = setTimeout(() => {
      this.maps.pendingTimeouts.delete(requestId);
      if (!run.pendingApprovals.has(requestId)) return;
      if (!this.tryClaimResponse(requestId)) return;

      const currentAction = this.ports.getSettings(run.teamName).timeoutAction;
      const resolution = resolveToolApprovalTimeoutAutoResolution({
        timeoutAction: currentAction,
        requestId,
        runId: run.runId,
        teamName: run.teamName,
      });
      if (!resolution) {
        this.maps.inFlightResponses.delete(requestId);
        return;
      }

      const { allow } = resolution;
      this.ports.logInfo(
        `[${run.teamName}] Timeout ${allow ? 'allowing' : 'denying'} ${requestId}`
      );

      const approval = run.pendingApprovals.get(requestId);
      if (approval && approval.source !== 'lead') {
        this.settleTeammateAutoResponse(
          run,
          approval,
          allow,
          allow ? undefined : resolution.teammateDenyMessage,
          resolution.event,
          true
        );
        return;
      }

      if (allow) {
        this.ports.autoAllowControlRequest(run, requestId);
      } else {
        this.ports.autoDenyControlRequest(run, requestId);
      }
      run.pendingApprovals.delete(requestId);
      this.maps.inFlightResponses.delete(requestId);
      this.ports.dismissApprovalNotification(requestId);
      this.ports.emitToolApprovalEvent(resolution.event);
    }, timeoutMs);

    this.maps.pendingTimeouts.set(requestId, timer);
  }

  clear(requestId: string): void {
    const timer = this.maps.pendingTimeouts.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.maps.pendingTimeouts.delete(requestId);
    }
  }

  reEvaluate(runs: Iterable<TRun>): void {
    for (const run of runs) {
      const settings = this.ports.getSettings(run.teamName);
      const toRemove: string[] = [];
      for (const [requestId, approval] of run.pendingApprovals) {
        const result = shouldAutoAllow(settings, approval.toolName, approval.toolInput);
        if (result.autoAllow) {
          this.clear(requestId);
          if (!this.tryClaimResponse(requestId)) continue;
          if (approval.source !== 'lead') {
            this.settleTeammateAutoResponse(
              run,
              approval,
              true,
              undefined,
              buildToolApprovalAutoResolvedEvent({
                requestId,
                runId: run.runId,
                teamName: run.teamName,
                reason: 'auto_allow_category',
              }),
              false
            );
          } else {
            this.ports.autoAllowControlRequest(run, requestId);
            this.ports.dismissApprovalNotification(requestId);
            toRemove.push(requestId);
            this.ports.emitToolApprovalEvent(
              buildToolApprovalAutoResolvedEvent({
                requestId,
                runId: run.runId,
                teamName: run.teamName,
                reason: 'auto_allow_category',
              })
            );
          }
        } else if (settings.timeoutAction !== 'wait' && !this.maps.pendingTimeouts.has(requestId)) {
          this.start(run, requestId);
        } else if (settings.timeoutAction === 'wait' && this.maps.pendingTimeouts.has(requestId)) {
          this.clear(requestId);
        }
      }
      for (const requestId of toRemove) {
        run.pendingApprovals.delete(requestId);
        this.maps.inFlightResponses.delete(requestId);
      }
    }
  }

  private settleTeammateAutoResponse(
    run: TRun,
    approval: ToolApprovalRequest,
    allow: boolean,
    message: string | undefined,
    event: ToolApprovalAutoResolved,
    restartTimeoutOnFailure: boolean
  ): void {
    const { requestId } = approval;
    const handleFailure = (error: unknown): void => {
      this.maps.inFlightResponses.delete(requestId);
      this.ports.logInfo(
        `[${run.teamName}] Failed to auto-resolve teammate approval ${requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (
        restartTimeoutOnFailure &&
        run.pendingApprovals.has(requestId) &&
        !this.maps.pendingTimeouts.has(requestId)
      ) {
        this.start(run, requestId);
      }
    };

    const response = captureSynchronousCall(() =>
      this.ports.respondToTeammatePermission(run, approval, allow, message)
    );
    if (!response.success) {
      handleFailure(response.error);
      return;
    }

    void response.value.then(() => {
      run.pendingApprovals.delete(requestId);
      this.maps.inFlightResponses.delete(requestId);
      this.ports.dismissApprovalNotification(requestId);
      this.ports.emitToolApprovalEvent(event);
    }, handleFailure);
  }
}
