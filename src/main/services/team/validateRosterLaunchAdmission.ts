import type { RosterAuthorizationTransactionRecord } from './TeamRosterAuthorizationLedger';

const TERMINAL = new Set(['committed', 'rolled-back', 'conflict']);

export async function validateRosterLaunchAdmission(input: {
  teamName: string;
  transactionId: string;
  launchRequestFingerprint: string;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  readAdmittedRecord(teamName: string): Promise<RosterAuthorizationTransactionRecord | null>;
}): Promise<boolean> {
  try {
    return await input.withLock(async () => {
      const record = await input.readAdmittedRecord(input.teamName);
      return (
        record !== null &&
        record.transactionId === input.transactionId &&
        !TERMINAL.has(record.status) &&
        (record.admissionRequestFingerprint === undefined ||
          record.admissionRequestFingerprint === input.launchRequestFingerprint)
      );
    });
  } catch {
    return false;
  }
}
