import type { MemberWorkSyncRuntimeTicket } from '../../../core/application';

const reservations = new Map<string, MemberWorkSyncRuntimeTicket>();

function keyOf(teamName: string, memberName: string): string {
  return `${teamName.trim().toLowerCase()}::${memberName.trim().toLowerCase()}`;
}

export function reserveOpenCodeWorkSyncLane(
  ticket: MemberWorkSyncRuntimeTicket
): { ok: true } | { ok: false; code: 'busy' } {
  const key = keyOf(ticket.teamName, ticket.memberName);
  const existing = reservations.get(key);
  if (existing && existing.intentId !== ticket.intentId) {
    return { ok: false, code: 'busy' };
  }
  reservations.set(key, ticket);
  return { ok: true };
}

export function cancelOpenCodeWorkSyncLane(ticket: MemberWorkSyncRuntimeTicket): void {
  const key = keyOf(ticket.teamName, ticket.memberName);
  const existing = reservations.get(key);
  if (existing && existing.ticketId === ticket.ticketId) {
    reservations.delete(key);
  }
}

export function consumeOpenCodeWorkSyncLane(input: {
  teamName: string;
  memberName: string;
  messageId?: string;
  foreground?: boolean;
}): 'consumed' | 'user_wins' | 'absent' {
  const key = keyOf(input.teamName, input.memberName);
  const existing = reservations.get(key);
  if (!existing) {
    return 'absent';
  }
  if (input.foreground && input.messageId !== existing.intentId) {
    reservations.delete(key);
    return 'user_wins';
  }
  if (input.messageId && input.messageId === existing.intentId) {
    reservations.delete(key);
    return 'consumed';
  }
  return 'absent';
}

export function hasOpenCodeWorkSyncLaneReservation(input: {
  teamName: string;
  memberName: string;
}): boolean {
  return reservations.has(keyOf(input.teamName, input.memberName));
}

export function resetOpenCodeWorkSyncLaneReservationsForTests(): void {
  reservations.clear();
}
