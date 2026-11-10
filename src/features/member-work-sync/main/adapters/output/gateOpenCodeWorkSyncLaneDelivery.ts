import {
  consumeOpenCodeWorkSyncLane,
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

function isAutomaticWorkSyncNudge(input: { messageKind?: string; foreground?: boolean }): boolean {
  return input.messageKind === 'member_work_sync_nudge' && input.foreground !== true;
}

export interface OpenCodeWorkSyncLaneDeliveryGateInput {
  teamName: string;
  memberName: string;
  messageId?: string;
  messageKind?: string;
  workSyncRuntimeTicketId?: string;
  workSyncControlRevision?: number;
  foreground?: boolean;
  source?: string;
}

export function buildOpenCodeWorkSyncLaneDeliveryGateInput(input: {
  teamName: string;
  memberName: string;
  messageId?: string;
  messageKind?: string;
  workSyncRuntimeTicketId?: string;
  workSyncControlRevision?: number;
  source?: string;
}): OpenCodeWorkSyncLaneDeliveryGateInput {
  return {
    teamName: input.teamName,
    memberName: input.memberName,
    messageId: input.messageId,
    messageKind: input.messageKind,
    workSyncRuntimeTicketId: input.workSyncRuntimeTicketId,
    workSyncControlRevision: input.workSyncControlRevision,
    foreground: input.source === 'ui-send' || input.source === 'manual',
  };
}

function isStaleOpenCodeWorkSyncEnvelopeRevision(
  envelopeRevision: number | undefined,
  live: { controlRevision: number } | null | undefined
): boolean {
  if (!live) {
    return false;
  }
  return envelopeRevision == null || envelopeRevision < live.controlRevision;
}

export async function gateOpenCodeWorkSyncLaneDelivery(
  input: OpenCodeWorkSyncLaneDeliveryGateInput
): Promise<OpenCodeWorkSyncLaneDeliveryGate> {
  await hydrateOpenCodeWorkSyncLaneReservation(input);
  const control = readOpenCodeWorkSyncLaneControl(input);
  const reservedTicket = peekOpenCodeWorkSyncLane(input);
  const ticketId = input.workSyncRuntimeTicketId?.trim();
  const isNudge = input.messageKind === 'member_work_sync_nudge';
  const automaticNudge = isAutomaticWorkSyncNudge(input);
  if (control?.stopped && automaticNudge) {
    if (ticketId && !reservedTicket) {
      return { restore: () => undefined, reason: 'work_sync_ticket_consumed' };
    }
    return { restore: () => undefined, reason: 'work_sync_admission_stopped' };
  }
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
  if (automaticNudge) {
    if (reservedTicket) {
      return { restore: () => undefined, reason: 'work_sync_lane_reserved' };
    }
    if (isStaleOpenCodeWorkSyncEnvelopeRevision(input.workSyncControlRevision, control)) {
      return { restore: () => undefined, reason: 'work_sync_ticket_stale' };
    }
    return {
      restore: () => undefined,
      consumeForSend: () => {
        const live = readOpenCodeWorkSyncLaneControl(input);
        if (live?.stopped) {
          return { reason: 'work_sync_admission_stopped' };
        }
        if (isStaleOpenCodeWorkSyncEnvelopeRevision(input.workSyncControlRevision, live)) {
          return { reason: 'work_sync_ticket_stale' };
        }
        if (peekOpenCodeWorkSyncLane(input)) {
          return { reason: 'work_sync_lane_reserved' };
        }
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
  return { restore };
}

export function consumeOpenCodeWorkSyncLaneForSend(
  lane: OpenCodeWorkSyncLaneDeliveryGate,
  input: { messageKind?: string; workSyncRuntimeTicketId?: string }
): { reason?: OpenCodeWorkSyncLaneDeliveryReason } {
  if (input.messageKind !== 'member_work_sync_nudge') {
    return {};
  }
  if (lane.reason === 'work_sync_ticket_consumed') {
    return { reason: 'work_sync_ticket_consumed' };
  }
  if (
    lane.reason === 'work_sync_admission_stopped' ||
    lane.reason === 'work_sync_lane_reserved' ||
    lane.reason === 'work_sync_ticket_stale'
  ) {
    return { reason: lane.reason };
  }
  if (!lane.consumeForSend) {
    return { reason: 'work_sync_ticket_stale' };
  }
  return lane.consumeForSend();
}
