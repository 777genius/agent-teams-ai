import { readFile } from 'fs/promises';
import { join } from 'path';

import { buildNativeWorkSyncAdmissionRoot } from './NativeMailboxMemberWorkSyncRuntimeTicketAdmission';

import type {
  MemberWorkSyncBusySignalPort,
  MemberWorkSyncRuntimeTicket,
} from '../../../core/application';

type NativeAdmissionSnapshot = {
  runtimeInstanceId?: string;
  status?: 'idle' | 'dispatching' | 'running';
  generation?: number;
  continuation?: {
    runtimeInstanceId?: string;
    reservationNonce?: string;
    intentId?: string;
    expectedGeneration?: number;
  } | null;
};

function matchesExactTicket(
  snapshot: NativeAdmissionSnapshot,
  ticket: MemberWorkSyncRuntimeTicket
): boolean {
  const continuation = snapshot.continuation;
  if (!continuation) {
    return false;
  }
  return (
    continuation.reservationNonce === ticket.ticketId &&
    continuation.intentId === ticket.intentId &&
    continuation.runtimeInstanceId === ticket.runtimeInstanceId &&
    (continuation.expectedGeneration == null ||
      continuation.expectedGeneration === ticket.expectedGeneration)
  );
}

export function createNativeMailboxMemberWorkSyncBusySignal(input: {
  teamsBasePath: string;
}): MemberWorkSyncBusySignalPort {
  return {
    async isBusy(request) {
      const root = buildNativeWorkSyncAdmissionRoot({
        teamsBasePath: input.teamsBasePath,
        teamName: request.teamName,
        memberName: request.memberName,
      });
      const capabilityPath = join(root, 'capability.json');
      try {
        await readFile(capabilityPath, 'utf8');
      } catch {
        return { busy: false };
      }
      if (request.exactRuntimeTicket) {
        try {
          const snapshot = JSON.parse(
            await readFile(join(root, 'snapshot.json'), 'utf8')
          ) as NativeAdmissionSnapshot;
          if (matchesExactTicket(snapshot, request.exactRuntimeTicket)) {
            return { busy: false };
          }
          if (snapshot.status === 'running') {
            return { busy: true, reason: 'query_running' };
          }
          if (snapshot.status === 'dispatching' && snapshot.continuation) {
            return { busy: true, reason: 'foreign_reservation' };
          }
        } catch {
          return { busy: false };
        }
        return { busy: false };
      }
      try {
        const snapshot = JSON.parse(
          await readFile(join(root, 'snapshot.json'), 'utf8')
        ) as NativeAdmissionSnapshot;
        if (snapshot.status === 'running') {
          return { busy: true, reason: 'query_running' };
        }
        if (snapshot.status === 'dispatching') {
          return { busy: true, reason: 'foreign_reservation' };
        }
        return { busy: false };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return { busy: false };
        }
        return { busy: true, reason: 'unknown' };
      }
    },
  };
}
