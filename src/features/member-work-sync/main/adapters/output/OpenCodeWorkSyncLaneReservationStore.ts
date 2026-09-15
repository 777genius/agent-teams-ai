import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';
import { withFileLockSync } from '@main/services/team/fileLock';
import { atomicWriteSync } from '@main/utils/atomicWrite';
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
  return Boolean(hydrateReservation(input.teamName, input.memberName));
}

export function resetOpenCodeWorkSyncLaneReservationsForTests(): void {
  reservations.clear();
  reservationRoot = null;
}

export interface OpenCodeWorkSyncLaneControl {
  runtimeInstanceId: string;
  controlRevision: number;
  stopped: boolean;
  handshakeCompleted: boolean;
  requestId?: string;
}

function controlPath(teamName: string, memberName: string): string | null {
  if (!reservationRoot) {
    return null;
  }
  return join(
    reservationRoot,
    teamName,
    'members',
    encodeTeamMemberStorageKey(memberName),
    '.member-work-sync',
    'opencode-lane-control.json'
  );
}

export function applyOpenCodeWorkSyncLaneControl(input: {
  teamName: string;
  memberName: string;
  runtimeInstanceId: string;
  controlRevision: number;
  stopped: boolean;
  requestId?: string;
}):
  | { ok: true; code: 'closed' | 'open'; controlRevision: number; requestId?: string }
  | { ok: false; code: 'superseded' | 'conflict' } {
  const path = controlPath(input.teamName, input.memberName);
  if (!path) return { ok: false, code: 'conflict' };
  return withFileLockSync(
    path,
    () => {
      const current = readOpenCodeWorkSyncLaneControlState(path);
      if (current.state === 'corrupt') return { ok: false as const, code: 'conflict' as const };
      const existing = current.state === 'present' ? current.control : null;
      if (existing && existing.runtimeInstanceId === input.runtimeInstanceId) {
        if (input.controlRevision < existing.controlRevision) {
          return { ok: false as const, code: 'superseded' as const };
        }
        if (
          input.controlRevision === existing.controlRevision &&
          (input.stopped !== existing.stopped ||
            (input.requestId !== undefined && input.requestId !== existing.requestId))
        ) {
          return { ok: false as const, code: 'conflict' as const };
        }
      }
      const requestId =
        input.requestId ??
        (existing?.runtimeInstanceId === input.runtimeInstanceId &&
        existing.controlRevision === input.controlRevision
          ? existing.requestId
          : undefined);
      writeOpenCodeWorkSyncLaneControl({
        teamName: input.teamName,
        memberName: input.memberName,
        control: {
          runtimeInstanceId: input.runtimeInstanceId,
          controlRevision: input.controlRevision,
          stopped: input.stopped,
          handshakeCompleted: true,
          ...(requestId ? { requestId } : {}),
        },
      });
      if (input.stopped) {
        const reserved = peekOpenCodeWorkSyncLane({
          teamName: input.teamName,
          memberName: input.memberName,
        });
        if (reserved) cancelOpenCodeWorkSyncLane(reserved);
      }
      return {
        ok: true as const,
        code: input.stopped ? ('closed' as const) : ('open' as const),
        controlRevision: input.controlRevision,
        ...(requestId ? { requestId } : {}),
      };
    },
    { preventLiveOwnerTakeover: true }
  );
}

export function writeOpenCodeWorkSyncLaneControl(input: {
  teamName: string;
  memberName: string;
  control: OpenCodeWorkSyncLaneControl;
}): void {
  const path = controlPath(input.teamName, input.memberName);
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteSync(path, `${JSON.stringify(input.control)}\n`);
}

type OpenCodeControlRead =
  | { state: 'absent' }
  | { state: 'corrupt' }
  | { state: 'present'; control: OpenCodeWorkSyncLaneControl };

function readOpenCodeWorkSyncLaneControlState(path: string): OpenCodeControlRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'corrupt' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'corrupt' };
  const control = parsed as Record<string, unknown>;
  if (
    typeof control.runtimeInstanceId !== 'string' ||
    !control.runtimeInstanceId.trim() ||
    !Number.isSafeInteger(control.controlRevision) ||
    (control.controlRevision as number) <= 0 ||
    typeof control.stopped !== 'boolean' ||
    control.handshakeCompleted !== true ||
    (control.requestId !== undefined &&
      (typeof control.requestId !== 'string' ||
        !control.requestId.trim() ||
        control.requestId.length > 256 ||
        control.requestId.trim() !== control.requestId))
  ) {
    return { state: 'corrupt' };
  }
  return { state: 'present', control: control as unknown as OpenCodeWorkSyncLaneControl };
}

export function readOpenCodeWorkSyncLaneControl(input: {
  teamName: string;
  memberName: string;
}): OpenCodeWorkSyncLaneControl | null {
  const path = controlPath(input.teamName, input.memberName);
  if (!path) {
    return null;
  }
  const result = readOpenCodeWorkSyncLaneControlState(path);
  return result.state === 'present' ? result.control : null;
}
