import { toRosterAuthorizationOutcome } from './rosterAuthorizationOutcome';

import type { RosterAuthorizationTransactionRecord } from './TeamRosterAuthorizationLedger';
import type {
  AuthoritativeModelExecutionProof,
  RosterAuthorizationTransactionOutcome,
  RosterAuthorizedLaunchBinding,
  TeamMember,
} from '@shared/types';

export interface RosterAuthorizationPrepareBindingInput {
  launchCommandId: string;
  executionProof?: AuthoritativeModelExecutionProof;
  launchRequestFingerprint?: string;
}

export type DurablePreparedRosterLaunchBinding = RosterAuthorizedLaunchBinding & {
  executionProof: AuthoritativeModelExecutionProof;
  launchRequestFingerprint: string;
};

export type RosterAuthorizationPrepareOutcome = RosterAuthorizationTransactionOutcome & {
  launchBinding?: DurablePreparedRosterLaunchBinding;
};

const IMMUTABLE_BINDING_CONFLICT =
  'Transaction ID is already prepared for a different immutable launch binding';

function hasSameExecutionProof(
  left: AuthoritativeModelExecutionProof | undefined,
  right: AuthoritativeModelExecutionProof | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.authorityId === right.authorityId &&
    left.generation === right.generation &&
    left.completedAt === right.completedAt &&
    left.expiresAt === right.expiresAt &&
    left.requestDigest === right.requestDigest
  );
}

/** A durable prepare may be replayed only with its exact immutable launch binding. */
export function hasExactPreparedLaunchBinding(
  record: Readonly<RosterAuthorizationTransactionRecord>,
  input: Readonly<RosterAuthorizationPrepareBindingInput>
): boolean {
  return (
    record.launchCommandId === input.launchCommandId &&
    hasSameExecutionProof(record.executionProof, input.executionProof) &&
    record.launchRequestFingerprint === input.launchRequestFingerprint
  );
}

function durableLaunchBinding(
  record: Readonly<RosterAuthorizationTransactionRecord>
): DurablePreparedRosterLaunchBinding | undefined {
  if (
    record.launchCommandId === undefined ||
    record.executionProof === undefined ||
    record.launchRequestFingerprint === undefined
  ) {
    return undefined;
  }
  return {
    transactionId: record.transactionId,
    teamName: record.teamName,
    rosterFingerprint: record.targetFingerprint,
    rosterRevision: record.requestFingerprint,
    launchCommandId: record.launchCommandId,
    executionProof: record.executionProof,
    launchRequestFingerprint: record.launchRequestFingerprint,
  };
}

export function toRosterAuthorizationPrepareOutcome(
  record: RosterAuthorizationTransactionRecord,
  authorizedRoster: TeamMember[]
): RosterAuthorizationPrepareOutcome {
  const outcome = toRosterAuthorizationOutcome(
    record.transactionId,
    'prepared',
    record,
    undefined,
    authorizedRoster
  );
  const launchBinding = durableLaunchBinding(record);
  return launchBinding ? { ...outcome, launchBinding } : outcome;
}

export function toPreparedLaunchBindingConflict(
  record: RosterAuthorizationTransactionRecord
): RosterAuthorizationTransactionOutcome {
  return toRosterAuthorizationOutcome(
    record.transactionId,
    'conflict',
    record,
    IMMUTABLE_BINDING_CONFLICT
  );
}
