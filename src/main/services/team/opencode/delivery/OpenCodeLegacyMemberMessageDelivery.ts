import { normalizeOpenCodeDeliveryResponseObservation } from './OpenCodePromptDeliveryReadCommitPolicy';

import type { OpenCodeCommittedBootstrapSessionRecord } from '../store/OpenCodeRuntimeManifestEvidenceReader';
import type {
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliveryInput,
  OpenCodeMemberMessageDeliveryServiceDependencies,
  OpenCodeRuntimeMessageAdapter,
} from './OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodeFilePart } from '@features/agent-attachments/main';

export type OpenCodeLegacyMemberMessageDeliveryPorts = Pick<
  OpenCodeMemberMessageDeliveryServiceDependencies,
  | 'resolveControlApiBaseUrl'
  | 'sendOpenCodeMemberMessageToRuntimeSerialized'
  | 'rememberOpenCodeRuntimePidFromBridge'
  | 'stampOpenCodeAppMcpTransportEvidenceIfMissing'
  | 'maybeSyncOpenCodeRuntimePermissionsAfterDelivery'
  | 'isLegacyOpenCodeMemberWorkSyncReadCommitAllowed'
>;

/**
 * Delivery path used when the prompt-delivery watchdog is disabled: send once
 * over the runtime bridge and report what came back, with no ledger record and
 * therefore no retry, no observation loop and no read-commit proof. The only
 * response that is waited for is a member work-sync report.
 *
 * Everything the watchdog path adds - acceptance proof, retries, stale-pending
 * handling, lead turn activity - is deliberately absent here.
 */
export async function deliverOpenCodeMemberMessageWithoutWatchdog(input: {
  ports: OpenCodeLegacyMemberMessageDeliveryPorts;
  adapter: OpenCodeRuntimeMessageAdapter;
  message: OpenCodeMemberMessageDeliveryInput;
  teamName: string;
  memberName: string;
  laneId: string;
  cwd: string;
  runtimeRunId: string | null;
  fileParts: OpenCodeFilePart[];
  forceSessionRefreshReason?: string;
  legacyBootstrapSessionToStamp: OpenCodeCommittedBootstrapSessionRecord | null;
  refreshedBootstrapSessionToStamp: OpenCodeCommittedBootstrapSessionRecord | null;
  teamColor?: string;
  teamDisplayName?: string;
}): Promise<OpenCodeMemberInboxDelivery> {
  const { ports, message, teamName, memberName, laneId, cwd, runtimeRunId } = input;
  const controlUrl =
    message.messageKind === 'member_work_sync_nudge'
      ? await ports.resolveControlApiBaseUrl()
      : null;
  const result = await ports.sendOpenCodeMemberMessageToRuntimeSerialized({
    teamName,
    laneId,
    memberName,
    send: async () =>
      await input.adapter.sendMessageToMember({
        ...(runtimeRunId ? { runId: runtimeRunId } : {}),
        teamName,
        laneId,
        memberName,
        cwd,
        text: message.text,
        messageId: message.messageId,
        fileParts: input.fileParts,
        replyRecipient: message.replyRecipient,
        actionMode: message.actionMode,
        messageKind: message.messageKind,
        workSyncIntent: message.workSyncIntent,
        workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
        controlUrl: controlUrl ?? undefined,
        taskRefs: message.taskRefs,
        forceSessionRefreshReason: input.forceSessionRefreshReason,
      }),
  });
  await ports.rememberOpenCodeRuntimePidFromBridge({
    teamName,
    memberName,
    laneId,
    runId: runtimeRunId,
    runtimeSessionId: result.sessionId,
    runtimePid: result.runtimePid,
    reason: 'opencode_delivery_runtime_pid_observed',
  });
  if (result.ok && input.legacyBootstrapSessionToStamp) {
    await ports.stampOpenCodeAppMcpTransportEvidenceIfMissing(input.legacyBootstrapSessionToStamp);
  }
  if (result.ok && result.sessionId && input.refreshedBootstrapSessionToStamp) {
    await ports.stampOpenCodeAppMcpTransportEvidenceIfMissing(
      input.refreshedBootstrapSessionToStamp,
      {
        overwriteExistingHash: true,
        runtimeSessionId: result.sessionId,
      }
    );
  }
  const responseObservation = normalizeOpenCodeDeliveryResponseObservation(
    result.responseObservation
  );
  await ports.maybeSyncOpenCodeRuntimePermissionsAfterDelivery({
    teamName,
    runId: runtimeRunId,
    laneId,
    memberName,
    cwd,
    sessionId: result.sessionId,
    responseState: responseObservation?.state,
    reason: responseObservation?.reason ?? result.diagnostics[0],
    diagnostics: result.diagnostics,
    teamColor: input.teamColor,
    teamDisplayName: input.teamDisplayName,
  });
  const legacyWorkSyncReadAllowed =
    message.messageKind === 'member_work_sync_nudge' && result.ok
      ? await ports.isLegacyOpenCodeMemberWorkSyncReadCommitAllowed({
          teamName,
          memberName,
          workSyncIntent: message.workSyncIntent,
          responseObservation,
        })
      : true;
  const legacyWorkSyncResponsePending =
    result.ok && message.messageKind === 'member_work_sync_nudge' && !legacyWorkSyncReadAllowed;
  return {
    delivered: result.ok,
    accepted: result.ok,
    responsePending: legacyWorkSyncResponsePending,
    responseState: responseObservation?.state,
    ...(legacyWorkSyncResponsePending
      ? { reason: responseObservation?.reason ?? 'member_work_sync_report_required' }
      : result.ok
        ? {}
        : { reason: result.diagnostics[0] ?? 'opencode_message_delivery_failed' }),
    diagnostics: result.diagnostics,
  };
}
