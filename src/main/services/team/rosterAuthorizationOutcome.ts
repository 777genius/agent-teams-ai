import type { RosterAuthorizationTransactionRecord } from './TeamRosterAuthorizationLedger';
import type {
  RosterAuthorizationTransactionOutcome,
  RosterAuthorizationTransactionStatus,
  TeamMember,
} from '@shared/types';

export type DurableUnknownLaunchEvidence =
  | { state: 'unknown' }
  | { state: 'not-started'; message?: string }
  | { state: 'started'; result: import('@shared/types').RosterAuthorizedLaunchResult };

export function buildTerminalRosterAuthorizationRecord(
  record: RosterAuthorizationTransactionRecord,
  status: Extract<RosterAuthorizationTransactionStatus, 'committed' | 'rolled-back' | 'conflict'>,
  updatedAt: string,
  message?: string
): RosterAuthorizationTransactionRecord {
  const { priorRawBase64: _discarded, targetRawBase64: _discardedTarget, ...diagnostic } = record;
  return {
    ...diagnostic,
    status,
    ...(message ? { message } : {}),
    updatedAt,
  };
}

export function toRosterAuthorizationOutcome(
  transactionId: string,
  status: RosterAuthorizationTransactionStatus,
  record?: RosterAuthorizationTransactionRecord,
  message?: string,
  authorizedRoster?: TeamMember[]
): RosterAuthorizationTransactionOutcome {
  return {
    transactionId,
    status,
    ...(record?.priorSnapshotFingerprint
      ? { priorSnapshotFingerprint: record.priorSnapshotFingerprint }
      : {}),
    ...(record?.targetFingerprint
      ? {
          targetFingerprint: record.targetFingerprint,
          appliedFingerprint: record.targetFingerprint,
        }
      : {}),
    ...(record?.requestFingerprint ? { rosterRevision: record.requestFingerprint } : {}),
    ...(record?.launchCommandId ? { launchCommandId: record.launchCommandId } : {}),
    ...(record?.launchRunId ? { launchRunId: record.launchRunId } : {}),
    ...(authorizedRoster ? { authorizedRoster } : {}),
    ...((message ?? record?.message) ? { message: message ?? record?.message } : {}),
  };
}
