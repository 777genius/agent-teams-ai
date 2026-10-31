import { OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS } from './OpenCodePromptDeliveryWatchdog';

import type {
  DeliverableTrackedRun,
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliveryServiceDependencies,
} from './OpenCodeMemberMessageDeliveryPorts';

/** Capture before the bootstrap read; a later answer cannot authorize another lane generation. */
export function createOpenCodeBootstrapPendingDeliveryWake(
  ports: Pick<
    OpenCodeMemberMessageDeliveryServiceDependencies,
    | 'resolveDeliverableTrackedRuntimeRunId'
    | 'runs'
    | 'getCurrentOpenCodeRuntimeRunId'
    | 'stoppingSecondaryRuntimeTeams'
    | 'scheduleOpenCodePromptDeliveryWatchdog'
  >,
  input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    laneId: string;
    trackedRunId: string | null;
    trackedRun: DeliverableTrackedRun | null | undefined;
    runtimeRunId: string | null;
  }
): () => void {
  const { teamName, laneId, trackedRunId, trackedRun, runtimeRunId } = input;
  const lane = trackedRun?.mixedSecondaryLanes.find(
    (entry) => entry.laneId === laneId && entry.runId === runtimeRunId
  );
  const isCurrent = (): boolean =>
    Boolean(
      trackedRunId &&
      trackedRun &&
      lane &&
      runtimeRunId &&
      ports.resolveDeliverableTrackedRuntimeRunId(teamName) === trackedRunId &&
      ports.runs.get(trackedRunId) === trackedRun &&
      trackedRun.mixedSecondaryLanes.includes(lane) &&
      lane.runId === runtimeRunId &&
      ports.getCurrentOpenCodeRuntimeRunId(teamName, laneId) === runtimeRunId &&
      !ports.stoppingSecondaryRuntimeTeams.has(teamName)
    );
  // Refuse a read that began without an exact in-memory owner, even if one appears later.
  const authorizedBeforeRead = isCurrent();
  return () => {
    if (!authorizedBeforeRead || !input.messageId?.trim() || !isCurrent()) return;
    ports.scheduleOpenCodePromptDeliveryWatchdog({
      teamName,
      memberName: input.memberName,
      messageId: input.messageId,
      delayMs: OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
      isCurrent,
    });
  };
}

/**
 * The lane is up but its bootstrap has not checked in yet, so the message stays saved and is
 * retried after check-in. It keeps the stopped-lane reason code, flagged as an expected wait.
 */
export function buildOpenCodeBootstrapDeferredDelivery(
  memberName: string
): OpenCodeMemberInboxDelivery {
  return {
    delivered: false,
    reason: 'opencode_runtime_not_active',
    deferredUntilBootstrap: true,
    diagnostics: [
      `OpenCode runtime bootstrap is not confirmed for ${memberName}. ` +
        'Message was saved and will be retried after runtime check-in.',
    ],
  };
}
