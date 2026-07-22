import type {
  RespondToTeammatePermissionInput,
  TeamProvisioningTeammatePermissionRun,
} from './TeamProvisioningTeammatePermissionResponse';
import type {
  TeammateToolApprovalRequestInput,
  ToolApprovalAutoResolvedEventInput,
} from './TeamProvisioningToolApprovalFlow';
import type {
  ToolApprovalAutoResolved,
  ToolApprovalEvent,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';
import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';

export interface TeamProvisioningTeammatePermissionRequestRun extends TeamProvisioningTeammatePermissionRun {
  request: TeamProvisioningTeammatePermissionRun['request'] & {
    color?: string;
    displayName?: string;
  };
  pendingApprovals: Map<string, ToolApprovalRequest>;
  processedPermissionRequestIds: Set<string>;
}

export interface TeamProvisioningTeammatePermissionRequestLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface TeamProvisioningTeammatePermissionRequestAutoAllowResult {
  autoAllow: boolean;
  reason?: string;
}

export interface TeamProvisioningTeammatePermissionRequestPorts<
  TRun extends TeamProvisioningTeammatePermissionRequestRun,
> {
  logger: TeamProvisioningTeammatePermissionRequestLogger;
  getSettings(teamName: string): ToolApprovalSettings;
  shouldAutoAllow(
    settings: ToolApprovalSettings,
    toolName: string,
    toolInput: Record<string, unknown>
  ): TeamProvisioningTeammatePermissionRequestAutoAllowResult;
  buildTeammateToolApprovalRequest(input: TeammateToolApprovalRequestInput): ToolApprovalRequest;
  respondToTeammatePermission(input: RespondToTeammatePermissionInput): Promise<void>;
  buildToolApprovalAutoResolvedEvent(
    input: ToolApprovalAutoResolvedEventInput
  ): ToolApprovalAutoResolved;
  emitToolApprovalEvent(event: ToolApprovalEvent | ToolApprovalAutoResolved): void;
  startApprovalTimeout(run: TRun, requestId: string): void;
  maybeShowToolApprovalOsNotification(run: TRun, approval: ToolApprovalRequest): void;
}

export function handleTeammatePermissionRequest<
  TRun extends TeamProvisioningTeammatePermissionRequestRun,
>(
  run: TRun,
  perm: ParsedPermissionRequest,
  messageTimestamp: string,
  ports: TeamProvisioningTeammatePermissionRequestPorts<TRun>
): void {
  // Skip if already tracked (idempotency - multiple paths can trigger this:
  // early inbox scan, stdout parsing, native message blocks, relay Category 4)
  if (run.processedPermissionRequestIds.has(perm.requestId)) return;
  if (run.pendingApprovals.has(perm.requestId)) return;
  run.processedPermissionRequestIds.add(perm.requestId);

  try {
    ports.logger.warn(
      `[${run.teamName}] [PERM-TRACE] handleTeammatePermissionRequest: agent=${perm.agentId} tool=${perm.toolName} requestId=${perm.requestId}`
    );

    const approval = ports.buildTeammateToolApprovalRequest({
      requestId: perm.requestId,
      runId: run.runId,
      teamName: run.teamName,
      source: perm.agentId,
      toolName: perm.toolName,
      toolInput: perm.input,
      receivedAt: messageTimestamp || new Date().toISOString(),
      teamColor: run.request.color,
      teamDisplayName: run.request.displayName,
      permissionSuggestions:
        perm.permissionSuggestions.length > 0 ? perm.permissionSuggestions : undefined,
    });

    const autoResult = ports.shouldAutoAllow(
      ports.getSettings(run.teamName),
      perm.toolName,
      perm.input
    );
    if (autoResult.autoAllow) {
      ports.logger.info(
        `[${run.teamName}] Auto-allowing teammate ${perm.agentId} ${perm.toolName} (${autoResult.reason})`
      );
      void ports.respondToTeammatePermission({
        run,
        agentId: perm.agentId,
        requestId: perm.requestId,
        allow: true,
        permissionSuggestions: perm.permissionSuggestions,
        toolName: perm.toolName,
        toolInput: perm.input,
      });
      ports.emitToolApprovalEvent(
        ports.buildToolApprovalAutoResolvedEvent({
          requestId: perm.requestId,
          runId: run.runId,
          teamName: run.teamName,
          reason: 'auto_allow_category',
        })
      );
      return;
    }

    run.pendingApprovals.set(perm.requestId, approval);
    ports.emitToolApprovalEvent(approval);
    ports.startApprovalTimeout(run, perm.requestId);
    ports.maybeShowToolApprovalOsNotification(run, approval);
  } catch (error) {
    run.pendingApprovals.delete(perm.requestId);
    run.processedPermissionRequestIds.delete(perm.requestId);
    throw error;
  }
}
