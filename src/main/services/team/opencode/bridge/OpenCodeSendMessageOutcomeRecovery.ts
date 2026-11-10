import { OPEN_CODE_BRIDGE_TIMEOUTS_MS } from './OpenCodeReadinessTimeoutPolicy';

import type {
  OpenCodeCommandStatusCommandBody,
  OpenCodeCommandStatusCommandData,
  OpenCodeSendMessageCommandBody,
  OpenCodeSendMessageCommandData,
} from './OpenCodeBridgeCommandContract';
import type { OpenCodeReadinessBridgeCommandExecutor } from './OpenCodeReadinessBridge';

export async function recoverOpenCodeSendMessageOutcome(
  bridge: Pick<OpenCodeReadinessBridgeCommandExecutor, 'execute'>,
  input: {
    originalRequestId?: string | null;
    body: Pick<
      OpenCodeSendMessageCommandBody,
      | 'deliveryAttemptId'
      | 'teamId'
      | 'teamName'
      | 'laneId'
      | 'memberName'
      | 'messageId'
      | 'payloadHash'
      | 'projectPath'
      | 'runId'
    >;
    requireExactDeliveryAttempt?: boolean;
    diagnosticCode: string;
    diagnosticMessage: string;
  }
): Promise<OpenCodeSendMessageCommandData | null> {
  if (!input.originalRequestId && !input.body.deliveryAttemptId) {
    return null;
  }
  const statusBody: OpenCodeCommandStatusCommandBody = {
    originalCommand: 'opencode.sendMessage',
    deliveryAttemptId: input.body.deliveryAttemptId,
    teamId: input.body.teamId,
    teamName: input.body.teamName,
    laneId: input.body.laneId,
    memberName: input.body.memberName,
    messageId: input.body.messageId,
    payloadHash: input.body.payloadHash,
    projectPath: input.body.projectPath,
    runId: input.body.runId,
    ...(input.originalRequestId ? { originalRequestId: input.originalRequestId } : {}),
  };
  const statusResult = await bridge.execute<
    OpenCodeCommandStatusCommandBody,
    OpenCodeCommandStatusCommandData
  >('opencode.commandStatus', statusBody, {
    cwd: input.body.projectPath,
    timeoutMs: OPEN_CODE_BRIDGE_TIMEOUTS_MS.commandStatus,
  });
  if (!statusResult.ok) {
    return null;
  }
  const status = statusResult.data;
  if (
    input.requireExactDeliveryAttempt &&
    status.deliveryAttemptId !== input.body.deliveryAttemptId
  )
    return null;
  if (
    input.originalRequestId &&
    status.originalRequestId &&
    status.originalRequestId !== input.originalRequestId
  ) {
    return null;
  }
  if (
    input.body.deliveryAttemptId &&
    status.deliveryAttemptId &&
    status.deliveryAttemptId !== input.body.deliveryAttemptId
  ) {
    return null;
  }
  if (status.status === 'precondition_mismatch' || status.accepted !== true) {
    return null;
  }
  const diagnostics = [
    {
      code: input.diagnosticCode,
      severity: 'warning' as const,
      message: input.diagnosticMessage,
    },
    ...status.diagnostics.map((message) => ({
      code: 'opencode_command_status',
      severity: 'info' as const,
      message,
    })),
  ];
  if (status.sendMessageData?.accepted === true) {
    return {
      ...status.sendMessageData,
      diagnostics: [...diagnostics, ...status.sendMessageData.diagnostics],
    };
  }
  return {
    accepted: true,
    memberName: input.body.memberName,
    sessionId: status.sessionId,
    runtimePid: status.runtimePid,
    runtimePromptMessageId: status.runtimePromptMessageId,
    prePromptCursor: status.prePromptCursor,
    diagnostics,
  };
}
