import {
  reconcileRosterAdmissionIndexUnderLock,
  rosterAdmissionIndexFor,
} from './reconcileRosterAdmissionIndex';
import { toRosterAuthorizationOutcome } from './rosterAuthorizationOutcome';
import { decodeAuthorizedRoster } from './rosterAuthorizationRecordValidation';

import type {
  RosterAuthorizationTransactionRecord,
  TeamRosterAuthorizationLedger,
} from './TeamRosterAuthorizationLedger';
import type { RosterAuthorizationTransactionOutcome } from '@shared/types';

export { reconcileRosterAdmissionIndexUnderLock } from './reconcileRosterAdmissionIndex';

const TERMINAL_STATUSES = new Set(['committed', 'rolled-back', 'conflict']);

type ResolveRecord = (
  record: RosterAuthorizationTransactionRecord
) => Promise<RosterAuthorizationTransactionRecord>;

function isTerminal(record: RosterAuthorizationTransactionRecord): boolean {
  return TERMINAL_STATUSES.has(record.status);
}

export async function reserveRosterAdmissionIndexUnderLock(
  ledger: TeamRosterAuthorizationLedger,
  teamName: string,
  record: RosterAuthorizationTransactionRecord
): Promise<void> {
  const active = await reconcileRosterAdmissionIndexUnderLock(ledger, teamName);
  if (active && active.transactionId !== record.transactionId) {
    throw new Error(
      `Roster authorization is busy with recoverable transaction ${active.transactionId}; its lease and ownership must be reconciled before another begin`
    );
  }
  await ledger.writeAdmissionIndex(rosterAdmissionIndexFor(record), teamName);
}

export async function reconcileExactRosterAdmissionUnderLock(
  ledger: TeamRosterAuthorizationLedger,
  teamName: string,
  admissionRequestFingerprint: string,
  resolveRecord: ResolveRecord
): Promise<RosterAuthorizationTransactionOutcome | null> {
  const record = await reconcileRosterAdmissionIndexUnderLock(ledger, teamName);
  if (!record || record.admissionRequestFingerprint !== admissionRequestFingerprint) return null;
  const resolved = await resolveRecord(record);
  if (isTerminal(resolved)) {
    await ledger.clearAdmissionIndexIfMatches(teamName, resolved.transactionId);
    return null;
  }
  return toRosterAuthorizationOutcome(
    resolved.transactionId,
    resolved.status,
    resolved,
    undefined,
    decodeAuthorizedRoster(resolved)
  );
}

export async function rejectCompetingRosterReservationsUnderLock(
  ledger: TeamRosterAuthorizationLedger,
  teamName: string,
  transactionId: string
): Promise<void> {
  const active = await reconcileRosterAdmissionIndexUnderLock(ledger, teamName);
  if (!active || active.transactionId === transactionId) return;
  throw new Error(
    `Roster authorization is busy with recoverable transaction ${active.transactionId}; its lease and ownership must be reconciled before another begin`
  );
}
