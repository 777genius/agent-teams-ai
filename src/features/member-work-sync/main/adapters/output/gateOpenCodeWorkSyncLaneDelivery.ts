import {
  consumeOpenCodeWorkSyncLane,
  hasOpenCodeWorkSyncLaneReservation,
  hydrateOpenCodeWorkSyncLaneReservation,
  peekOpenCodeWorkSyncLane,
  readOpenCodeWorkSyncLaneControl,
  restoreOpenCodeWorkSyncLane,
} from './OpenCodeWorkSyncLaneReservationStore';

export type OpenCodeWorkSyncLaneDeliveryReason =
  | 'work_sync_lane_reserved'
  | 'work_sync_ticket_stale'
  | 'work_sync_ticket_consumed'
  | 'work_sync_admission_stopped';

export interface OpenCodeWorkSyncLaneDeliveryGate {
  restore: () => void;
  reason?: OpenCodeWorkSyncLaneDeliveryReason;
  consumeForSend?: () => { reason?: OpenCodeWorkSyncLaneDeliveryReason };
}

export async function gateOpenCodeWorkSyncLaneDelivery(input: {
  teamName: string;
  memberName: string;
  messageId?: string;
  messageKind?: string;
  workSyncRuntimeTicketId?: string;
  foreground?: boolean;
}): Promise<OpenCodeWorkSyncLaneDeliveryGate> {
  await hydrateOpenCodeWorkSyncLaneReservation(input);
  const control = readOpenCodeWorkSyncLaneControl(input);
  if (control?.stopped) {
    return { restore: () => undefined, reason: 'work_sync_admission_stopped' };
  }
  const reservedTicket = peekOpenCodeWorkSyncLane(input);
  const ticketId = input.workSyncRuntimeTicketId?.trim();
  const isNudge = input.messageKind === 'member_work_sync_nudge';
  if (isNudge && ticketId) {
    if (reservedTicket && reservedTicket.ticketId !== ticketId) {
      return { restore: () => undefined, reason: 'work_sync_ticket_stale' };
    }
    if (!reservedTicket) {
      return { restore: () => undefined, reason: 'work_sync_ticket_consumed' };
    }
    let consumed = false;
    return {
      restore: () => {
        if (consumed && reservedTicket) {
          restoreOpenCodeWorkSyncLane(reservedTicket);
        }
      },
      consumeForSend: () => {
        const live = readOpenCodeWorkSyncLaneControl(input);
        if (live?.stopped) {
          return { reason: 'work_sync_admission_stopped' };
        }
        if (live && reservedTicket.controlRevision < live.controlRevision) {
          return { reason: 'work_sync_ticket_stale' };
        }
        const consumedLane = consumeOpenCodeWorkSyncLane({
          teamName: input.teamName,
          memberName: input.memberName,
          messageId: input.messageId,
          foreground: input.foreground,
        });
        if (consumedLane !== 'consumed') {
          return { reason: 'work_sync_ticket_stale' };
        }
        consumed = true;
        return {};
      },
    };
  }
  const consumedLane = consumeOpenCodeWorkSyncLane({
    teamName: input.teamName,
    memberName: input.memberName,
    messageId: input.messageId,
    foreground: input.foreground,
  });
  const restore = () => {
    if (consumedLane === 'consumed' && reservedTicket) {
      restoreOpenCodeWorkSyncLane(reservedTicket);
    }
  };
  if (!isNudge) {
    return { restore };
  }
  if (consumedLane === 'absent' && hasOpenCodeWorkSyncLaneReservation(input)) {
    return { restore, reason: 'work_sync_lane_reserved' };
  }
  return { restore };
}

export function consumeOpenCodeWorkSyncLaneForSend(
  lane: OpenCodeWorkSyncLaneDeliveryGate,
  input: { messageKind?: string; workSyncRuntimeTicketId?: string }
): { reason?: OpenCodeWorkSyncLaneDeliveryReason } {
  if (input.messageKind !== 'member_work_sync_nudge' || !input.workSyncRuntimeTicketId?.trim()) {
    return {};
  }
  if (lane.reason === 'work_sync_ticket_consumed') {
    return { reason: 'work_sync_ticket_consumed' };
  }
  if (!lane.consumeForSend) {
    return { reason: 'work_sync_ticket_stale' };
  }
  return lane.consumeForSend();
}
