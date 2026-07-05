import { shouldAutoAllow as defaultShouldAutoAllow } from '@main/utils/toolApprovalRules';

import {
  buildAllowControlResponsePayload,
  buildDenyControlResponsePayload,
  buildLeadToolApprovalDecisionPayload,
  buildLeadToolApprovalRequest,
  buildToolApprovalAutoResolvedEvent,
  TOOL_APPROVAL_TIMEOUT_CONTROL_DENY_MESSAGE,
  type ToolApprovalControlResponsePayload,
} from './TeamProvisioningToolApprovalFlow';

import type {
  ToolApprovalAutoResolved,
  ToolApprovalEvent,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';

export interface TeamProvisioningLeadToolApprovalRun {
  runId: string;
  teamName: string;
  request: {
    color?: string;
    displayName?: string;
  };
  child?: {
    stdin?: {
      writable?: boolean;
      write(data: string, callback?: (err?: Error | null) => void): unknown;
    } | null;
  } | null;
  pendingApprovals: Map<string, ToolApprovalRequest>;
}

export interface TeamProvisioningLeadToolApprovalLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TeamProvisioningLeadToolApprovalAutoAllowResult {
  autoAllow: boolean;
  reason?: string;
}

export interface TeamProvisioningLeadToolApprovalPorts<
  TRun extends TeamProvisioningLeadToolApprovalRun,
> {
  logger: TeamProvisioningLeadToolApprovalLogger;
  getSettings(teamName: string): ToolApprovalSettings;
  shouldAutoAllow(
    settings: ToolApprovalSettings,
    toolName: string,
    toolInput: Record<string, unknown>
  ): TeamProvisioningLeadToolApprovalAutoAllowResult;
  emitToolApprovalEvent(event: ToolApprovalEvent | ToolApprovalAutoResolved): void;
  startApprovalTimeout(run: TRun, requestId: string): void;
  maybeShowToolApprovalOsNotification(run: TRun, approval: ToolApprovalRequest): void;
  buildLeadToolApprovalRequest(input: Parameters<typeof buildLeadToolApprovalRequest>[0]): ToolApprovalRequest;
  buildToolApprovalAutoResolvedEvent(
    input: Parameters<typeof buildToolApprovalAutoResolvedEvent>[0]
  ): ToolApprovalAutoResolved;
  buildAllowControlResponsePayload(requestId: string): ToolApprovalControlResponsePayload;
  buildDenyControlResponsePayload(
    requestId: string,
    message: string
  ): ToolApprovalControlResponsePayload;
}

export interface TeamProvisioningLeadToolApprovalResponsePorts<
  TRun extends TeamProvisioningLeadToolApprovalRun,
> {
  logger: TeamProvisioningLeadToolApprovalLogger;
  getTrackedRunId(teamName: string): string | undefined;
  getRun(runId: string): TRun | undefined;
  clearApprovalTimeout(requestId: string): void;
  tryClaimResponse(requestId: string): boolean;
  inFlightResponses: Set<string>;
  startApprovalTimeout(run: TRun, requestId: string): void;
  dismissApprovalNotification(requestId: string): void;
  buildLeadToolApprovalDecisionPayload(
    input: Parameters<typeof buildLeadToolApprovalDecisionPayload>[0]
  ): ToolApprovalControlResponsePayload;
}

export type TeamProvisioningLeadToolApprovalResponseResult<
  TRun extends TeamProvisioningLeadToolApprovalRun,
> =
  | { handled: true }
  | {
      handled: false;
      run: TRun;
      approval: ToolApprovalRequest;
    };

export function createDefaultLeadToolApprovalPorts<
  TRun extends TeamProvisioningLeadToolApprovalRun,
>(
  ports: Omit<
    TeamProvisioningLeadToolApprovalPorts<TRun>,
    | 'shouldAutoAllow'
    | 'buildLeadToolApprovalRequest'
    | 'buildToolApprovalAutoResolvedEvent'
    | 'buildAllowControlResponsePayload'
    | 'buildDenyControlResponsePayload'
  >
): TeamProvisioningLeadToolApprovalPorts<TRun> {
  return {
    ...ports,
    shouldAutoAllow: defaultShouldAutoAllow,
    buildLeadToolApprovalRequest,
    buildToolApprovalAutoResolvedEvent,
    buildAllowControlResponsePayload,
    buildDenyControlResponsePayload,
  };
}

export function handleLeadControlRequest<TRun extends TeamProvisioningLeadToolApprovalRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningLeadToolApprovalPorts<TRun>
): void {
  const requestId = typeof msg.request_id === 'string' ? msg.request_id : null;
  if (!requestId) {
    ports.logger.warn(`[${run.teamName}] control_request missing request_id, ignoring`);
    return;
  }

  const request = msg.request as Record<string, unknown> | undefined;
  const subtype = request?.subtype;

  // Non-`can_use_tool` subtypes (hook_callback, etc.) are auto-allowed to prevent
  // CLI deadlock - hooks are user-configured and should not block on manual approval.
  if (subtype !== 'can_use_tool') {
    ports.logger.debug(
      `[${run.teamName}] control_request subtype=${String(subtype)}, auto-allowing to prevent deadlock`
    );
    autoAllowLeadControlRequest(run, requestId, ports);
    return;
  }

  const toolName = typeof request?.tool_name === 'string' ? request.tool_name : 'Unknown';
  const toolInput = (request?.input ?? {}) as Record<string, unknown>;
  const providerId = toolInput.provider === 'codex' ? 'codex' : undefined;

  const approval = ports.buildLeadToolApprovalRequest({
    requestId,
    runId: run.runId,
    teamName: run.teamName,
    ...(providerId ? { providerId } : {}),
    toolName,
    toolInput,
    teamColor: run.request.color,
    teamDisplayName: run.request.displayName,
  });

  // Check auto-allow rules before prompting user
  const autoResult = ports.shouldAutoAllow(ports.getSettings(run.teamName), toolName, toolInput);
  if (autoResult.autoAllow) {
    ports.logger.info(`[${run.teamName}] Auto-allowing ${toolName} (${autoResult.reason})`);
    autoAllowLeadControlRequest(run, requestId, ports);
    ports.emitToolApprovalEvent(
      ports.buildToolApprovalAutoResolvedEvent({
        requestId,
        runId: run.runId,
        teamName: run.teamName,
        reason: 'auto_allow_category',
      })
    );
    return;
  }

  run.pendingApprovals.set(requestId, approval);
  ports.emitToolApprovalEvent(approval);
  ports.startApprovalTimeout(run, requestId);

  // Show OS notification when window is not focused
  ports.maybeShowToolApprovalOsNotification(run, approval);
}

export function autoAllowLeadControlRequest<TRun extends TeamProvisioningLeadToolApprovalRun>(
  run: TRun,
  requestId: string,
  ports: Pick<
    TeamProvisioningLeadToolApprovalPorts<TRun>,
    'logger' | 'buildAllowControlResponsePayload'
  >
): void {
  if (!run.child?.stdin?.writable) {
    ports.logger.warn(`[${run.teamName}] Cannot auto-allow control_request: stdin not writable`);
    return;
  }

  const response = ports.buildAllowControlResponsePayload(requestId);

  run.child.stdin.write(JSON.stringify(response) + '\n', (err) => {
    if (err) {
      ports.logger.error(
        `[${run.teamName}] Failed to auto-allow control_request ${requestId}: ${err.message}`
      );
    }
  });
}

export function autoDenyLeadControlRequest<TRun extends TeamProvisioningLeadToolApprovalRun>(
  run: TRun,
  requestId: string,
  ports: Pick<TeamProvisioningLeadToolApprovalPorts<TRun>, 'logger' | 'buildDenyControlResponsePayload'>
): void {
  if (!run.child?.stdin?.writable) {
    ports.logger.warn(`[${run.teamName}] Cannot auto-deny control_request: stdin not writable`);
    return;
  }

  const response = ports.buildDenyControlResponsePayload(
    requestId,
    TOOL_APPROVAL_TIMEOUT_CONTROL_DENY_MESSAGE
  );

  run.child.stdin.write(JSON.stringify(response) + '\n', (err) => {
    if (err) {
      ports.logger.error(
        `[${run.teamName}] Failed to auto-deny control_request ${requestId}: ${err.message}`
      );
    }
  });
}

export async function respondToLeadToolApproval<
  TRun extends TeamProvisioningLeadToolApprovalRun,
>(
  input: {
    teamName: string;
    runId: string;
    requestId: string;
    allow: boolean;
    message?: string;
  },
  ports: TeamProvisioningLeadToolApprovalResponsePorts<TRun>
): Promise<TeamProvisioningLeadToolApprovalResponseResult<TRun>> {
  const { teamName, runId, requestId, allow, message } = input;

  // Look in both provisioning and alive runs - control_requests arrive during provisioning too
  const currentRunId = ports.getTrackedRunId(teamName);
  if (!currentRunId) throw new Error(`No active process for team "${teamName}"`);
  const run = ports.getRun(currentRunId);
  if (!run) throw new Error(`Run not found for team "${teamName}"`);

  if (run.runId !== runId) {
    throw new Error(`Stale approval: runId mismatch (expected ${run.runId}, got ${runId})`);
  }

  // Clear timeout and claim response FIRST (before pendingApprovals check)
  // to handle the race where timeout already responded and deleted the approval
  ports.clearApprovalTimeout(requestId);
  if (!ports.tryClaimResponse(requestId)) {
    // Another response is already being written; leave the pending approval tracked
    // until that write succeeds or fails.
    return { handled: true };
  }

  if (!run.pendingApprovals.has(requestId)) {
    // Approval was removed (e.g. by reEvaluatePendingApprovals) - clean up claim and exit
    ports.inFlightResponses.delete(requestId);
    return { handled: true };
  }

  const approval = run.pendingApprovals.get(requestId)!;

  if (approval.source !== 'lead') {
    return { handled: false, run, approval };
  }

  if (!run.child?.stdin?.writable) {
    ports.inFlightResponses.delete(requestId);
    ports.startApprovalTimeout(run, requestId);
    throw new Error(`Team "${teamName}" process stdin is not writable`);
  }

  // IMPORTANT: request_id is NESTED inside response, NOT top-level
  // (asymmetry with control_request - confirmed by Python SDK, Elixir SDK and issue #29991)
  const response = ports.buildLeadToolApprovalDecisionPayload({
    requestId,
    approval,
    allow,
    message,
  });

  const stdin = run.child.stdin;
  const responseJson = JSON.stringify(response) + '\n';
  ports.logger.info(
    `[${teamName}] Writing control_response for ${requestId}: ${allow ? 'allow' : 'deny'}`
  );
  try {
    await new Promise<void>((resolve, reject) => {
      // Safety timeout - if stdin.write callback is never called (e.g. process died
      // between the writable check and the write), reject instead of hanging forever.
      const writeTimeout = setTimeout(() => {
        reject(new Error(`Timeout writing control_response to stdin (process may have exited)`));
      }, 5000);

      stdin.write(responseJson, (err) => {
        clearTimeout(writeTimeout);
        if (err) {
          ports.logger.error(`[${teamName}] Failed to write control_response: ${err.message}`);
          reject(err);
        } else {
          ports.logger.info(`[${teamName}] control_response written successfully for ${requestId}`);
          resolve();
        }
      });
    });
  } catch (error) {
    ports.inFlightResponses.delete(requestId);
    if (run.pendingApprovals.has(requestId)) {
      ports.startApprovalTimeout(run, requestId);
    }
    throw error;
  }
  run.pendingApprovals.delete(requestId);
  ports.inFlightResponses.delete(requestId);
  ports.dismissApprovalNotification(requestId);
  return { handled: true };
}
