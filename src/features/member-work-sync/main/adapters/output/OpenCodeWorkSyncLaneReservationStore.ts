import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { MemberWorkSyncRuntimeTicket } from '../../../core/application';

const reservations = new Map<string, MemberWorkSyncRuntimeTicket>();
let reservationRoot: string | null = null;

function keyOf(teamName: string, memberName: string): string {
  return `${teamName.trim().toLowerCase()}::${memberName.trim().toLowerCase()}`;
}

function reservationPath(teamName: string, memberName: string): string | null {
  if (!reservationRoot) {
    return null;
  }
  return join(
    reservationRoot,
    teamName,
    'members',
    encodeTeamMemberStorageKey(memberName),
    '.member-work-sync',
    'opencode-lane-reservation.json'
  );
}

export function bindOpenCodeWorkSyncLaneReservationRoot(root: string | null): void {
  reservationRoot = root;
}

function persistReservation(
  ticket: MemberWorkSyncRuntimeTicket | null,
  teamName: string,
  memberName: string
): void {
  const path = reservationPath(teamName, memberName);
  if (!path) {
    return;
  }
  if (!ticket) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ticket)}\n`, 'utf8');
}

function hydrateReservation(
  teamName: string,
  memberName: string
): MemberWorkSyncRuntimeTicket | undefined {
  const key = keyOf(teamName, memberName);
  const existing = reservations.get(key);
  if (existing) {
    return existing;
  }
  const path = reservationPath(teamName, memberName);
  if (!path) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as MemberWorkSyncRuntimeTicket;
    if (
      typeof parsed?.ticketId !== 'string' ||
      typeof parsed.intentId !== 'string' ||
      typeof parsed.runtimeInstanceId !== 'string'
    ) {
      return undefined;
    }
    reservations.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

export function reserveOpenCodeWorkSyncLane(
  ticket: MemberWorkSyncRuntimeTicket
): { ok: true } | { ok: false; code: 'busy' } {
  const existing = hydrateReservation(ticket.teamName, ticket.memberName);
  if (existing && existing.intentId !== ticket.intentId) {
    return { ok: false, code: 'busy' };
  }
  reservations.set(keyOf(ticket.teamName, ticket.memberName), ticket);
  persistReservation(ticket, ticket.teamName, ticket.memberName);
  return { ok: true };
}

export function cancelOpenCodeWorkSyncLane(ticket: MemberWorkSyncRuntimeTicket): void {
  const key = keyOf(ticket.teamName, ticket.memberName);
  const existing = reservations.get(key);
  if (existing && existing.ticketId === ticket.ticketId) {
    reservations.delete(key);
    persistReservation(null, ticket.teamName, ticket.memberName);
  }
}

export function restoreOpenCodeWorkSyncLane(ticket: MemberWorkSyncRuntimeTicket): void {
  reservations.set(keyOf(ticket.teamName, ticket.memberName), ticket);
  persistReservation(ticket, ticket.teamName, ticket.memberName);
}

export function peekOpenCodeWorkSyncLane(input: {
  teamName: string;
  memberName: string;
}): MemberWorkSyncRuntimeTicket | undefined {
  return hydrateReservation(input.teamName, input.memberName);
}

export function consumeOpenCodeWorkSyncLane(input: {
  teamName: string;
  memberName: string;
  messageId?: string;
  foreground?: boolean;
}): 'consumed' | 'user_wins' | 'absent' {
  const existing = hydrateReservation(input.teamName, input.memberName);
  if (!existing) {
    return 'absent';
  }
  const key = keyOf(input.teamName, input.memberName);
  if (input.foreground && input.messageId !== existing.intentId) {
    reservations.delete(key);
    persistReservation(null, input.teamName, input.memberName);
    return 'user_wins';
  }
  if (input.messageId && input.messageId === existing.intentId) {
    reservations.delete(key);
    persistReservation(null, input.teamName, input.memberName);
    return 'consumed';
  }
  return 'absent';
}

export function inspectOpenCodeWorkSyncLane(input: {
  teamName: string;
  memberName: string;
  messageId?: string;
  foreground?: boolean;
}): 'match' | 'foreign' | 'user_wins' | 'absent' {
  const existing = hydrateReservation(input.teamName, input.memberName);
  if (!existing) {
    return 'absent';
  }
  if (input.foreground && input.messageId !== existing.intentId) {
    return 'user_wins';
  }
  if (input.messageId && input.messageId === existing.intentId) {
    return 'match';
  }
  return 'foreign';
}

export function hasOpenCodeWorkSyncLaneReservation(input: {
  teamName: string;
  memberName: string;
}): boolean {
  return Boolean(hydrateReservation(input.teamName, input.memberName));
}

export async function hydrateOpenCodeWorkSyncLaneReservation(input: {
  teamName: string;
  memberName: string;
}): Promise<boolean> {
  return Boolean(await hydrateReservation(input.teamName, input.memberName));
}

export function resetOpenCodeWorkSyncLaneReservationsForTests(): void {
  reservations.clear();
  reservationRoot = null;
}
