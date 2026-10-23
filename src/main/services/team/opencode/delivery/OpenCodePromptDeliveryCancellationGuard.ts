import { isOpenCodePromptDeliveryCancelled } from './OpenCodePromptDeliveryLedger';

import type { OpenCodeMemberMessageDeliveryServiceDependencies } from './OpenCodeMemberMessageDeliveryPorts';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';

export class OpenCodePromptDeliveryCancelledError extends Error {
  constructor(readonly record?: OpenCodePromptDeliveryLedgerRecord | null) {
    super('opencode_prompt_delivery_cancelled');
  }
}

export async function assertOpenCodePromptDeliveryNotCancelled(
  ledger: OpenCodePromptDeliveryLedgerStore | null | undefined,
  record: OpenCodePromptDeliveryLedgerRecord | null | undefined,
  checkpoint?: () => void | Promise<void>
): Promise<void> {
  if (!record) {
    await checkpoint?.();
    return;
  }
  const current = ledger ? await ledger.getByInboxMessage(record) : record;
  if (isOpenCodePromptDeliveryCancelled(current ?? record)) {
    throw new OpenCodePromptDeliveryCancelledError(current ?? record);
  }
  await checkpoint?.();
}

/** A recipient restart revokes delivery before its retiring lane can accept another effect. */
export function createOpenCodeCurrentDeliveryAssertion(
  ports: Pick<
    OpenCodeMemberMessageDeliveryServiceDependencies,
    | 'resolveDeliverableTrackedRuntimeRunId'
    | 'getCurrentOpenCodeRuntimeRunId'
    | 'stoppingSecondaryRuntimeTeams'
  >,
  input: {
    teamName: string;
    laneKind: 'primary' | 'secondary';
    laneId: string;
    runtimeRunId: string | null;
    trackedRunId: string | null;
    inMemorySecondaryLaneRunId: string | null;
    assertAuthorized(): void;
  }
): () => void {
  return () => {
    input.assertAuthorized();
    const current =
      input.laneKind === 'primary'
        ? ports.resolveDeliverableTrackedRuntimeRunId(input.teamName)
        : ports.getCurrentOpenCodeRuntimeRunId(input.teamName, input.laneId);
    const hadTrackedRun =
      input.laneKind === 'primary' ? input.trackedRunId : input.inMemorySecondaryLaneRunId;
    if (
      (current && input.runtimeRunId && current !== input.runtimeRunId) ||
      (hadTrackedRun && !current) ||
      ports.stoppingSecondaryRuntimeTeams.has(input.teamName)
    ) {
      throw new OpenCodePromptDeliveryCancelledError();
    }
  };
}

export function createOpenCodeDeliveryAuthorization(
  isCurrent?: () => boolean,
  isRecipientRestarting?: () => boolean,
  wakePendingDelivery?: () => void
): (restore?: () => void) => void {
  return (restore) => {
    if (isCurrent?.() === false) {
      restore?.();
      throw new OpenCodePromptDeliveryCancelledError();
    }
    if (isRecipientRestarting?.()) {
      restore?.();
      wakePendingDelivery?.();
      throw new OpenCodePromptDeliveryCancelledError();
    }
  };
}

/** Attachment preparation precedes submission, so cancellation can still return its ticket. */
export function createOpenCodePreSubmissionAssertion(
  assertCurrent: () => void,
  restore: () => void
): () => void {
  return () => {
    try {
      assertCurrent();
    } catch (error) {
      if (error instanceof OpenCodePromptDeliveryCancelledError) restore();
      throw error;
    }
  };
}
