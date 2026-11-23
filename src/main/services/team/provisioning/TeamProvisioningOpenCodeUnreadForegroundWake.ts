import {
  isOpenCodePromptDeliveryCancelled,
  type OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';

import type { OpenCodeRuntimeLaneIndexEntry } from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

interface UnreadForegroundWakeInput {
  teamName: string;
  memberName: string;
  messageId: string;
}

interface UnreadForegroundWakePorts {
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): Pick<OpenCodePromptDeliveryLedgerStore, 'getByInboxMessage'>;
  scheduleOpenCodeMemberInboxDeliveryWake(
    input: UnreadForegroundWakeInput & {
      delayMs: number;
    }
  ): void;
}

/** Stop retains the delivery cancellation even after its lane index entry is removed. */
export async function scheduleOpenCodeUnreadForegroundWake(
  input: UnreadForegroundWakeInput,
  identity: { canonicalMemberName: string; laneId: string },
  laneState: OpenCodeRuntimeLaneIndexEntry['state'] | undefined,
  ports: UnreadForegroundWakePorts
): Promise<void> {
  if (laneState === 'stopped' || laneState === 'degraded') return;
  try {
    const record = await ports
      .createOpenCodePromptDeliveryLedger(input.teamName, identity.laneId)
      .getByInboxMessage({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
        laneId: identity.laneId,
        inboxMessageId: input.messageId,
      });
    if (record && isOpenCodePromptDeliveryCancelled(record)) return;
  } catch {
    // Keep the busy answer, but do not wake a delivery whose cancellation cannot be read.
    return;
  }
  ports.scheduleOpenCodeMemberInboxDeliveryWake({
    teamName: input.teamName,
    memberName: input.memberName,
    messageId: input.messageId,
    delayMs: 500,
  });
}
