import {
  consumeOpenCodeWorkSyncLaneForSend,
  type OpenCodeWorkSyncLaneDeliveryGate,
  type OpenCodeWorkSyncLaneDeliveryReason,
} from './gateOpenCodeWorkSyncLaneDelivery';

export class OpenCodeWorkSyncLaneSendBlockedError extends Error {
  constructor(readonly reason: OpenCodeWorkSyncLaneDeliveryReason) {
    super(reason);
    this.name = 'OpenCodeWorkSyncLaneSendBlockedError';
  }
}

export async function sendOpenCodeWorkSyncAdmittedMessage<T>(input: {
  lane: OpenCodeWorkSyncLaneDeliveryGate;
  message: { messageKind?: string; workSyncRuntimeTicketId?: string };
  restore: () => void;
  checkpoint: () => Promise<void>;
  serialize: (send: () => Promise<T>) => Promise<T>;
  sendMessage: () => Promise<T>;
}): Promise<{ ok: true; result: T } | { ok: false; reason: OpenCodeWorkSyncLaneDeliveryReason }> {
  await input.checkpoint();
  try {
    const result = await input.serialize(async () => {
      await input.checkpoint();
      const sendReason = consumeOpenCodeWorkSyncLaneForSend(input.lane, input.message).reason;
      if (sendReason) {
        throw new OpenCodeWorkSyncLaneSendBlockedError(sendReason);
      }
      return input.sendMessage();
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof OpenCodeWorkSyncLaneSendBlockedError) {
      input.restore();
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}
