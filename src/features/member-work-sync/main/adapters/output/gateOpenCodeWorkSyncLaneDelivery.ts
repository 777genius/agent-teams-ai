import {
  consumeOpenCodeWorkSyncLane,
  hasOpenCodeWorkSyncLaneReservation,
  hydrateOpenCodeWorkSyncLaneReservation,
  peekOpenCodeWorkSyncLane,
  restoreOpenCodeWorkSyncLane,
} from './OpenCodeWorkSyncLaneReservationStore';

export async function gateOpenCodeWorkSyncLaneDelivery(input: {
  teamName: string;
  memberName: string;
  messageId?: string;
  messageKind?: string;
  workSyncRuntimeTicketId?: string;
  foreground?: boolean;
}): Promise<{
  restore: () => void;
  reason?: 'work_sync_lane_reserved' | 'work_sync_ticket_stale';
}> {
  await hydrateOpenCodeWorkSyncLaneReservation(input);
  const reservedTicket = peekOpenCodeWorkSyncLane(input);
  const ticketId = input.workSyncRuntimeTicketId?.trim();
  const isNudge = input.messageKind === 'member_work_sync_nudge';
  if (isNudge && ticketId && (!reservedTicket || reservedTicket.ticketId !== ticketId)) {
    return { restore: () => undefined, reason: 'work_sync_ticket_stale' };
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
  if (ticketId) {
    if (consumedLane !== 'consumed') {
      restore();
      return { restore: () => undefined, reason: 'work_sync_ticket_stale' };
    }
    return { restore };
  }
  if (consumedLane === 'absent' && hasOpenCodeWorkSyncLaneReservation(input)) {
    return { restore, reason: 'work_sync_lane_reserved' };
  }
  return { restore };
}
