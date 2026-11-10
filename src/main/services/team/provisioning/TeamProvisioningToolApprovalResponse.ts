import {
  respondToLeadToolApproval,
  type TeamProvisioningLeadToolApprovalResponsePorts,
  type TeamProvisioningLeadToolApprovalRun,
} from './TeamProvisioningLeadToolApproval';
import {
  answerOpenCodeRuntimeToolApproval,
  type OpenCodeRuntimePermissionAnswerRun,
  type OpenCodeRuntimeToolApprovalAnswerPorts,
} from './TeamProvisioningRuntimeToolApprovalAnswer';
import {
  respondToTeammatePermission,
  type TeamProvisioningTeammatePermissionResponsePorts,
  type TeamProvisioningTeammatePermissionRun,
} from './TeamProvisioningTeammatePermissionResponse';

import type {
  RuntimeToolApprovalCoordinator,
  RuntimeToolApprovalEntry,
} from '../approvals/RuntimeToolApprovalCoordinator';

export interface TeamProvisioningToolApprovalResponseInput {
  teamName: string;
  runId: string;
  requestId: string;
  allow: boolean;
  message?: string;
}

export interface TeamProvisioningRuntimeToolApprovalAnswerInput {
  entry: RuntimeToolApprovalEntry;
  allow: boolean;
  message?: string;
}

export interface TeamProvisioningToolApprovalRuntimeCoordinator {
  respond: RuntimeToolApprovalCoordinator['respond'];
}

export interface TeamProvisioningToolApprovalResponseRun extends Omit<
  TeamProvisioningLeadToolApprovalRun,
  'request'
> {
  request: TeamProvisioningLeadToolApprovalRun['request'] &
    NonNullable<TeamProvisioningTeammatePermissionRun['request']>;
}

export interface TeamProvisioningToolApprovalResponsePorts<
  TRun extends TeamProvisioningToolApprovalResponseRun,
> {
  runtimeToolApprovalCoordinator: TeamProvisioningToolApprovalRuntimeCoordinator;
  leadToolApprovalResponsePorts: TeamProvisioningLeadToolApprovalResponsePorts<TRun>;
  teammatePermissionResponsePorts: TeamProvisioningTeammatePermissionResponsePorts;
}

export async function answerRuntimeToolApprovalResponse<
  TRun extends OpenCodeRuntimePermissionAnswerRun,
>(
  input: TeamProvisioningRuntimeToolApprovalAnswerInput,
  ports: OpenCodeRuntimeToolApprovalAnswerPorts<TRun>
): Promise<void> {
  await answerOpenCodeRuntimeToolApproval(input.entry, input.allow, ports, input.message);
}

export async function respondToToolApprovalResponse<
  TRun extends TeamProvisioningToolApprovalResponseRun,
>(
  input: TeamProvisioningToolApprovalResponseInput,
  ports: TeamProvisioningToolApprovalResponsePorts<TRun>
): Promise<void> {
  const { teamName, runId, requestId, allow, message } = input;
  const handledByRuntime = await ports.runtimeToolApprovalCoordinator.respond(
    teamName,
    runId,
    requestId,
    allow,
    message
  );
  if (handledByRuntime) {
    return;
  }

  const leadResponse = await respondToLeadToolApproval(
    {
      teamName,
      runId,
      requestId,
      allow,
      message,
    },
    ports.leadToolApprovalResponsePorts
  );
  if (leadResponse.handled) {
    return;
  }

  const { run, approval, claimOwnership } = leadResponse;

  // The lead boundary transfers its response claim with a non-lead redirect. Keep that
  // claim for the whole teammate response, then release it on every exit below.
  // Teammate permission requests: apply permission_suggestions to project settings.
  try {
    await respondToTeammatePermission(
      {
        run,
        agentId: approval.source,
        requestId,
        allow,
        message,
        permissionSuggestions: approval.permissionSuggestions,
        toolName: approval.toolName,
        toolInput: approval.toolInput,
      },
      ports.teammatePermissionResponsePorts
    );
    run.pendingApprovals.delete(requestId);
    ports.leadToolApprovalResponsePorts.dismissApprovalNotification(requestId);
  } catch (error) {
    if (run.pendingApprovals.has(requestId)) {
      ports.leadToolApprovalResponsePorts.startApprovalTimeout(run, requestId);
    }
    throw error;
  } finally {
    if (claimOwnership === 'caller') {
      ports.leadToolApprovalResponsePorts.inFlightResponses.delete(requestId);
    }
  }
}
