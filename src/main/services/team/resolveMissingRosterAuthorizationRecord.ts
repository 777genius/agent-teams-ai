import { toRosterAuthorizationOutcome as toOutcome } from './rosterAuthorizationOutcome';

import type { TeamRosterAuthorizationLedger } from './TeamRosterAuthorizationLedger';
import type { RosterAuthorizationTransactionOutcome } from '@shared/types';

/**
 * Resolves record absence without treating absence itself as no-dispatch proof.
 * The command ID is the transaction ID for the desktop roster launch protocol,
 * so reading that exact path also binds the terminal marker to the caller's
 * expected command identity.
 */
export async function resolveMissingRosterRecord(
  ledger: TeamRosterAuthorizationLedger,
  teamName: string,
  transactionId: string
): Promise<RosterAuthorizationTransactionOutcome> {
  const command = await ledger.readLaunchCommand(teamName, transactionId);
  const result = command?.result;
  if (
    command?.state !== 'not-started' ||
    command.teamName !== teamName ||
    command.transactionId !== transactionId ||
    command.launchCommandId !== transactionId ||
    command.rosterFingerprint.length === 0 ||
    command.rosterRevision.length === 0 ||
    !command.launchRequestFingerprint ||
    (result !== undefined &&
      (result.launchStatus !== 'not_started' ||
        result.teamName !== teamName ||
        result.transactionId !== transactionId ||
        result.launchCommandId !== command.launchCommandId ||
        result.rosterFingerprint !== command.rosterFingerprint ||
        result.rosterRevision !== command.rosterRevision ||
        result.launchRequestFingerprint !== command.launchRequestFingerprint))
  ) {
    return toOutcome(
      transactionId,
      'unknown',
      undefined,
      'Transaction record is absent without exact durable no-dispatch proof'
    );
  }
  return {
    transactionId,
    status: 'not-started',
    targetFingerprint: command.rosterFingerprint,
    appliedFingerprint: command.rosterFingerprint,
    rosterRevision: command.rosterRevision,
    launchCommandId: command.launchCommandId,
    ...(command.message ? { message: command.message } : {}),
  };
}
