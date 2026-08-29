import type {
  RosterAuthorizationAdmissionIndex,
  RosterAuthorizationTransactionRecord,
  TeamRosterAuthorizationLedger,
} from './TeamRosterAuthorizationLedger';

const TERMINAL_STATUSES = new Set(['committed', 'rolled-back', 'conflict']);
const MAX_LEGACY_INDEX_RECORDS = 64;

function isTerminal(record: RosterAuthorizationTransactionRecord): boolean {
  return TERMINAL_STATUSES.has(record.status);
}

export function rosterAdmissionIndexFor(
  record: RosterAuthorizationTransactionRecord
): RosterAuthorizationAdmissionIndex {
  return {
    version: 1,
    active: {
      transactionId: record.transactionId,
      requestFingerprint: record.requestFingerprint,
      ...(record.admissionRequestFingerprint
        ? { admissionRequestFingerprint: record.admissionRequestFingerprint }
        : {}),
    },
  };
}

async function migrateBoundedLegacyIndexUnderLock(
  ledger: TeamRosterAuthorizationLedger,
  teamName: string
): Promise<RosterAuthorizationAdmissionIndex> {
  const ids = await ledger.listRecordIds(teamName, MAX_LEGACY_INDEX_RECORDS + 1);
  if (ids.length > MAX_LEGACY_INDEX_RECORDS) {
    throw new Error(
      'Roster authorization ledger is too large for bounded legacy index migration; admission is fail-closed'
    );
  }
  let active: RosterAuthorizationTransactionRecord | null = null;
  for (const id of ids) {
    const record = await ledger.readRecord(teamName, id);
    if (!record || isTerminal(record)) continue;
    if (active) throw new Error('Roster authorization ledger has competing unindexed reservations');
    active = record;
  }
  const index = active ? rosterAdmissionIndexFor(active) : { version: 1 as const, active: null };
  await ledger.writeAdmissionIndex(index, teamName);
  return index;
}

/**
 * Repairs publication states that cannot prove an active reservation. Callers
 * must hold the roster lock so a cleared dangling pointer cannot race a writer.
 */
export async function reconcileRosterAdmissionIndexUnderLock(
  ledger: TeamRosterAuthorizationLedger,
  teamName: string
): Promise<RosterAuthorizationTransactionRecord | null> {
  const index =
    (await ledger.readAdmissionIndex(teamName)) ??
    (await migrateBoundedLegacyIndexUnderLock(ledger, teamName));
  if (!index.active) return null;
  const record = await ledger.readRecord(teamName, index.active.transactionId);
  if (!record) {
    await ledger.clearAdmissionIndexIfMatches(teamName, index.active.transactionId);
    return null;
  }
  if (
    record.requestFingerprint !== index.active.requestFingerprint ||
    record.admissionRequestFingerprint !== index.active.admissionRequestFingerprint
  ) {
    throw new Error('Roster authorization admission index fingerprint does not match its target');
  }
  if (isTerminal(record)) {
    await ledger.clearAdmissionIndexIfMatches(teamName, record.transactionId);
    return null;
  }
  return record;
}
